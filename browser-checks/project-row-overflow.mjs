import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startAppServer } from "../src/app.js";

const ERROR = "Could not find project.json for this workspace at /var/www/2025/ollamar1/example/.flisk/project.json (run flisk init first)";
const project = (name, id) => ({ id, name, root: `/var/www/2025/ollamar1/a/deeply/nested/folder/${name}` });
const resources = Array.from({ length: 37 }, (_, index) => ({ name: `service-${index}`, type: "backend", status: "ready" }));
const ports = [5432, 6379, 8081, 9000].flatMap((hostPort) => ["one", "two"].map((name) => ({ hostPort, name })));
const respond = (data) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });

let app;
let browser;
let scratch;

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "fliskos-overflow-"));
  app = await startAppServer({
    projects: [project("beauty-crm", "a"), project("example", "b"), project("an-extremely-long-project-name-that-keeps-going-and-going", "c")],
    probe: async () => ({ state: "supported", lifecycle: true, version: "1.4.0" }),
    runCommand: async (entry, args) => {
      if (args[0] === "status") return entry.name === "example" ? { status: 1, stdout: JSON.stringify({ errors: [{ message: ERROR }] }), stderr: "" } : respond({ resources, stacks: [], ports });
      return respond({ services: [], checks: [] });
    },
    dockerCheck: async () => true,
    claudeDesktopApp: () => null,
    statePath: join(scratch, "state.json"),
  });
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
});

after(async () => {
  await browser?.close();
  if (app) {
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
  }
  rmSync(scratch, { recursive: true, force: true });
});

for (const width of [1600, 1400, 1180, 900]) {
  test(`project row text stays clear of its buttons at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(app.url);
    await page.getByText("beauty-crm").first().waitFor();
    await page.locator(".row-error").first().waitFor();
    const clashes = await page.evaluate(() => [...document.querySelectorAll(".project-row")].flatMap((row) => {
      const buttons = row.querySelector(".row-actions").getBoundingClientRect();
      return [...row.querySelectorAll(".row-title, .status-label, .row-meta, .row-meta .badge")].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > buttons.left + 1 && box.bottom > buttons.top + 1 && box.top < buttons.bottom - 1;
      }).map((element) => element.textContent.trim().slice(0, 40));
    }));
    await page.close();
    assert.deepEqual(clashes, []);
  });
}
