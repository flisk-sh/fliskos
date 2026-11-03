import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  BOARD_URL,
  fetchBoardSessions,
  isSessionInsideProject,
  probeBoardHealth,
  startAppServer,
} from "../src/app.js";

const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectFixture(name) {
  const root = mkdtempSync(join(tmpdir(), "flisk-agents-test-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".flisk"), { recursive: true });
  writeFileSync(join(root, ".flisk", "project.json"), JSON.stringify({ project: { name } }));
  return { id: `proj-${name}`, name, root };
}

async function serverFor(options) {
  const started = await startAppServer({
    port: 0,
    token: "test-token",
    dockerCheck: async () => true,
    ...options,
  });
  servers.push(started.server);
  return started;
}

describe("isSessionInsideProject: path containment", () => {
  it("matches identical project root paths", () => {
    const dir = projectFixture("exact-match").root;
    assert.equal(isSessionInsideProject(dir, dir), true);
  });

  it("matches nested subdirectories inside project", () => {
    const dir = projectFixture("nested").root;
    const sub = join(dir, "services", "api");
    assert.equal(isSessionInsideProject(sub, dir), true);
  });

  it("rejects sibling directory with prefix collision", () => {
    const root = projectFixture("prefix").root;
    const sibling = `${root}-other`;
    assert.equal(isSessionInsideProject(sibling, root), false);
  });

  it("returns false for missing or null arguments", () => {
    assert.equal(isSessionInsideProject(null, "/some/path"), false);
    assert.equal(isSessionInsideProject("/some/path", null), false);
    assert.equal(isSessionInsideProject("", ""), false);
  });

  it("safely falls back to resolve() when cwd directory was deleted", () => {
    const root = projectFixture("deleted-worktree").root;
    const deletedCwd = join(root, "worktrees", "expired-task");
    // deletedCwd does not exist on disk, realpathSync throws ENOENT
    assert.equal(isSessionInsideProject(deletedCwd, root), true);
  });
});

describe("probeBoardHealth: health checks", () => {
  it("returns true when board answers 200 with service: board", async () => {
    const fakeFetch = async (url) => {
      assert.equal(url, `${BOARD_URL}/health`);
      return {
        ok: true,
        json: async () => ({ status: "ok", service: "board" }),
      };
    };
    const isUp = await probeBoardHealth(BOARD_URL, 500, fakeFetch);
    assert.equal(isUp, true);
  });

  it("returns false when service is not board", async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ status: "ok", service: "other-service" }),
    });
    const isUp = await probeBoardHealth(BOARD_URL, 500, fakeFetch);
    assert.equal(isUp, false);
  });

  it("returns false when response is non-200", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ status: "down" }),
    });
    const isUp = await probeBoardHealth(BOARD_URL, 500, fakeFetch);
    assert.equal(isUp, false);
  });

  it("returns false on network failure or abort timeout", async () => {
    const fakeFetch = async () => {
      throw new Error("fetch failed (ECONNREFUSED)");
    };
    const isUp = await probeBoardHealth(BOARD_URL, 500, fakeFetch);
    assert.equal(isUp, false);
  });
});

describe("fetchBoardSessions: session normalization", () => {
  it("reads and normalizes sessions, treating optional fields gracefully", async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({
        sessions: [
          {
            id: "session-1",
            agent: "claude",
            cwd: "/path/to/project",
            title: "Task title",
            status: "busy",
            role: "Code",
            face: { shape: "square", color: "blue" },
          },
          {
            id: "session-minimal",
            // missing optional fields
          },
          null, // invalid item
          "not an object",
        ],
        clashes: [],
        limits: {},
      }),
    });

    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0], {
      id: "session-1",
      agent: "claude",
      cwd: "/path/to/project",
      title: "Task title",
      status: "busy",
      role: "Code",
      face: { shape: "square", color: "blue" },
    });
    assert.equal(sessions[1].id, "session-minimal");
    assert.equal(sessions[1].agent, "unknown");
    assert.equal(sessions[1].title, "Untitled Session");
    assert.equal(sessions[1].status, "unknown");
  });

  it("returns empty array on network failure", async () => {
    const fakeFetch = async () => {
      throw new Error("Network error");
    };
    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.deepEqual(sessions, []);
  });
});

describe("HTTP server /api/agents/board endpoint", () => {
  it("reports state: not-running when board is down", async () => {
    const project = projectFixture("down-test");
    const fakeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const { server, token } = await serverFor({
      projects: [project],
      fetchImpl: fakeFetch,
    });

    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const res = await fetch(`${origin}/api/agents/board?project=${project.id}`, {
      headers: { "x-flisk-token": token, origin },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, "not-running");
    assert.equal(body.boardUrl, "http://localhost:4100");
    assert.deepEqual(body.sessions, []);
  });

  it("reports state: running and filters sessions belonging to project folder", async () => {
    const projectA = projectFixture("project-a");
    const projectB = projectFixture("project-b");

    const fakeFetch = async (url) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", service: "board" }) };
      }
      if (url.endsWith("/api/sessions")) {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: "s-a1", agent: "claude", cwd: projectA.root, title: "Session A1", status: "idle" },
              { id: "s-a2", agent: "codex", cwd: join(projectA.root, "sub"), title: "Session A2", status: "busy" },
              { id: "s-b1", agent: "claude", cwd: projectB.root, title: "Session B1", status: "idle" },
              { id: "s-other", agent: "cursor", cwd: "/Users/other/app", title: "Other", status: "idle" },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { server, token } = await serverFor({
      projects: [projectA, projectB],
      fetchImpl: fakeFetch,
    });

    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;

    // Query for Project A
    const resA = await fetch(`${origin}/api/agents/board?project=${projectA.id}`, {
      headers: { "x-flisk-token": token, origin },
    });
    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA.state, "running");
    assert.equal(bodyA.sessions.length, 2);
    assert.deepEqual(bodyA.sessions.map((s) => s.id), ["s-a1", "s-a2"]);

    // Query for Project B
    const resB = await fetch(`${origin}/api/agents/board?project=${projectB.id}`, {
      headers: { "x-flisk-token": token, origin },
    });
    assert.equal(resB.status, 200);
    const bodyB = await resB.json();
    assert.equal(bodyB.state, "running");
    assert.equal(bodyB.sessions.length, 1);
    assert.deepEqual(bodyB.sessions.map((s) => s.id), ["s-b1"]);
  });

  it("handles board up with zero sessions", async () => {
    const project = projectFixture("empty-sessions");

    const fakeFetch = async (url) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", service: "board" }) };
      }
      if (url.endsWith("/api/sessions")) {
        return {
          ok: true,
          json: async () => ({
            sessions: [],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { server, token } = await serverFor({
      projects: [project],
      fetchImpl: fakeFetch,
    });

    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const res = await fetch(`${origin}/api/agents/board?project=${project.id}`, {
      headers: { "x-flisk-token": token, origin },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, "running");
    assert.deepEqual(body.sessions, []);
  });

  it("returns 400 for unknown project", async () => {
    const { server, token } = await serverFor({
      projects: [],
    });
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const res = await fetch(`${origin}/api/agents/board?project=missing`, {
      headers: { "x-flisk-token": token, origin },
    });
    assert.equal(res.status, 400);
  });
});
