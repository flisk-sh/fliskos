import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
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
				if (path === "download/mac") continue;
				assert.ok(existsSync(new URL(path, site)), `${page} links to missing /${path}`);
			}
		}
	});
});
