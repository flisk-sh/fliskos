import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { checkDocker, discoverProjects, lowDiskNote, maskPaths, tiltProgress, normalizeState, readAppState, writeAppState, restartDockerDesktop, probeCli, resolveProjects, runTdk, startAppServer, summarizeDoctor } from "../src/app.js";

const TOKEN = "crash-test-token";
const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections?.(); server.close(done); })));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix = "flisk-crash-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

const supported = { state: "supported", lifecycle: true, version: "1.3.145", minVersion: "1.3.145", installUrl: "https://example.test", message: null };
const projects = [
  { id: "a", name: "a", root: "/projects/a" },
  { id: "b", name: "b", root: "/projects/b" },
];
const okEnvelope = (data) => ({ status: 0, stderr: "", stdout: JSON.stringify({ data }) });
const goodStatus = okEnvelope({ resources: [{ name: "api", stack: "s", type: "backend", status: "ready" }], stacks: [{ name: "s" }], ports: [{ name: "api", hostPort: 8080 }], tilt: { resources: { items: [{ metadata: { name: "api" } }] } } });

async function boot(options = {}) {
  const started = await startAppServer({
    projects,
    port: 0,
    token: TOKEN,
    probe: async () => supported,
    runCommand: async () => goodStatus,
    openPath: async () => {},
    dockerCheck: async () => true,
    ...options,
  });
  servers.push(started.server);
  return started;
}

// Raw request so tests can control Host, Origin, method, headers and body exactly.
function raw(server, { method = "GET", path = "/", headers = {}, body, auth = true } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, method, path,
      headers: { host: `127.0.0.1:${port}`, ...(auth ? { "x-flisk-token": TOKEN } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (server, path, body, extra = {}) => {
  const { port } = server.address();
  return raw(server, { method: "POST", path, body: typeof body === "string" ? body : JSON.stringify(body), headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, ...extra });
};

async function assertAlive(server) {
  const response = await raw(server, { path: "/api/cli" });
  assert.equal(response.status, 200, "server should still answer after the abuse");
}

describe("HTTP request abuse", () => {
  const malformedBodies = [
    ["invalid JSON", "{not json"],
    ["truncated JSON", '{"project":"a","operation":'],
    ["JSON null", "null"],
    ["JSON array", "[1,2,3]"],
    ["JSON string", '"start"'],
    ["JSON number", "42"],
    ["lone surrogate escape", '{"project":"\\ud800"}'],
    ["deeply nested JSON", `${"[".repeat(5000)}${"]".repeat(5000)}`],
    ["binary garbage", "\u0000\u0001\u0002�"],
  ];
  for (const [label, body] of malformedBodies) {
    for (const path of ["/api/actions", "/api/open"]) {
      it(`answers ${path} with a 4xx for ${label} and stays up`, async () => {
        const { server } = await boot();
        const response = await post(server, path, body);
        assert(response.status >= 400 && response.status < 500, `expected 4xx, got ${response.status}: ${response.text}`);
        await assertAlive(server);
      });
    }
  }

  it("rejects an oversized body without crashing", async () => {
    const { server } = await boot();
    const response = await post(server, "/api/actions", JSON.stringify({ project: "a", operation: "start", pad: "x".repeat(200_000) })).catch((error) => ({ status: 0, error }));
    assert(response.status === 0 || (response.status >= 400 && response.status < 500));
    await assertAlive(server);
  });

  it("requires the session token on every API route", async () => {
    const { server } = await boot();
    for (const path of ["/api/cli", "/api/projects", "/api/logs?project=a&resource=x"]) {
      assert.equal((await raw(server, { path, auth: false })).status, 403, path);
      assert.equal((await raw(server, { path, headers: { "x-flisk-token": "wrong" } })).status, 403, path);
      assert.equal((await raw(server, { path, headers: { "x-flisk-token": "" } })).status, 403, path);
      assert.equal((await raw(server, { path, headers: { "x-flisk-token": "a".repeat(10_000) } })).status, 403, path);
    }
    await assertAlive(server);
  });

  it("serves the page only with the right token", async () => {
    const { server } = await boot();
    assert.equal((await raw(server, { path: "/", auth: false })).status, 404);
    assert.equal((await raw(server, { path: "/?token=nope", auth: false })).status, 404);
    const page = await raw(server, { path: `/?token=${TOKEN}`, auth: false });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(TOKEN), "the session token is embedded in the served page");
    assert.ok(!page.text.includes("__FLISK_CENTER_TOKEN__"), "the placeholder is replaced");
    assert.match(page.text, /meta name="flisk-token"/);
    assert.equal((await raw(server, { path: "/?token=%E0%A4%A", auth: false })).status, 404);
    assert.equal((await raw(server, { path: "/?token=a&token=b", auth: false })).status, 404);
  });

  it("rejects wrong Host headers (DNS rebinding) and cross-origin requests", async () => {
    const { server } = await boot();
    for (const host of ["evil.example", "localhost:80", "127.0.0.1:1", "127.0.0.1"]) {
      const response = await raw(server, { path: "/api/cli", headers: { host } }).catch(() => ({ status: 400 }));
      assert([400, 403].includes(response.status), `host ${JSON.stringify(host)} -> ${response.status}`);
    }
    for (const origin of ["http://evil.example", "null", "http://127.0.0.1:1", "file://"]) {
      assert.equal((await raw(server, { path: "/api/cli", headers: { origin } })).status, 403, origin);
    }
    assert.equal((await post(server, "/api/actions", { project: "a", operation: "start" }, { headers: {} })).status, 403, "POST with no Origin");
    await assertAlive(server);
  });

  it("returns 404 for unknown paths, odd methods and path tricks", async () => {
    const { server } = await boot();
    for (const [method, path] of [
      ["GET", "/nope"], ["GET", "/api/"], ["GET", "/api/nope"], ["PUT", "/api/projects"], ["DELETE", "/api/projects"],
      ["PATCH", "/api/actions"], ["GET", "/api/actions"], ["GET", "/api/open"], ["POST", "/api/projects"], ["POST", "/api/cli"],
      ["OPTIONS", "/api/projects"], ["GET", "/../../etc/passwd"], ["GET", "/%2e%2e/%2e%2e/etc/passwd"], ["GET", "//evil.example/x"],
      ["GET", "/api/projects/../actions"], ["GET", "/%zz"], ["GET", "/index.html"], ["GET", "/public/app.js"], ["GET", "/src/app.js"],
    ]) {
      const response = await raw(server, { method, path }).catch((error) => ({ status: 0, error }));
      assert(response.status === 0 || [400, 403, 404].includes(response.status), `${method} ${path} -> ${response.status}`);
    }
    await assertAlive(server);
  });

  it("survives a very long URL and header flood", async () => {
    const { server } = await boot();
    const response = await raw(server, { path: `/api/logs?project=a&resource=${"x".repeat(20_000)}` }).catch((error) => ({ status: 431, error }));
    assert([200, 400, 404, 431, 414, 500].includes(response.status));
    const headers = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`x-flood-${index}`, "y".repeat(50)]));
    await raw(server, { path: "/api/cli", headers }).catch(() => {});
    await assertAlive(server);
  });

  it("survives clients that disconnect mid-request and slow or half-open sockets", async () => {
    const { server } = await boot();
    const { port } = server.address();
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(`POST /api/actions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-flisk-token: ${TOKEN}\r\nOrigin: http://127.0.0.1:${port}\r\nContent-Length: 500\r\n\r\n{"project":`);
          socket.destroy();
          resolve();
        });
        socket.on("error", resolve);
      });
    }
    await new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1", () => { socket.write("GARBAGE\r\n\r\n"); });
      socket.on("data", () => {});
      socket.on("close", resolve);
      socket.on("error", resolve);
      setTimeout(() => { socket.destroy(); resolve(); }, 300);
    });
    await assertAlive(server);
  });

  it("handles a burst of concurrent requests", async () => {
    const { server } = await boot();
    const results = await Promise.all(Array.from({ length: 100 }, () => raw(server, { path: "/api/projects" })));
    assert(results.every((result) => result.status === 200));
    await assertAlive(server);
  });
});

describe("API input validation", () => {
  const badActions = [
    ["missing everything", {}],
    ["unknown project", { project: "zzz", operation: "start" }],
    ["project is a number", { project: 1, operation: "start" }],
    ["project is an object", { project: { $ne: 1 }, operation: "start" }],
    ["project is an array", { project: ["a"], operation: "start" }],
    ["unknown operation", { project: "a", operation: "destroy" }],
    ["operation is an array", { project: "a", operation: ["start"] }],
    ["prototype key as project", { project: "__proto__", operation: "start" }],
    ["constructor as operation", { project: "a", operation: "constructor" }],
    ["resources is a string", { project: "a", operation: "start", resources: "api" }],
    ["resources has numbers", { project: "a", operation: "start", resources: [1, 2] }],
    ["resources has null", { project: "a", operation: "start", resources: [null] }],
    ["resources has empty names", { project: "a", operation: "start", resources: [""] }],
    ["resources has objects", { project: "a", operation: "start", resources: [{}] }],
    ["too many resources", { project: "a", operation: "start", resources: Array.from({ length: 31 }, (_, index) => `r${index}`) }],
    ["resource looks like a CLI flag", { project: "a", operation: "start", resources: ["--project=/etc"] }],
    ["stack looks like a CLI flag", { project: "a", operation: "start", stack: "--help" }],
  ];
  for (const [label, body] of badActions) {
    it(`rejects /api/actions: ${label}`, async () => {
      const calls = [];
      const { server } = await boot({ runCommand: async (...args) => { calls.push(args); return goodStatus; } });
      const response = await post(server, "/api/actions", body);
      assert.equal(response.status, 400, response.text);
      assert.equal(calls.length, 0, "no CLI command may run for invalid input");
      await assertAlive(server);
    });
  }

  it("never lets shell metacharacters reach a shell", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (_project, args) => { calls.push(args); return okEnvelope({}); } });
    const response = await post(server, "/api/actions", { project: "a", operation: "start", resources: ["api; rm -rf /", "$(whoami)", "`id`"] });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ["up", "--json", "--only", "api; rm -rf /", "$(whoami)", "`id`"]);
  });

  it("rejects /api/open with bad kinds and projects", async () => {
    const opened = [];
    const { server } = await boot({ openPath: async (...args) => { opened.push(args); } });
    for (const body of [{}, { project: "a" }, { kind: "project" }, { project: "zzz", kind: "project" }, { project: "a", kind: "shell" }, { project: "a", kind: ["project"] }, { project: "../etc", kind: "project" }]) {
      assert.equal((await post(server, "/api/open", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(opened.length, 0);
  });

  it("rejects /api/logs with missing, unknown, repeated or encoded parameters", async () => {
    const { server } = await boot();
    for (const path of ["/api/logs", "/api/logs?project=a", "/api/logs?resource=x", "/api/logs?project=zzz&resource=x", "/api/logs?project=a&resource=", "/api/logs?project=%00&resource=x"]) {
      const response = await raw(server, { path });
      assert.equal(response.status, 400, path);
    }
    await assertAlive(server);
  });

  it("does not allow a resource name to inject CLI flags into logs", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (_project, args) => { calls.push(args); return okEnvelope({ lines: [] }); } });
    const response = await raw(server, { path: "/api/logs?project=a&resource=--follow" });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("CLI misbehaviour", () => {
  const garbage = [
    ["empty stdout", { status: 0, stderr: "", stdout: "" }],
    ["not JSON", { status: 0, stderr: "", stdout: "Segmentation fault" }],
    ["HTML error page", { status: 0, stderr: "", stdout: "<html>502</html>" }],
    ["JSON null", { status: 0, stderr: "", stdout: "null" }],
    ["JSON array", { status: 0, stderr: "", stdout: "[]" }],
    ["JSON string", { status: 0, stderr: "", stdout: '"hi"' }],
    ["JSON number", { status: 0, stderr: "", stdout: "42" }],
    ["data is null", { status: 0, stderr: "", stdout: '{"data":null}' }],
    ["errors only", { status: 1, stderr: "", stdout: '{"errors":[{"message":"boom"}]}' }],
    ["errors without messages", { status: 1, stderr: "", stdout: '{"errors":[null,{},"x"]}' }],
    ["non-zero exit, no output", { status: 1, stderr: "", stdout: "" }],
    ["killed (null status)", { status: null, stderr: "", stdout: "" }],
    ["stderr only", { status: 2, stderr: "permission denied", stdout: "" }],
    ["resources not an array", okEnvelope({ resources: "nope" })],
    ["resources is an object", okEnvelope({ resources: { a: 1 } })],
    ["resources contain null", okEnvelope({ resources: [null, 1, "x", []] })],
    ["resources missing names", okEnvelope({ resources: [{}, { name: 5 }, { name: null }] })],
    ["stacks not an array", okEnvelope({ stacks: 7 })],
    ["ports not an array", okEnvelope({ ports: "8080" })],
    ["ports contain null", okEnvelope({ ports: [null, 1, "x", {}] })],
    ["ports with string hostPort", okEnvelope({ ports: [{ name: "x", hostPort: "8080" }, { name: "y", hostPort: "8080" }] })],
    ["tilt is a string", okEnvelope({ tilt: "yes" })],
    ["huge resource list", okEnvelope({ resources: Array.from({ length: 5000 }, (_, index) => ({ name: `r${index}`, status: "ready" })) })],
    ["javascript: urls", okEnvelope({ resources: [{ name: "x", url: "javascript:alert(1)" }, { name: "y", url: { toString() {} } }] })],
    ["unicode and control characters", okEnvelope({ resources: [{ name: "\u0000‮<script>", stack: "\ud83d", status: "ready" }] })],
  ];
  for (const [label, result] of garbage) {
    it(`/api/projects survives: ${label}`, async () => {
      const { server } = await boot({ runCommand: async () => result });
      const response = await raw(server, { path: "/api/projects" });
      assert.equal(response.status, 200, response.text);
      assert(Array.isArray(response.json.projects));
      assert.equal(response.json.projects.length, projects.length, "every project should still be listed");
      await assertAlive(server);
    });
  }

  it("keeps listing healthy projects when one project's status fails", async () => {
    const { server } = await boot({ runCommand: async (project) => (project.id === "a" ? { status: 1, stderr: "boom", stdout: "" } : goodStatus) });
    const response = await raw(server, { path: "/api/projects" });
    assert.equal(response.status, 200, response.text);
    const byId = Object.fromEntries(response.json.projects.map((project) => [project.id, project]));
    assert(byId.a.error, "failed project reports an error");
    assert.equal(byId.b.resources.length, 1);
  });

  it("keeps listing when runCommand throws or rejects for one project", async () => {
    const { server } = await boot({ runCommand: async (project) => { if (project.id === "a") throw new Error("spawn exploded"); return goodStatus; } });
    const response = await raw(server, { path: "/api/projects" });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.projects.length, 2);
  });

  it("returns JSON errors for logs and actions when the CLI fails", async () => {
    const { server } = await boot({ runCommand: async () => { throw new Error("kaboom"); } });
    const logs = await raw(server, { path: "/api/logs?project=a&resource=api" });
    assert.equal(logs.status, 500);
    assert.match(logs.json.error, /kaboom/);
    const action = await post(server, "/api/actions", { project: "a", operation: "restart" });
    assert.equal(action.status, 500);
    assert.match(action.json.error, /kaboom/);
    await assertAlive(server);
  });

  it("tolerates logs payloads that are not arrays", async () => {
    for (const lines of ["text", 5, { a: 1 }, null]) {
      const { server } = await boot({ runCommand: async () => okEnvelope({ lines }) });
      const response = await raw(server, { path: "/api/logs?project=a&resource=api" });
      assert.equal(response.status, 200, response.text);
      assert(Array.isArray(response.json.lines));
    }
  });

  it("returns a JSON error when opening a folder fails", async () => {
    const { server } = await boot({ openPath: async () => { throw new Error("no such app"); } });
    const response = await post(server, "/api/open", { project: "a", kind: "terminal" });
    assert.equal(response.status, 500);
    assert.match(response.json.error, /no such app/);
    await assertAlive(server);
  });

  it("reports a failed capability probe instead of throwing", async () => {
    const { server } = await boot({ probe: async () => { throw new Error("probe blew up"); } });
    const response = await raw(server, { path: "/api/cli" });
    assert.equal(response.status, 200);
    assert.equal(response.json.lifecycle, false);
    assert.match(response.json.message, /probe blew up/);
    const action = await post(server, "/api/actions", { project: "a", operation: "start" });
    assert.equal(action.status, 409);
  });

  it("re-probes after a failed probe so installing the CLI is picked up", async () => {
    let calls = 0;
    const { server } = await boot({ probe: async () => (++calls === 1 ? { ...supported, state: "missing", lifecycle: false, message: "missing" } : supported) });
    assert.equal((await raw(server, { path: "/api/cli" })).json.lifecycle, false);
    assert.equal((await raw(server, { path: "/api/cli" })).json.lifecycle, true);
  });

  it("runs one lifecycle at a time per project; overlapping requests get 409, never a second run", async () => {
    let active = 0;
    let maxActive = 0;
    const { server } = await boot({
      runCommand: async (_project, args) => {
        // Only lifecycle commands count; other requests (Docker and CLI checks) may overlap freely.
        const lifecycle = args[0] === "up" || args[0] === "down";
        if (lifecycle) { active += 1; maxActive = Math.max(maxActive, active); }
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (lifecycle) active -= 1;
        return okEnvelope({});
      },
    });
    const results = await Promise.all(Array.from({ length: 25 }, () => post(server, "/api/actions", { project: "a", operation: "restart" })));
    assert(results.every((result) => result.status === 200 || result.status === 409));
    assert(results.some((result) => result.status === 200));
    // The background path shares the same record, so a background start cannot overlap a synchronous one.
    assert.equal(maxActive, 1);
  });
});

describe("CLI self-update endpoint", () => {
  it("runs `flisk upgrade --yes` without sudo and re-probes", async () => {
    const calls = [];
    let probed = 0;
    const { server } = await boot({
      probe: async () => (++probed === 1 ? { ...supported, state: "unsupported", lifecycle: false, message: "old" } : supported),
      runCommand: async (_project, args) => { calls.push(args); return { status: 0, stdout: "upgraded", stderr: "" }; },
    });
    await raw(server, { path: "/api/cli" });
    const response = await post(server, "/api/cli/update", {});
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.cli.lifecycle, true);
    assert.deepEqual(calls, [["upgrade", "--yes", "--all"]]);
  });

  it("reports failure without throwing when the upgrade fails or the CLI is missing", async () => {
    for (const result of [{ status: 1, stdout: "", stderr: "EACCES" }, { status: null, stdout: "", stderr: "ENOENT" }]) {
      const { server } = await boot({ runCommand: async () => result });
      const response = await post(server, "/api/cli/update", {});
      assert.equal(response.status, 200);
      assert.equal(response.json.ok, false);
      await assertAlive(server);
    }
  });

  it("rejects overlapping updates and cross-origin callers", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { server } = await boot({ runCommand: async () => { await gate; return { status: 0, stdout: "", stderr: "" }; } });
    const first = post(server, "/api/cli/update", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await post(server, "/api/cli/update", {})).status, 409);
    assert.equal((await post(server, "/api/cli/update", {}, { headers: {} })).status, 403);
    assert.equal((await post(server, "/api/cli/update", {}, { headers: { origin: "http://evil.example" } })).status, 403);
    release();
    assert.equal((await first).status, 200);
  });

  it("is POST only", async () => {
    const { server } = await boot();
    assert.equal((await raw(server, { path: "/api/cli/update" })).status, 404);
  });
});

describe("doctor scores", () => {
  const report = (checks, ready = true) => ({ status: 0, stderr: "", stdout: JSON.stringify({ schemaVersion: 1, data: { ready, inProject: true, checks } }) });
  const pass = (name) => ({ name, didPass: true, message: "ok" });
  const warn = (name) => ({ name, didPass: false, isWarning: true, message: "careful", fix: "do x" });
  const fail = (name) => ({ name, didPass: false, message: "broken", fix: "do y" });

  it("scores pass=1, warning=0.5, fail=0 and ignores skipped checks", () => {
    const summary = summarizeDoctor({ ready: false, checks: [pass("a"), pass("b"), warn("c"), fail("d"), { name: "e", isSkipped: true, didPass: false }] });
    assert.equal(summary.score, 63);
    assert.deepEqual([summary.passed, summary.warnings, summary.failed, summary.total], [2, 1, 1, 4]);
    assert.equal(summary.checks.find((check) => check.name === "e").status, "skipped");
  });

  it("returns a null score instead of crashing for empty or malformed reports", () => {
    for (const data of [null, undefined, 5, "x", [], {}, { checks: "no" }, { checks: [null, 1, "x", []] }, { checks: [{}] }]) {
      const summary = summarizeDoctor(data);
      assert(summary.score === null || typeof summary.score === "number");
      assert(Array.isArray(summary.checks));
    }
  });

  it("serves /api/doctor and caches it so refreshes do not rerun the CLI", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (project, args) => { calls.push(args); return report([pass("docker"), fail("ports")], false); } });
    const first = await raw(server, { path: "/api/doctor?project=a" });
    assert.equal(first.status, 200);
    assert.equal(first.json.score, 50);
    assert.equal(first.json.failed, 1);
    await raw(server, { path: "/api/doctor?project=a" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["doctor", "--json"]);
    await raw(server, { path: "/api/doctor?project=a&refresh=1" });
    assert.equal(calls.length, 2);
  });

  it("runs doctor once for concurrent requests", async () => {
    let calls = 0;
    const { server } = await boot({ runCommand: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 50)); return report([pass("a")]); } });
    await Promise.all(Array.from({ length: 10 }, () => raw(server, { path: "/api/doctor?project=a" })));
    assert.equal(calls, 1);
  });

  it("reports a doctor failure or hang as an error payload, not a 500", async () => {
    for (const result of [{ status: null, stdout: "", stderr: "" }, { status: 1, stdout: "garbage", stderr: "boom" }, { status: 0, stdout: "null", stderr: "" }]) {
      const { server } = await boot({ runCommand: async () => result });
      const response = await raw(server, { path: "/api/doctor?project=a" });
      assert.equal(response.status, 200);
      assert(response.json.error);
    }
    const { server } = await boot({ runCommand: async () => { throw new Error("spawn exploded"); } });
    assert.match((await raw(server, { path: "/api/doctor?project=a" })).json.error, /spawn exploded/);
  });

  it("rejects unknown projects and needs the token", async () => {
    const { server } = await boot();
    assert.equal((await raw(server, { path: "/api/doctor?project=zzz" })).status, 400);
    assert.equal((await raw(server, { path: "/api/doctor" })).status, 400);
    assert.equal((await raw(server, { path: "/api/doctor?project=a", auth: false })).status, 403);
  });
});

describe("Docker preflight", () => {
  it("refuses start, stop and restart with a clear 503 when Docker is not responding, without running the CLI", async () => {
    const calls = [];
    const { server } = await boot({ dockerCheck: async () => false, runCommand: async (_p, args) => { calls.push(args); return okEnvelope({}); } });
    for (const operation of ["start", "stop", "restart"]) {
      const response = await post(server, "/api/actions", { project: "a", operation });
      assert.equal(response.status, 503, operation);
      assert.equal(response.json.code, "docker_unavailable");
      assert.match(response.json.error, /Docker/);
    }
    assert.equal(calls.length, 0);
  });

  it("lowDiskNote warns only when free space is below the threshold and never throws", () => {
    assert.equal(lowDiskNote(tmpdir(), 0), "");
    assert.match(lowDiskNote(tmpdir(), 1e9), /GB free/);
    assert.equal(lowDiskNote("/definitely/not/a/path"), "");
  });

  it("treats a throwing Docker check as unavailable", async () => {
    const { server } = await boot({ dockerCheck: async () => { throw new Error("x"); } });
    assert.equal((await post(server, "/api/actions", { project: "a", operation: "start" })).status, 503);
  });

  it("checkDocker is false for a missing binary and a hung or failing one", async () => {
    assert.equal(await checkDocker(async () => ({ status: null, stdout: "", stderr: "ENOENT" })), false);
    assert.equal(await checkDocker(async () => ({ status: 1, stdout: "", stderr: "daemon not running" })), false);
    assert.equal(await checkDocker(async () => ({ status: 0, stdout: "27.0.1", stderr: "" })), true);
  });
});

describe("Docker restart", () => {
  const fakeRun = (script = {}) => {
    const calls = [];
    const run = async (command, args) => { calls.push([command, ...args]); return script[command]?.(calls.length) ?? { status: 1, stdout: "", stderr: "" }; };
    return { run, calls };
  };
  const noSleep = async () => {};

  it("quits, reopens and waits until Docker answers", async () => {
    const { run, calls } = fakeRun({ osascript: () => ({ status: 0 }), pgrep: () => ({ status: 1 }), open: () => ({ status: 0 }) });
    let checks = 0;
    const result = await restartDockerDesktop({ run, sleep: noSleep, platform: "darwin", free: () => 50, check: async () => ++checks >= 3 });
    assert.equal(result.ok, true);
    assert.equal(checks, 3);
    assert.deepEqual(calls.map((call) => call[0]), ["osascript", "pgrep", "open"]);
  });

  it("force-kills Docker when it refuses to quit", async () => {
    const { run, calls } = fakeRun({ osascript: () => ({ status: 0 }), pgrep: () => ({ status: 0 }), pkill: () => ({ status: 0 }), open: () => ({ status: 0 }) });
    const result = await restartDockerDesktop({ run, sleep: noSleep, platform: "darwin", free: () => 50, check: async () => true });
    assert.equal(result.ok, true);
    assert(calls.some((call) => call[0] === "pkill" && call.includes("-9")));
  });

  it("refuses to restart when the disk is nearly full, without touching Docker", async () => {
    const { run, calls } = fakeRun();
    const result = await restartDockerDesktop({ run, sleep: noSleep, platform: "darwin", free: () => 1.2, check: async () => true });
    assert.equal(result.ok, false);
    assert.match(result.message, /disk/);
    assert.equal(calls.length, 0);
  });

  it("refuses on non-macOS and reports a missing or still-dead Docker", async () => {
    assert.equal((await restartDockerDesktop({ platform: "linux" })).ok, false);
    const missing = fakeRun({ osascript: () => ({ status: 0 }), pgrep: () => ({ status: 1 }), open: () => ({ status: 1 }) });
    assert.match((await restartDockerDesktop({ run: missing.run, sleep: noSleep, platform: "darwin", free: () => 50, check: async () => true })).message, /Could not open/);
    const dead = fakeRun({ osascript: () => ({ status: 0 }), pgrep: () => ({ status: 1 }), open: () => ({ status: 0 }) });
    let now = 0;
    const realNow = Date.now;
    Date.now = () => (now += 100_000);
    try {
      const result = await restartDockerDesktop({ run: dead.run, sleep: noSleep, platform: "darwin", free: () => 50, check: async () => false, waitMs: 250_000 });
      assert.equal(result.ok, false);
      assert.match(result.message, /still not responding/);
    } finally { Date.now = realNow; }
  });

  it("endpoint runs the restart once at a time and needs POST, token and origin", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const { server } = await boot({ dockerRestart: async () => { calls += 1; await gate; return { ok: true, message: "up" }; } });
    assert.equal((await raw(server, { path: "/api/docker/restart" })).status, 404);
    assert.equal((await post(server, "/api/docker/restart", {}, { headers: {} })).status, 403);
    const first = post(server, "/api/docker/restart", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await post(server, "/api/docker/restart", {})).status, 409);
    release();
    const done = await first;
    assert.equal(done.status, 200);
    assert.equal(done.json.ok, true);
    assert.equal(calls, 1);
  });

  it("a throwing restart returns a JSON error and the server stays up", async () => {
    const { server } = await boot({ dockerRestart: async () => { throw new Error("osascript missing"); } });
    const response = await post(server, "/api/docker/restart", {});
    assert.equal(response.status, 500);
    assert.match(response.json.error, /osascript/);
    await assertAlive(server);
  });
});

describe("username masking", () => {
  it("masks the home path and any /Users/<name> in every JSON response", async () => {
    const user = homedir().split("/").pop();
    const home = homedir();
    const { server } = await boot({
      projects: [{ id: "a", name: "a", root: `${home}/Developer/a` }],
      runCommand: async () => okEnvelope({ resources: [{ name: "x", message: `see /Users/someone-else/app and ${home}/Developer/a/log` }], lines: [`${home}/x`] }),
    });
    for (const path of ["/api/projects", "/api/logs?project=a&resource=x", "/api/meta", "/api/doctor?project=a"]) {
      const response = await raw(server, { path });
      assert(!response.text.includes(user), `${path} leaked the username: ${response.text.slice(0, 200)}`);
      assert(!response.text.includes("someone-else"));
    }
    const projectsResponse = await raw(server, { path: "/api/projects" });
    assert.equal(projectsResponse.json.projects[0].path, "~/Developer/a");
  });

  it("masks usernames inside error messages too", async () => {
    const { server } = await boot({ runCommand: async () => { throw new Error(`ENOENT /Users/secretname/x`); } });
    const response = await raw(server, { path: "/api/logs?project=a&resource=x" });
    assert(!response.text.includes("secretname"));
    assert.equal(maskPaths("/Users/abc/x /Users/****/y"), "/Users/****/x /Users/****/y");
  });
});

describe("CRUD actions through the Flisk CLI", () => {
  const record = () => {
    const calls = [];
    return { calls, runCommand: async (project, args) => { calls.push({ root: project.root, args }); return { status: 0, stdout: "done", stderr: "" }; } };
  };

  it("creates a resource with the right flags", async () => {
    const { calls, runCommand } = record();
    const { server } = await boot({ runCommand });
    const response = await post(server, "/api/resources", { project: "a", name: "my-api", type: "backend", stack: "core", framework: "hono", language: "bun", port: 4100 });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.deepEqual(calls[0].args, ["resource", "my-api", "--type", "backend", "--yes", "--stack", "core", "--framework", "hono", "--language", "bun", "--port", "4100"]);
  });

  const badResources = [
    {}, { project: "a" }, { project: "a", name: "My API" }, { project: "a", name: "-rf" }, { project: "a", name: "api; rm" }, { project: "a", name: "../x" },
    { project: "a", name: "ok", type: "nope" }, { project: "a", name: "ok", stack: "--help" }, { project: "a", name: "ok", stack: "A B" }, { project: "a", name: "ok", framework: "--x" },
    { project: "a", name: "ok", language: ["bun"] }, { project: "a", name: "ok", port: 0 }, { project: "a", name: "ok", port: 70000 }, { project: "a", name: "ok", port: "80" },
    { project: "zzz", name: "ok" }, { project: ["a"], name: "ok" }, { project: "a", name: "a".repeat(80) },
  ];
  badResources.forEach((body, index) => {
    it(`rejects invalid resource request #${index} without running the CLI`, async () => {
      const { calls, runCommand } = record();
      const { server } = await boot({ runCommand });
      assert.equal((await post(server, "/api/resources", body)).status, 400);
      assert.equal(calls.length, 0);
    });
  });

  it("assigns resources to a stack (create or move)", async () => {
    const { calls, runCommand } = record();
    const { server } = await boot({ runCommand });
    assert.equal((await post(server, "/api/stacks", { project: "a", name: "core", resources: ["api", "web"] })).status, 200);
    assert.deepEqual(calls[0].args, ["stack", "core", "--resources", "api", "web", "--yes"]);
    for (const body of [{ project: "a", name: "core" }, { project: "a", name: "core", resources: [] }, { project: "a", name: "core", resources: ["--yes"] }, { project: "a", name: "Core", resources: ["a"] }, { project: "a", name: "core", resources: "api" }, { project: "a", name: "core", resources: Array.from({ length: 31 }, (_, i) => `r${i}`) }]) {
      assert.equal((await post(server, "/api/stacks", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(calls.length, 1);
  });

  it("regenerates and verifies config, rejecting anything else", async () => {
    const { calls, runCommand } = record();
    const { server } = await boot({ runCommand });
    await post(server, "/api/config", { project: "a", operation: "regenerate" });
    await post(server, "/api/config", { project: "a", operation: "verify" });
    assert.deepEqual(calls.map((call) => call.args), [["config", "regenerate"], ["config", "verify"]]);
    for (const operation of ["delete", "__proto__", "constructor", "toString", ["verify"], undefined]) {
      assert.equal((await post(server, "/api/config", { project: "a", operation })).status, 400, String(operation));
    }
    assert.equal(calls.length, 2);
  });

  it("reports CLI failure as ok:false with output, not an error status", async () => {
    const { server } = await boot({ runCommand: async () => ({ status: 3, stdout: "", stderr: "name already exists" }) });
    const response = await post(server, "/api/resources", { project: "a", name: "dup" });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, false);
    assert.match(response.json.output, /already exists/);
  });

  it("creates a blank project and registers it in the list", async () => {
    const parent = tempDir();
    const calls = [];
    const runCommand = async (project, args) => {
      calls.push({ root: project.root, args });
      if (args[0] === "project") { mkdirSync(join(project.root, ".tdk"), { recursive: true }); writeFileSync(join(project.root, ".tdk", "project.json"), JSON.stringify({ project: { name: "shop" } })); }
      return { status: 0, stdout: "created", stderr: "" };
    };
    const list = [];
    const { server } = await boot({ projects: list, runCommand });
    const response = await post(server, "/api/projects/create", { parent, name: "shop" });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.project.name, "shop");
    assert.deepEqual(calls[0].args, ["project", "--yes"]);
    assert.equal(list.length, 1, "project is added to the live list");
    assert.equal((await post(server, "/api/projects/create", { parent, name: "shop" })).status, 409, "existing folder is refused");
  });

  it("creates from a template with --path and cleans up a failed blank create", async () => {
    const parent = tempDir();
    const calls = [];
    const { server } = await boot({ projects: [], runCommand: async (project, args) => { calls.push({ root: project.root, args }); return { status: 1, stdout: "", stderr: "boom" }; } });
    const failed = await post(server, "/api/projects/create", { parent, name: "blank" });
    assert.equal(failed.json.ok, false);
    assert.equal(existsSync(join(parent, "blank")), false, "empty folder removed after failure");
    await post(server, "/api/projects/create", { parent, name: "shop", template: "restaurant" });
    assert.equal(calls[1].args[0], "project");
    assert.deepEqual(calls[1].args.slice(1, 2), ["restaurant"]);
    assert(calls[1].args.includes("--path") && calls[1].args.includes("--yes"));
  });

  it("refuses unsafe project creation", async () => {
    const parent = tempDir();
    const { calls, runCommand } = record();
    const { server } = await boot({ runCommand });
    const bad = [
      { parent: "/", name: "x" }, { parent: "/etc", name: "x" }, { parent: "relative/path", name: "x" }, { parent: join(parent, "missing"), name: "x" }, { parent: 5, name: "x" },
      { parent: `${parent}/../..`, name: "x" }, { parent, name: "../escape" }, { parent, name: "Bad Name" }, { parent, name: "-x" }, { parent, name: "" }, { parent, name: "ok", template: "evil" }, { parent, name: "ok", template: "--force" },
    ];
    for (const body of bad) assert.equal((await post(server, "/api/projects/create", body)).status, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  });

  it("serves meta with tilde paths", async () => {
    const { server } = await boot();
    const meta = await raw(server, { path: "/api/meta" });
    assert.equal(meta.status, 200);
    assert(meta.json.templates.includes("restaurant") && meta.json.resourceTypes.includes("backend"));
    assert.match(meta.json.defaultParent, /^~|^\//);
  });

  it("all create/update endpoints need token and same-origin POST", async () => {
    const { server } = await boot();
    for (const path of ["/api/resources", "/api/stacks", "/api/config", "/api/projects/create"]) {
      assert.equal((await post(server, path, {}, { headers: {} })).status, 403, path);
      assert.equal((await raw(server, { path })).status, 404, `${path} GET`);
      assert.equal((await post(server, path, "{bad")).status, 400, `${path} bad json`);
    }
  });
});

describe("status cache", () => {
  it("answers repeat /api/projects from cache and refreshes in the background", async () => {
    let calls = 0;
    const { server } = await boot({ runCommand: async (_p, args) => { if (args[0] === "status") calls += 1; return goodStatus; } });
    await raw(server, { path: "/api/projects" });
    const first = calls;
    await raw(server, { path: "/api/projects" });
    assert.equal(calls, first, "fresh cache is reused");
  });

  it("prewarms status after the scan only when asked", async () => {
    let calls = 0;
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    await boot({ prewarm: true, projectsReady: ready, runCommand: async (_p, args) => { if (args[0] === "status") calls += 1; return goodStatus; } });
    assert.equal(calls, 0);
    markReady();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, projects.length);
  });
});

describe("disk cleanup", () => {
  it("lists only fixed candidates with sizes and Docker availability", async () => {
    const { server } = await boot({ dockerCheck: async () => false, runCommand: async (_p, args, options) => (options?.binary === "du" ? { status: 0, stdout: `${2 * 1024 * 1024}\t${args[1]}`, stderr: "" } : { status: 0, stdout: "", stderr: "" }) });
    const response = await raw(server, { path: "/api/disk" });
    assert.equal(response.status, 200);
    const docker = response.json.items.find((item) => item.id === "docker");
    assert.equal(docker.available, false);
    assert(response.json.items.every((item) => !/Downloads|Trash/.test(item.label)));
    assert(response.json.items.some((item) => item.sizeMb === 2048) || response.json.items.every((item) => item.sizeMb == null));
  });

  it("runs the mapped command for each chosen id and nothing else", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (_p, args, options) => { calls.push([options?.binary, ...args]); return { status: 0, stdout: "", stderr: "" }; } });
    const response = await post(server, "/api/disk/clean", { ids: ["npm", "bun", "npm"] });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["npm", "cache", "clean", "--force"], ["bun", "pm", "cache", "rm"]]);
    assert.equal(response.json.results.length, 2);
  });

  it("reports a failing cleanup per item without throwing", async () => {
    const { server } = await boot({ runCommand: async () => ({ status: 1, stdout: "", stderr: "brew: command not found" }) });
    const response = await post(server, "/api/disk/clean", { ids: ["brew"] });
    assert.equal(response.status, 200);
    assert.equal(response.json.results[0].ok, false);
  });

  it("rejects unknown ids, raw paths and malformed bodies without running anything", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (...args) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; } });
    for (const body of [{}, { ids: [] }, { ids: ["../../etc"] }, { ids: ["/"] }, { ids: ["rm -rf /"] }, { ids: "npm" }, { ids: [1] }, { ids: ["__proto__"] }, { ids: ["npm", "nope"] }, { ids: Array.from({ length: 20 }, () => "npm") }]) {
      assert.equal((await post(server, "/api/disk/clean", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
  });

  it("marks low-disk Docker failures so the UI can offer cleanup, and needs token/origin", async () => {
    const { server } = await boot();
    assert.equal((await post(server, "/api/disk/clean", { ids: ["npm"] }, { headers: {} })).status, 403);
    assert.equal((await raw(server, { path: "/api/disk", auth: false })).status, 403);
  });

  it("restart refusal on a full disk is flagged lowDisk", async () => {
    const result = await restartDockerDesktop({ platform: "darwin", free: () => 1, run: async () => ({ status: 0 }) });
    assert.equal(result.lowDisk, true);
  });
});

describe("config drift checks and log", () => {
  it("runs verify as config verify, records exit code, and reports drift state", async () => {
    let exit = 1;
    const { server } = await boot({ runCommand: async () => ({ status: exit, stdout: "drift: 2 files", stderr: "" }) });
    const first = await post(server, "/api/config", { project: "a", operation: "verify" });
    assert.equal(first.json.ok, false);
    assert.equal(first.json.entry.exitCode, 1);
    exit = 0;
    await post(server, "/api/config", { project: "a", operation: "verify" });
    const log = await raw(server, { path: "/api/config/log?project=a" });
    assert.equal(log.json.status.ok, true, "latest verify wins");
    assert.equal(log.json.entries.length, 2);
    assert.equal(log.json.entries[0].exitCode, 0, "newest first");
  });

  it("allows migrate and logs it; rejects anything else", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (_p, args) => { calls.push(args); return { status: 0, stdout: "migrated 6", stderr: "" }; } });
    const ok = await post(server, "/api/config", { project: "a", operation: "migrate" });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [["config", "migrate"]]);
    for (const operation of ["delete", "toString", "__proto__", ["verify"], undefined]) {
      assert.equal((await post(server, "/api/config", { project: "a", operation })).status, 400, String(operation));
    }
    assert.equal(calls.length, 1);
  });

  it("keeps logs per project and caps the total", async () => {
    const { server } = await boot({ projects: [{ id: "a", name: "a", root: "/projects/a" }, { id: "b", name: "b", root: "/projects/b" }], runCommand: async () => ({ status: 0, stdout: "", stderr: "" }) });
    await post(server, "/api/config", { project: "a", operation: "verify" });
    await post(server, "/api/config", { project: "b", operation: "verify" });
    assert.equal((await raw(server, { path: "/api/config/log?project=a" })).json.entries.length, 1);
    assert.equal((await raw(server, { path: "/api/config/log?project=b" })).json.entries.length, 1);
    assert.equal((await raw(server, { path: "/api/config/log?project=zzz" })).status, 400);
  });

  it("masks the username in logged output and needs token and origin", async () => {
    const home = homedir();
    const { server } = await boot({ runCommand: async () => ({ status: 1, stdout: `drift in ${home}/Developer/x`, stderr: "" }) });
    await post(server, "/api/config", { project: "a", operation: "verify" });
    const log = await raw(server, { path: "/api/config/log?project=a" });
    assert(!log.text.includes(home.split("/").pop()));
    assert.equal((await raw(server, { path: "/api/config/log?project=a", auth: false })).status, 403);
    assert.equal((await post(server, "/api/config", { project: "a", operation: "verify" }, { headers: {} })).status, 403);
  });

  it("runs a long-running command with its own timeout and reports a killed run", async () => {
    const { server } = await boot({ runCommand: async () => ({ status: null, stdout: "", stderr: "" }) });
    const response = await post(server, "/api/config", { project: "a", operation: "regenerate" });
    assert.equal(response.json.ok, false);
    assert.equal(response.json.entry.exitCode, null);
  });
});

describe("start progress", () => {
  const ui = (entries) => ({ items: entries.map(([name, updateStatus, runtimeStatus]) => ({ metadata: { name }, status: { updateStatus, runtimeStatus } })) });

  it("estimates progress from Tilt resource states and ignores disabled ones and the Tiltfile", () => {
    const progress = tiltProgress(ui([
      ["(Tiltfile)", "ok", "not_applicable"], ["postgres", "ok", "ok"], ["traefik", "ok", "ok"],
      ["golden-layers-build", "in_progress", "not_applicable"], ["api", "ok", "pending"], ["web", "pending", "pending"], ["disabled", "none", "none"],
    ]));
    assert.equal(progress.total, 5);
    assert.equal(progress.ready, 2);
    assert.equal(progress.percent, Math.round(((1 + 1 + 0.4 + 0.75 + 0) / 5) * 100));
    assert.match(progress.step, /Building golden-layers-build/);
  });

  it("reports 100% when all ready, flags errors, and survives junk", () => {
    assert.equal(tiltProgress(ui([["a", "ok", "ok"], ["b", "not_applicable", "ok"]])).percent, 100);
    assert.equal(tiltProgress(ui([["a", "ok", "ok"], ["b", "ok", "ok"]])).step, "All resources ready");
    const failed = tiltProgress(ui([["a", "error", "pending"], ["b", "ok", "ok"]]));
    assert.deepEqual(failed.errors, ["a"]);
    assert.match(failed.step, /Failed: a/);
    for (const junk of [null, 5, "x", [], {}, { items: "no" }, { items: [null, 1, { metadata: {} }, { metadata: { name: "x" }, status: "bad" }] }]) {
      const result = tiltProgress(junk);
      assert.equal(typeof result.percent, "number");
    }
  });

  const tiltFake = ({ ownerRoot, items, gate }) => async (project, args, options) => {
    if (options?.binary === "tilt" && args[1] === "tiltfile") return { status: 0, stdout: JSON.stringify({ items: [{ spec: { path: `${ownerRoot}/.tdk/.tdk-out/Tiltfile` } }] }), stderr: "" };
    if (options?.binary === "tilt") return { status: 0, stdout: JSON.stringify({ items }), stderr: "" };
    if (args[0] === "up" && gate) await gate;
    return okEnvelope({});
  };

  it("runs a background start as a job, reports progress, and refuses a second start meanwhile", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const items = [{ metadata: { name: "api" }, status: { updateStatus: "in_progress", runtimeStatus: "pending" } }];
    const { server } = await boot({ runCommand: tiltFake({ ownerRoot: "/projects/a", items, gate }) });
    const started = await post(server, "/api/actions", { project: "a", operation: "start", background: true });
    assert.equal(started.status, 202, started.text);
    assert.equal(started.json.job.state, "running");
    assert.equal(started.json.job.progress.percent, 40);
    assert.equal((await post(server, "/api/actions", { project: "a", operation: "start", background: true })).status, 409);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await raw(server, { path: "/api/jobs" });
    const job = after.json.jobs.find((entry) => entry.project === "a");
    assert.equal(job.state, "done");
    assert(job.elapsedMs >= 0);
  });

  it("does not attribute another project's Tilt progress", async () => {
    const items = [{ metadata: { name: "api" }, status: { updateStatus: "in_progress", runtimeStatus: "pending" } }];
    const { server } = await boot({ runCommand: tiltFake({ ownerRoot: "/projects/b", items }) });
    const started = await post(server, "/api/actions", { project: "a", operation: "start", background: true });
    assert.equal(started.json.job.progress, null, "Tilt belongs to project b");
  });

  it("lists a start the app did not launch as settling", async () => {
    const items = [{ metadata: { name: "api" }, status: { updateStatus: "ok", runtimeStatus: "pending" } }];
    const { server } = await boot({ runCommand: tiltFake({ ownerRoot: "/projects/b", items }) });
    const response = await raw(server, { path: "/api/jobs" });
    const external = response.json.jobs.find((job) => job.project === "b");
    assert(external, response.text);
    assert.equal(external.state, "settling");
    assert.equal(external.external, true);
    assert.equal(external.progress.percent, 75);
  });

  it("a failed background job reports its error", async () => {
    const { server } = await boot({ runCommand: async (_p, args, options) => (options?.binary === "tilt" ? { status: 1, stdout: "", stderr: "" } : args[0] === "up" ? { status: 1, stdout: "", stderr: "port 8080 in use" } : okEnvelope({})) });
    await post(server, "/api/actions", { project: "a", operation: "start", background: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const job = (await raw(server, { path: "/api/jobs" })).json.jobs.find((entry) => entry.project === "a");
    assert.equal(job.state, "failed");
    assert.match(job.message, /port 8080 in use/);
  });
});

describe("fast project list", () => {
  it("answers ?fast=1 at once with pending rows, then fills them in", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { server } = await boot({ runCommand: async (_p, args) => { if (args[0] === "status") await gate; return goodStatus; } });
    const first = await raw(server, { path: "/api/projects?fast=1" });
    assert.equal(first.status, 200);
    assert(first.json.projects.every((project) => project.pending === true));
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await raw(server, { path: "/api/projects?fast=1" });
    assert(second.json.projects.every((project) => !project.pending && project.resources.length === 1));
  });

  it("without fast=1 still waits for real statuses", async () => {
    const { server } = await boot();
    const response = await raw(server, { path: "/api/projects" });
    assert(response.json.projects.every((project) => !project.pending));
  });
});

describe("persistent UI state (pins, hidden, collapsed)", () => {
  const statePut = (server, body, extra) => post(server, "/api/state", body, { method: "PUT", ...extra });

  it("starts empty and never exposes known project roots", async () => {
    const { server } = await boot({ statePath: join(tempDir(), "state.json") });
    const response = await raw(server, { path: "/api/state" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { pins: { projects: [], resources: [] }, hidden: [], collapsed: [], closedStacks: [], aiInspect: false });
  });

  it("keeps AI inspect off unless it is explicitly saved as true", async () => {
    const path = join(tempDir(), "state.json");
    const { server } = await boot({ statePath: path });
    assert.equal((await statePut(server, { aiInspect: "yes" })).json.aiInspect, false);
    assert.equal((await statePut(server, { aiInspect: 1 })).json.aiInspect, false);
    assert.equal((await statePut(server, { aiInspect: true })).json.aiInspect, true);
    const second = await boot({ statePath: path });
    assert.equal((await raw(second.server, { path: "/api/state" })).json.aiInspect, true);
    assert.equal((await statePut(second.server, { aiInspect: false })).json.aiInspect, false);
  });

  it("saves pins to disk and a new server reads them back", async () => {
    const path = join(tempDir(), "nested", "state.json");
    const first = await boot({ statePath: path });
    const saved = await statePut(first.server, { pins: { projects: ["a"], resources: ["a/api"] }, hidden: ["b"], collapsed: ["doctor"] });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).pins, { projects: ["a"], resources: ["a/api"] });
    const second = await boot({ statePath: path });
    const reread = await raw(second.server, { path: "/api/state" });
    assert.deepEqual(reread.json.pins.resources, ["a/api"]);
    assert.deepEqual(reread.json.hidden, ["b"]);
  });

  it("cleans bad values, de-duplicates, caps sizes, and ignores knownRoots from the page", async () => {
    const path = join(tempDir(), "state.json");
    const { server } = await boot({ statePath: path });
    const response = await statePut(server, { pins: { projects: ["a", "a", 5, null, "", "x".repeat(500)], resources: "nope" }, hidden: Array.from({ length: 900 }, (_, i) => `p${i}`), knownRoots: ["/etc"] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.pins, { projects: ["a"], resources: [] });
    assert.equal(response.json.hidden.length, 500);
    assert.deepEqual(readAppState(path).knownRoots, []);
  });

  it("rejects non-object bodies, cross-origin writes and missing tokens", async () => {
    const { server } = await boot({ statePath: join(tempDir(), "state.json") });
    for (const body of ["[1]", "null", "\"x\"", "{bad"]) assert.equal((await statePut(server, body)).status, 400, body);
    assert.equal((await statePut(server, {}, { headers: {} })).status, 403);
    assert.equal((await statePut(server, {}, { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await raw(server, { path: "/api/state", auth: false })).status, 403);
  });

  it("survives a corrupt or missing state file and writes atomically", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    for (const content of ["", "{", "null", "[]", '{"pins":5}', '{"hidden":"x"}']) {
      writeFileSync(path, content);
      assert.deepEqual(readAppState(path), normalizeState(null), content);
    }
    assert.deepEqual(readAppState(join(dir, "missing.json")), normalizeState(null));
    assert.equal(writeAppState({ hidden: ["a"] }, path), true);
    assert.deepEqual(readdirSync(dir), ["state.json"], "no temp files left behind");
    assert.equal(writeAppState({}, "/definitely/not/writable/state.json"), false);
  });

  it("migrates the legacy state file when the default state path is missing", () => {
    const dir = tempDir();
    const legacyFile = join(dir, "pre-rename-state.json");
    writeFileSync(legacyFile, JSON.stringify({ hidden: ["old-pin"], knownRoots: ["/roots/shop"] }));
    const defaultFile = join(dir, "flisk-app-state.json"); // deliberately not written
    const saved = process.env.FLISK_APP_STATE;
    process.env.FLISK_APP_STATE = defaultFile;
    try {
      const state = readAppState(defaultFile, { legacy: [legacyFile] });
      assert.deepEqual(state.hidden, ["old-pin"]);
      assert.deepEqual(state.knownRoots, ["/roots/shop"]);
    } finally {
      if (saved === undefined) delete process.env.FLISK_APP_STATE;
      else process.env.FLISK_APP_STATE = saved;
    }
  });

  it("never migrates the legacy file into an explicit custom state path", () => {
    const dir = tempDir();
    const legacyFile = join(dir, "pre-rename-state.json");
    writeFileSync(legacyFile, JSON.stringify({ hidden: ["old-pin"] }));
    const state = readAppState(join(dir, "custom-state.json"), { legacy: [legacyFile] });
    assert.deepEqual(state, normalizeState(null));
  });

  it("does not resurrect the legacy file when the default state file is corrupt", () => {
    const dir = tempDir();
    const legacyFile = join(dir, "pre-rename-state.json");
    writeFileSync(legacyFile, JSON.stringify({ hidden: ["old-pin"] }));
    const defaultFile = join(dir, "flisk-app-state.json");
    writeFileSync(defaultFile, "{corrupt");
    const saved = process.env.FLISK_APP_STATE;
    process.env.FLISK_APP_STATE = defaultFile;
    try {
      assert.deepEqual(readAppState(defaultFile, { legacy: [legacyFile] }), normalizeState(null));
    } finally {
      if (saved === undefined) delete process.env.FLISK_APP_STATE;
      else process.env.FLISK_APP_STATE = saved;
    }
  });
});

describe("probeCli edge cases", () => {
  const run = (impl) => probeCli(async (_project, args) => impl(args));
  it("handles an execute that throws", async () => {
    await assert.rejects(() => run(() => { throw new Error("x"); }));
  });
  it("treats an empty version as unknown but not a crash", async () => {
    const result = await run((args) => (args[0] === "--version" ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: "Usage: tdk [options] [command]", stderr: "" }));
    assert.equal(result.lifecycle, false);
  });
  it("treats a timed-out version check (null status) as failed", async () => {
    const result = await run(() => ({ status: null, stdout: "", stderr: "" }));
    assert.equal(result.state, "failed");
  });
  it("does not match a lookalike command in help text", async () => {
    const result = await run((args) => (args[0] === "--version" ? { status: 0, stdout: "1.3.200\n", stderr: "" } : { status: 0, stdout: "Usage: tdk startup [options]", stderr: "" }));
    assert.equal(result.state, "unsupported");
  });
  it("handles garbage version strings", async () => {
    const result = await run((args) => (args[0] === "--version" ? { status: 0, stdout: "\u0000\n\n  \n", stderr: "" } : { status: 0, stdout: "", stderr: "" }));
    assert.equal(result.lifecycle, false);
  });
});

describe("runTdk process handling", () => {
  const node = process.execPath;
  const project = () => ({ root: tempDir() });

  it("resolves (never throws) when the binary does not exist", async () => {
    const result = await runTdk(project(), ["status"], { binary: "/definitely/not/a/tdk" });
    assert.equal(result.status, null);
    assert.match(result.stderr, /ENOENT/);
  });

  it("resolves when the project directory is gone", async () => {
    const result = await runTdk({ root: "/definitely/not/a/dir" }, ["--version"], { binary: node });
    assert.equal(result.status, null);
  });

  it("resolves when the binary is not executable", async () => {
    const directory = tempDir();
    const file = join(directory, "tdk");
    writeFileSync(file, "#!/bin/sh\n", { mode: 0o644 });
    const result = await runTdk({ root: directory }, [], { binary: file });
    assert.equal(result.status, null);
    assert.match(result.stderr, /EACCES/);
  });

  it("reports non-zero exit codes with their output", async () => {
    const result = await runTdk(project(), ["-e", "console.log('out');console.error('err');process.exit(3)"], { binary: node });
    assert.equal(result.status, 3);
    assert.equal(result.stdout.trim(), "out");
    assert.equal(result.stderr.trim(), "err");
  });

  it("kills a hung process at the timeout", async () => {
    const started = Date.now();
    const result = await runTdk(project(), ["-e", "setInterval(()=>{},1000)"], { binary: node, timeoutMs: 200 });
    assert.equal(result.status, null);
    assert(Date.now() - started < 5000);
  });

  it("kills a process that floods stdout", async () => {
    const result = await runTdk(project(), ["-e", "const b='x'.repeat(65536);setInterval(()=>process.stdout.write(b),1)"], { binary: node, timeoutMs: 20_000 });
    assert.equal(result.status, null);
    assert(result.stdout.length >= 2_000_000);
  });

  it("kills a process that floods stderr", async () => {
    const result = await runTdk(project(), ["-e", "const b='x'.repeat(65536);setInterval(()=>process.stderr.write(b),1)"], { binary: node, timeoutMs: 20_000 });
    assert.equal(result.status, null);
  });

  it("settles once even if the process errors after the timeout", async () => {
    const result = await runTdk(project(), ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { binary: node, timeoutMs: 150 });
    assert.equal(result.status, null);
  });

  it("handles a process that closes stdout early", async () => {
    const result = await runTdk(project(), ["-e", "process.stdout.end();setTimeout(()=>process.exit(0),50)"], { binary: node });
    assert.equal(result.status, 0);
  });

  it("copes with invalid UTF-8 output", async () => {
    const result = await runTdk(project(), ["-e", "process.stdout.write(Buffer.from([0xff,0xfe,0x80]))"], { binary: node });
    assert.equal(result.status, 0);
    assert.equal(typeof result.stdout, "string");
  });

  it("ignores a corrupt saved tilt port file", async () => {
    for (const content of ["", "{", "null", "[]", '{"port":"80"}', '{"port":-1}', '{"port":70000}', '{"port":1.5}', '{"port":null}']) {
      const directory = tempDir();
      mkdirSync(join(directory, ".tdk", ".tdk-out"), { recursive: true });
      writeFileSync(join(directory, ".tdk", ".tdk-out", "tilt-port.json"), content);
      const result = await runTdk({ root: directory }, ["-e", "console.log(process.env.TILT_PORT ?? 'none')"], { binary: node });
      assert.equal(result.stdout.trim(), "none", `port file ${JSON.stringify(content)}`);
    }
  });

  it("passes a valid saved tilt port through", async () => {
    const directory = tempDir();
    mkdirSync(join(directory, ".tdk", ".tdk-out"), { recursive: true });
    writeFileSync(join(directory, ".tdk", ".tdk-out", "tilt-port.json"), '{"port":10350}');
    const result = await runTdk({ root: directory }, ["-e", "console.log(process.env.TILT_PORT)"], { binary: node });
    assert.equal(result.stdout.trim(), "10350");
  });

  it("does not interpret arguments through a shell", async () => {
    const marker = join(tempDir(), "pwned");
    const result = await runTdk(project(), ["-e", "console.log(process.argv[1])", `; touch ${marker}`], { binary: node });
    assert.equal(result.status, 0);
    assert.throws(() => rmSync(marker), /ENOENT/);
  });

  it("a detached child keeps running after its parent is killed", async () => {
    const dir = tempDir();
    const marker = join(dir, "alive");
    const childCode = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "yes"), 600)`;
    const script = `const { runTdk } = await import(${JSON.stringify(new URL("../src/app.js", import.meta.url).href)}); runTdk({ root: ${JSON.stringify(dir)} }, ["-e", ${JSON.stringify(childCode)}], { binary: process.execPath, detached: true }); setTimeout(() => process.exit(0), 100);`;
    const { spawnSync } = await import("node:child_process");
    spawnSync(process.execPath, ["--input-type=module", "-e", script]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(existsSync(marker), true, "detached command finished after the parent exited");
  });

  it("copes with many parallel invocations", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => runTdk(project(), ["-e", "console.log(1)"], { binary: node })));
    assert(results.every((result) => result.status === 0));
  });
});

describe("project discovery edge cases", () => {
  const makeProject = (root, name = "p", content) => {
    mkdirSync(join(root, ".tdk"), { recursive: true });
    writeFileSync(join(root, ".tdk", "project.json"), content ?? JSON.stringify({ project: { name } }));
  };

  it("ignores scan roots that do not exist or are files", () => {
    const directory = tempDir();
    writeFileSync(join(directory, "file"), "x");
    assert.deepEqual(discoverProjects({ currentRoot: null, scanRoots: ["/nope/nope", join(directory, "file"), ""] }), []);
  });

  it("does not follow symlink loops", () => {
    const directory = tempDir();
    mkdirSync(join(directory, "a"));
    symlinkSync(directory, join(directory, "a", "loop"));
    symlinkSync(join(directory, "a"), join(directory, "self"));
    assert.deepEqual(discoverProjects({ currentRoot: null, scanRoots: [directory] }), []);
  });

  it("stops at the depth limit", () => {
    const directory = tempDir();
    let deep = directory;
    for (let index = 0; index < 12; index += 1) deep = join(deep, `d${index}`);
    makeProject(deep);
    assert.deepEqual(discoverProjects({ currentRoot: null, scanRoots: [directory], maxDepth: 8 }), []);
    assert.equal(discoverProjects({ currentRoot: null, scanRoots: [directory], maxDepth: 20 }).length, 1);
  });

  it("stops at the directory and project caps", () => {
    const directory = tempDir();
    for (let index = 0; index < 30; index += 1) makeProject(join(directory, `p${String(index).padStart(2, "0")}`), `p${index}`);
    assert.equal(discoverProjects({ currentRoot: null, scanRoots: [directory], maxProjects: 5 }).length, 5);
    assert(discoverProjects({ currentRoot: null, scanRoots: [directory], maxDirectoriesPerRoot: 4 }).length <= 4);
  });

  it("falls back to the folder name for broken project.json files", () => {
    const directory = tempDir();
    const cases = ["", "{", "null", "[]", '"x"', "42", '{"project":null}', '{"project":{"name":5}}', '{"project":{"name":["a"]}}'];
    cases.forEach((content, index) => makeProject(join(directory, `case-${index}`), "x", content));
    const found = discoverProjects({ currentRoot: null, scanRoots: [directory] });
    assert.equal(found.length, cases.length);
    for (const project of found) assert.match(project.name, /^case-\d+$/);
  });

  it("de-duplicates the same project selected twice", () => {
    const directory = tempDir();
    makeProject(directory);
    assert.equal(discoverProjects({ currentRoot: directory, projectRoots: [directory, `${directory}/`, join(directory, ".", "")], scanRoots: [directory, directory] }).length, 1);
  });

  it("gives every project a distinct, stable id", () => {
    const directory = tempDir();
    for (const name of ["a", "b", "c"]) makeProject(join(directory, name));
    const first = discoverProjects({ currentRoot: null, scanRoots: [directory] });
    const second = discoverProjects({ currentRoot: null, scanRoots: [directory] });
    assert.deepEqual(first.map((project) => project.id), second.map((project) => project.id));
    assert.equal(new Set(first.map((project) => project.id)).size, 3);
  });

  it("rejects relative or missing explicit project roots", () => {
    assert.throws(() => resolveProjects(null, ["/definitely/missing"]), /Not a Flisk project directory/);
    assert.throws(() => resolveProjects(null, [""]), /Not a Flisk project directory/);
  });

  it("skips unreadable directories without throwing", () => {
    const directory = tempDir();
    mkdirSync(join(directory, "locked"));
    makeProject(join(directory, "open"));
    try { process.chmod?.call(process, 0); } catch {}
    rmSync(join(directory, "locked"), { recursive: true });
    assert.equal(discoverProjects({ currentRoot: null, scanRoots: [directory] }).length, 1);
  });
});

describe("server lifecycle", () => {
  it("refuses non-loopback hosts", () => {
    for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.5", ""]) {
      assert.throws(() => startAppServer({ projects, host }), /127\.0\.0\.1/);
    }
  });

  it("fails cleanly when the port is already taken", async () => {
    const { server } = await boot();
    const { port } = server.address();
    // Node puts the code in the message, Bun only on the error, so check the code.
    await assert.rejects(() => startAppServer({ projects, port }), (error) => error.code === "EADDRINUSE");
    await assertAlive(server);
  });

  it("rejects out-of-range ports", async () => {
    await assert.rejects(() => startAppServer({ projects, port: 70000 }));
  });

  it("starts with zero projects", async () => {
    const { server } = await boot({ projects: [] });
    const response = await raw(server, { path: "/api/projects" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.projects, []);
  });

  it("keeps serving after an error in a handler", async () => {
    let calls = 0;
    const { server } = await boot({ runCommand: async () => { if (++calls <= 2) throw new Error("transient"); return goodStatus; } });
    await raw(server, { path: "/api/logs?project=a&resource=x" });
    await raw(server, { path: "/api/logs?project=a&resource=x" });
    assert.equal((await raw(server, { path: "/api/projects" })).status, 200);
  });

  it("never sends the token in an API error body", async () => {
    const { server } = await boot();
    const response = await raw(server, { path: "/api/nope" });
    assert(!response.text.includes(TOKEN));
  });

  it("sets hardening headers on the page", async () => {
    const { server } = await boot();
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/?token=${TOKEN}`);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
