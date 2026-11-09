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

	it("leaves every other /download path to the static files", async () => {
		const env = { ASSETS: { fetch: () => new Response("asset", { status: 404 }) } };
		const response = await worker.fetch(new Request("https://os.flisk.si/download/windows"), env);
		assert.equal(response.status, 404);
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
});
