import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const headers = readFileSync(new URL("../website/public/_headers", import.meta.url), "utf8");

// Cloudflare _headers: a rule line names one or more paths; the indented lines after it are the headers.
function ruleFor(path) {
  const lines = headers.split(/\r?\n/);
  const i = lines.findIndex((line) => line.split(/\s+/).includes(path) && !line.startsWith(" "));
  assert.notEqual(i, -1, `no _headers rule for ${path}`);
  const block = [];
  for (const line of lines.slice(i + 1)) {
    if (!line.trim()) break;
    if (line.startsWith(" ")) block.push(line.trim());
  }
  return block.join("\n");
}

const maxAge = (block) => {
  const m = block.match(/Cache-Control:[^\r\n]*max-age=(\d+)/);
  assert.ok(m, `no max-age in ${block}`);
  return Number(m[1]);
};

describe("os.flisk.si static cache rules", () => {
  for (const path of ["/logo.svg", "/icon-192.png", "/apple-touch-icon.png"]) {
    it(`${path} is cached for at least a day`, () => {
      assert.ok(maxAge(ruleFor(path)) >= 86400, `${path} max-age too low`);
    });
  }

  it("site.css avoids a round trip on every view", () => {
    const block = ruleFor("/site.css");
    assert.ok(maxAge(block) > 0);
    assert.match(block, /stale-while-revalidate/);
  });

  it("does not disable ETags", () => {
    assert.doesNotMatch(headers, /ETag:\s*none/i);
  });
});
