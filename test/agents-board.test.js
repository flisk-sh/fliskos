import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("matches paths regardless of drive letter casing on Windows", () => {
    if (process.platform !== "win32") return;
    assert.equal(isSessionInsideProject("c:\\projects\\app", "C:\\projects\\app"), true);
    assert.equal(isSessionInsideProject("c:\\projects\\app\\services\\api", "C:\\projects\\app"), true);
    assert.equal(isSessionInsideProject("C:\\projects\\app", "c:\\projects\\app"), true);
  });

  it("normalizes Windows drive letter case differences (simulated win32)", () => {
    assert.equal(isSessionInsideProject("c:\\projects\\app", "C:\\projects\\app", "win32"), true);
    assert.equal(isSessionInsideProject("c:\\projects\\app\\services\\api", "C:\\projects\\app", "win32"), true);
    assert.equal(isSessionInsideProject("C:\\projects\\app", "c:\\projects\\app", "win32"), true);
    assert.equal(isSessionInsideProject("d:\\projects\\app", "c:\\projects\\app", "win32"), false);
    assert.equal(isSessionInsideProject("c:\\projects\\app-other", "c:\\projects\\app", "win32"), false);
  });

  it("correctly matches legitimate descendant paths when project is filesystem root", () => {
    assert.equal(isSessionInsideProject("/some/nested/project", "/"), true);
    assert.equal(isSessionInsideProject("/", "/"), true);
  });

  it("does not match unrelated paths when project root is empty or invalid", () => {
    assert.equal(isSessionInsideProject("/some/path", ""), false);
    assert.equal(isSessionInsideProject("/some/path", null), false);
    assert.equal(isSessionInsideProject("/some/path", undefined), false);
    assert.equal(isSessionInsideProject("", "/some/path"), false);
    assert.equal(isSessionInsideProject(null, "/some/path"), false);
    assert.equal(isSessionInsideProject(undefined, "/some/path"), false);
  });

  it("rejects completely unrelated directory paths", () => {
    assert.equal(isSessionInsideProject("/var/log", "/home/user/project"), false);
    assert.equal(isSessionInsideProject("/home/user/other-project", "/home/user/project"), false);
  });

  it("handles trailing slash variations properly", () => {
    const dir = projectFixture("trailing-slash").root;
    assert.equal(isSessionInsideProject(`${dir}///`, `${dir}/`), true);
    assert.equal(isSessionInsideProject(dir, `${dir}/`), true);
    assert.equal(isSessionInsideProject(`${dir}/sub/`, dir), true);
  });

  it("resolves symlinks to match canonical project location", () => {
    const dir = projectFixture("symlink-target").root;
    const linkDir = join(tmpdir(), `flisk-symlink-${Date.now()}`);
    tempDirs.push(linkDir);
    try {
      symlinkSync(dir, linkDir);
      assert.equal(isSessionInsideProject(linkDir, dir), true);
      assert.equal(isSessionInsideProject(dir, linkDir), true);
    } catch {
      // In environments where symlink creation is restricted, skip gracefully
    }
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

  it("returns false when service is not board (incorrect service on port 4100)", async () => {
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

describe("fetchBoardSessions: session normalization and retrieval errors", () => {
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
    assert.ok(Array.isArray(sessions));
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

  it("returns genuine empty array when response has sessions: []", async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({
        sessions: [],
        clashes: [],
      }),
    });
    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.ok(Array.isArray(sessions));
    assert.deepEqual(sessions, []);
  });

  it("returns null on network failure / connection reset", async () => {
    const fakeFetch = async () => {
      throw new Error("ECONNRESET: socket hang up");
    };
    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.equal(sessions, null);
  });

  it("returns null on HTTP 500", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal Server Error" }),
    });
    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.equal(sessions, null);
  });

  it("returns null on timeout / abort", async () => {
    const fakeFetch = async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    };
    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.equal(sessions, null);
  });

  it("returns null on invalid JSON", async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON at position 0");
      },
    });
    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.equal(sessions, null);
  });

  it("returns null on missing or non-array .sessions", async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({
        error: "corrupt state",
      }),
    });
    const sessions = await fetchBoardSessions(BOARD_URL, 1000, fakeFetch);
    assert.equal(sessions, null);
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

  it("reports state: not-running when incorrect service responds on port 4100", async () => {
    const project = projectFixture("wrong-service");
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ status: "ok", service: "another-app" }),
    });

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

  it("handles board up with genuine zero sessions", async () => {
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

  it("reports state: sessions-error when board is healthy but sessions fetch returns 500", async () => {
    const project = projectFixture("error-500");

    const fakeFetch = async (url) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", service: "board" }) };
      }
      if (url.endsWith("/api/sessions")) {
        return { ok: false, status: 500, json: async () => ({ error: "Internal crash" }) };
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
    assert.equal(body.state, "sessions-error");
    assert.equal(body.error, "Unable to load agent sessions.");
    assert.deepEqual(body.sessions, []);
  });

  it("reports state: sessions-error when board is healthy but sessions fetch has connection reset", async () => {
    const project = projectFixture("conn-reset");

    const fakeFetch = async (url) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", service: "board" }) };
      }
      if (url.endsWith("/api/sessions")) {
        throw new Error("ECONNRESET: socket hang up");
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
    assert.equal(body.state, "sessions-error");
    assert.deepEqual(body.sessions, []);
  });

  it("reports state: sessions-error when board is healthy but sessions fetch times out", async () => {
    const project = projectFixture("timeout-test");

    const fakeFetch = async (url) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", service: "board" }) };
      }
      if (url.endsWith("/api/sessions")) {
        const err = new Error("The operation was aborted");
        err.name = "TimeoutError";
        throw err;
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
    assert.equal(body.state, "sessions-error");
    assert.deepEqual(body.sessions, []);
  });

  it("reports state: sessions-error when board is healthy but sessions fetch returns invalid JSON or missing .sessions", async () => {
    const project = projectFixture("malformed-sessions");

    const fakeFetch = async (url) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", service: "board" }) };
      }
      if (url.endsWith("/api/sessions")) {
        return { ok: true, json: async () => ({ invalid: true }) };
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
    assert.equal(body.state, "sessions-error");
    assert.deepEqual(body.sessions, []);
  });

  it("recovers after transient sessions error on subsequent request", async () => {
    const project = projectFixture("recovery-test");
    let attempts = 0;

    const fakeFetch = async (url) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", service: "board" }) };
      }
      if (url.endsWith("/api/sessions")) {
        attempts++;
        if (attempts === 1) {
          throw new Error("Temporary glitch");
        }
        return {
          ok: true,
          json: async () => ({
            sessions: [{ id: "recovered-1", agent: "claude", cwd: project.root, title: "Recovered", status: "idle" }],
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

    // First attempt -> sessions-error
    const res1 = await fetch(`${origin}/api/agents/board?project=${project.id}`, {
      headers: { "x-flisk-token": token, origin },
    });
    const body1 = await res1.json();
    assert.equal(body1.state, "sessions-error");

    // Second attempt -> recovers to running with session
    const res2 = await fetch(`${origin}/api/agents/board?project=${project.id}`, {
      headers: { "x-flisk-token": token, origin },
    });
    const body2 = await res2.json();
    assert.equal(body2.state, "running");
    assert.equal(body2.sessions.length, 1);
    assert.equal(body2.sessions[0].id, "recovered-1");
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
