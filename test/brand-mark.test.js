import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The canonical FliskOS mark is flisk-sh/flisk-emoji apps/fliskos.svg; website/public/logo.svg is the same file.
const logo = readFileSync(new URL("../website/public/logo.svg", import.meta.url), "utf8").trim();
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const shapes = (svg) => svg.match(/<(rect|path)\b[^>]*>/g).map((tag) => tag.replace(/\s*fill="url\(#[^)]+\)"/, ""));

describe("brand mark", () => {
	it("draws the FliskOS logo in the sidebar, not a letter tile", () => {
		const mark = html.match(/<span class="brand-mark">([\s\S]*?)<\/span>/)[1];
		assert.match(mark, /^<svg /);
		assert.deepEqual(shapes(mark), shapes(logo));
	});

	it("gives the brand mark no accent tile of its own, because the logo has its tile", () => {
		const rules = html.match(/[^{}]*\.brand-mark[^{}]*\{[^}]*\}/g).join("\n");
		assert.doesNotMatch(rules, /background|box-shadow|border-radius|font/);
	});

	it("uses the logo as the favicon", () => {
		const data = html.match(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,([^"]+)"/)[1];
		assert.equal(Buffer.from(data, "base64").toString("utf8").trim(), logo);
	});

	it("shows the logo, not a letter tile, on the macOS splash while the server starts", () => {
		const swift = readFileSync(new URL("../macos/main.swift", import.meta.url), "utf8");
		const splash = swift.match(/static func splash[\s\S]*?"""([\s\S]*?)"""/)[1].replace(/\\"/g, '"');
		const mark = splash.match(/<div class=m>([\s\S]*?)<\/div>/)[1];
		assert.match(mark, /^<svg /);
		assert.deepEqual(shapes(mark), shapes(logo));
	});

	it("uses the logo, not a letter, for the FliskOS empty states", () => {
		for (const file of ["app.js", "os.js"]) {
			const js = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
			assert.doesNotMatch(js, /class="empty-icon" aria-hidden="true">F</, file);
		}
	});
});
