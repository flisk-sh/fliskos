import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildDemo } from "../website/demo/build.mjs";
import * as workerModule from "../website/worker.js";

const worker = workerModule.default;
const MAC_ZIP = "https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-macOS.zip";
const site = new URL("../website/public/", import.meta.url);
const read = (path) => readFileSync(new URL(path, site), "utf8");

describe("website worker", () => {
	it("exports only its handler, because the Workers runtime rejects anything else", () => {
		assert.deepEqual(Object.keys(workerModule), ["default"]);
	});

	it("sends /download/mac to the latest release zip", async () => {
		const response = await worker.fetch(new Request("https://os.flisk.si/download/mac"), {});
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), MAC_ZIP);
	});

	it("sends /download/windows to the latest Windows zip", async () => {
		const response = await worker.fetch(new Request("https://os.flisk.si/download/windows"), {});
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), MAC_ZIP.replace("macOS", "windows"));
	});

	it("leaves every other /download path to the static files", async () => {
		const env = { ASSETS: { fetch: () => new Response("asset", { status: 404 }) } };
		const response = await worker.fetch(new Request("https://os.flisk.si/download/linux"), env);
		assert.equal(response.status, 404);
	});
});

describe("website security headers", () => {
	const BASELINE = {
		"x-content-type-options": "nosniff",
		"x-frame-options": "SAMEORIGIN",
		"strict-transport-security": "max-age=31536000; includeSubDomains",
		"referrer-policy": "strict-origin-when-cross-origin",
		"permissions-policy": "camera=(), microphone=(), geolocation=()",
	};
	const expectBaseline = (response) => {
		for (const [name, value] of Object.entries(BASELINE)) assert.equal(response.headers.get(name), value, name);
		assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors/);
	};

	it("are on the download redirects", async () => {
		expectBaseline(await worker.fetch(new Request("https://os.flisk.si/download/mac"), {}));
	});

	it("are on a 404 and on a normal response passed through from the assets", async () => {
		const env = { ASSETS: { fetch: (r) => (r.url.endsWith("/ok") ? new Response("hi") : new Response("nope", { status: 404 })) } };
		const ok = await worker.fetch(new Request("https://os.flisk.si/download/ok"), env);
		assert.equal(ok.status, 200);
		expectBaseline(ok);
		const missing = await worker.fetch(new Request("https://os.flisk.si/download/linux"), env);
		assert.equal(missing.status, 404);
		expectBaseline(missing);
	});

	it("keep a CSP and headers the response already has", async () => {
		const csp = "default-src 'none'; frame-ancestors 'none'";
		const env = { ASSETS: { fetch: () => new Response("x", { headers: { "content-security-policy": csp, "x-frame-options": "DENY" } }) } };
		const response = await worker.fetch(new Request("https://os.flisk.si/download/x"), env);
		assert.equal(response.headers.get("content-security-policy"), csp);
		assert.equal(response.headers.get("x-frame-options"), "DENY");
	});

	it("add frame-ancestors to a CSP that lacks it", async () => {
		const env = { ASSETS: { fetch: () => new Response("x", { headers: { "content-security-policy": "default-src 'self'" } }) } };
		const response = await worker.fetch(new Request("https://os.flisk.si/download/x"), env);
		assert.equal(response.headers.get("content-security-policy"), "default-src 'self'; frame-ancestors 'self'");
	});

	it("are in public/_headers for every static file, once each, with a CSP that has frame-ancestors", () => {
		const all = read("_headers").split(/\n(?=\S)/).find((block) => block.startsWith("/*")) ?? "";
		for (const [name, value] of Object.entries(BASELINE)) {
			const lines = all.split("\n").filter((l) => l.trim().toLowerCase().startsWith(`${name}:`));
			assert.equal(lines.length, 1, `${name} must be set exactly once under /*`);
			assert.equal(lines[0].slice(lines[0].indexOf(":") + 1).trim(), value);
		}
		assert.match(all, /Content-Security-Policy: .*frame-ancestors /);
	});

	it("still lets the embedded demo be framed by this site", () => {
		const demo = read("_headers").slice(read("_headers").indexOf("/demo/*"));
		assert.match(demo, /frame-ancestors 'self'/);
	});
});

describe("website demo", () => {
	it("publishes nothing from the machine that builds it", async () => {
		const out = mkdtempSync(join(tmpdir(), "fliskos-demo-test-"));
		try {
			await buildDemo(out);
			const data = readFileSync(join(out, "data.js"), "utf8");
			assert.ok(!data.includes(homedir()), "data.js has this machine's home folder");
			assert.ok(!data.includes(userInfo().username), "data.js has this machine's user name");
			assert.match(data, /acme-shop/);
			const page = readFileSync(join(out, "index.html"), "utf8");
			assert.ok(!page.includes("__FLISK_CENTER_TOKEN__"));
			assert.ok(page.indexOf("/demo/demo-api.js") < page.indexOf("/demo/app.js"), "the stand-in API has to load before the app");
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});
});

describe("website files", () => {
	it("installs the zip the release build produces", () => {
		const build = readFileSync(new URL("../macos/build.sh", import.meta.url), "utf8");
		assert.match(build, /FliskOS-macOS\.zip/);
		assert.ok(read("install.sh").includes(MAC_ZIP));
	});

	it("installs the zip the Windows build produces", () => {
		const build = readFileSync(new URL("../windows/build.ps1", import.meta.url), "utf8");
		assert.match(build, /FliskOS-windows\.zip/);
		assert.ok(read("install.ps1").includes(MAC_ZIP.replace("macOS", "windows")));
	});

	it("lets Flisk Analytics load from flisk.sh and send events to analytics.flisk.si", () => {
		const csp = read("_headers").match(/^\s*Content-Security-Policy: (.+)$/m)?.[1] ?? "";
		const directive = (name) => csp.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name) ?? [];
		assert.ok(directive("script-src").includes("https://flisk.sh"), "script-src must allow https://flisk.sh");
		assert.ok(directive("script-src").includes("https://flisk.si"), "script-src must keep https://flisk.si");
		assert.ok(directive("connect-src").includes("https://analytics.flisk.si"), "connect-src must allow https://analytics.flisk.si");
	});

	it("has an install script sh can parse", () => {
		execFileSync("sh", ["-n", new URL("install.sh", site).pathname]);
	});

	it("links only to files that exist", () => {
		for (const page of ["index.html", "404.html"]) {
			for (const [, path] of read(page).matchAll(/(?:src|poster|href)="\/([^"#]+)"/g)) {
				if (path === "download/mac" || path === "demo/") continue;
				assert.ok(existsSync(new URL(path, site)), `${page} links to missing /${path}`);
			}
		}
	});

	it("shares a 1200x630 PNG card as og:image and twitter:image", () => {
		const page = read("index.html");
		const og = page.match(/<meta property="og:image" content="https:\/\/os\.flisk\.si\/([^"]+)">/)?.[1];
		assert.ok(og, "index.html has no og:image on os.flisk.si");
		assert.match(og, /\.png$/);
		assert.ok(page.includes(`<meta name="twitter:image" content="https://os.flisk.si/${og}">`));
		assert.match(page, /<meta property="og:image:width" content="1200">/);
		assert.match(page, /<meta property="og:image:height" content="630">/);
		const png = readFileSync(new URL(og, site));
		assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${og} is not a PNG`);
		assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
		assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
	});
});

describe("website analytics", () => {
	const tag = '<script defer data-domain="os.flisk.si" src="https://flisk.sh/a.js"></script>';

	it("counts visits on both pages, once each, before the bar script", () => {
		for (const page of ["index.html", "404.html"]) {
			const html = read(page);
			assert.equal(html.split(tag).length, 2, `${page} should carry the analytics tag once`);
			assert.ok(html.indexOf(tag) < html.indexOf("https://flisk.si/assets/bar.js"), `${page}: tag comes before bar.js`);
		}
	});

	it("lets the site policy load the script and send the beacon, and nothing else", () => {
		const headers = read("_headers");
		const csp = headers.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:")) ?? "";
		assert.match(csp, /script-src [^;]*https:\/\/flisk\.sh/);
		assert.match(csp, /connect-src https:\/\/analytics\.flisk\.si;/);
		// the embedded demo keeps its own strict policy, with no analytics
		const demo = headers.slice(headers.indexOf("/demo/*"));
		assert.ok(!demo.includes("flisk.sh") && !demo.includes("analytics.flisk.si"));
	});
});
