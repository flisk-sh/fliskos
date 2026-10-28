import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { FLISK_APPS, appsForProject, githubRepo, originUrl } from "../src/apps.js";
import { startAppServer } from "../src/app.js";

const dirs = [];
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout(remote) {
  const root = mkdtempSync(join(tmpdir(), "fliskos-apps-"));
  dirs.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/fork.git\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return root;
}

describe("Flisk apps", () => {
  it("reads owner/repo from every usual GitHub remote form and nothing else", () => {
    assert.equal(githubRepo("https://github.com/flisk-sh/flisk.git"), "flisk-sh/flisk");
    assert.equal(githubRepo("https://github.com/flisk-sh/flisk"), "flisk-sh/flisk");
    assert.equal(githubRepo("https://token@github.com/flisk-sh/flisk.git"), "flisk-sh/flisk");
    assert.equal(githubRepo("git@github.com:flisk-sh/helpdock.git"), "flisk-sh/helpdock");
    assert.equal(githubRepo("ssh://git@github.com/flisk-sh/pages"), "flisk-sh/pages");
    assert.equal(githubRepo("https://gitlab.com/flisk-sh/flisk.git"), null);
    assert.equal(githubRepo("https://github.com/flisk-sh/flisk/tree/main"), null);
    assert.equal(githubRepo(null), null);
  });

  it("finds the origin remote of a checkout and of a git worktree", () => {
    const main = checkout("git@github.com:flisk-sh/citable.git");
    assert.equal(originUrl(main), "git@github.com:flisk-sh/citable.git");
    const worktree = mkdtempSync(join(tmpdir(), "fliskos-worktree-"));
    dirs.push(worktree);
    mkdirSync(join(main, ".git", "worktrees", "feature"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
    assert.equal(originUrl(worktree), "git@github.com:flisk-sh/citable.git");
    const plain = mkdtempSync(join(tmpdir(), "fliskos-plain-"));
    dirs.push(plain);
    assert.equal(originUrl(plain), null);
  });

  it("points each app at the project: its repo docs, its running frontends and a page prompt", () => {
    const root = checkout("https://github.com/flisk-sh/helpdock.git");
    const apps = appsForProject({ id: "p1", name: "helpdock", root }, [
      { name: "web", type: "frontend", url: "http://web.helpdock.localhost:8080" },
      { name: "api", type: "backend", url: "http://api.helpdock.localhost:8080" },
      { name: "admin", type: "frontend", url: null },
    ]);
    assert.deepEqual(apps.map((app) => app.id), FLISK_APPS.map((app) => app.id));
    const byId = Object.fromEntries(apps.map((app) => [app.id, app]));
    assert.deepEqual(byId.helpdock.actions, [
      { kind: "link", label: "Docs for flisk-sh/helpdock", href: "https://helpdock.flisk.sh/flisk-sh/helpdock" },
      { kind: "copy", label: "Copy MCP URL", value: "https://helpdock.flisk.sh/flisk-sh/helpdock/mcp" },
    ]);
    assert.deepEqual(byId.citable.actions, [{ kind: "copy", label: "Check web", value: "npx @flisk-sh/citable http://web.helpdock.localhost:8080" }]);
    assert.equal(byId.pages.actions[0].kind, "agent");
    assert.match(byId.pages.actions[0].prompt, /helpdock stack.*Do not publish it/);
    assert.equal(byId.helpdock.note, null);
  });

  it("explains what is missing for a project without a GitHub remote or a frontend, and offers only links without a project", () => {
    const root = mkdtempSync(join(tmpdir(), "fliskos-plain-"));
    dirs.push(root);
    const byId = Object.fromEntries(appsForProject({ id: "p2", name: "local", root }, []).map((app) => [app.id, app]));
    assert.deepEqual(byId.helpdock.actions, []);
    assert.match(byId.helpdock.note, /Push this project to GitHub/);
    assert.match(byId.citable.note, /Start a frontend/);
    const none = appsForProject(null);
    assert(none.every((app) => app.actions.length === 0 && app.note === null && app.url.startsWith("https://")));
  });

  it("serves the apps over the API and rejects an unknown project", async () => {
    const root = checkout("https://github.com/flisk-sh/pages.git");
    const project = { id: "project-pages", name: "pages", root };
    const { server } = await startAppServer({ projects: [project], port: 0, token: "test-session-token", dockerCheck: async () => true, probe: async () => ({ state: "supported", lifecycle: true }), runCommand: async () => ({ status: 1, stdout: "", stderr: "" }) });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
      const response = await fetch(`${base}${path}`, { headers: { "x-flisk-token": "test-session-token" } });
      return { status: response.status, body: await response.json() };
    };
    const listed = await get(`/api/apps?project=${project.id}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.apps.find((app) => app.id === "helpdock").actions[0].href, "https://helpdock.flisk.sh/flisk-sh/pages");
    assert.equal((await get("/api/apps")).body.apps.length, FLISK_APPS.length);
    assert.equal((await get("/api/apps?project=missing")).status, 400);
  });
});
