import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const site = new URL("../website/public/", import.meta.url);
const read = (path) => readFileSync(new URL(path, site), "utf8");
const skip = '<a class="skip-link" href="#main">Skip to content</a>';

describe("website skip link", () => {
	for (const page of ["index.html", "404.html"]) {
		it(`${page} puts the skip link first in the body`, () => {
			const html = read(page);
			assert.match(html, /<body>\s*<a class="skip-link" href="#main">Skip to content<\/a>/);
			assert.ok(html.indexOf(skip) < html.indexOf("<main"), `${page} main target is after the skip link`);
		});

		it(`${page} has a main target for the skip link`, () => {
			assert.match(read(page), /<main id="main"/);
		});
	}

	it("is hidden until focused", () => {
		const css = read("site.css");
		assert.match(css, /\.skip-link\s*\{[^}]*left:\s*-9999px/);
		assert.match(css, /\.skip-link:focus\s*\{[^}]*left:\s*12px/);
	});
});
