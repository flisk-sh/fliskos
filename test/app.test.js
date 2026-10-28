import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { TOOL_COMMANDS, cliBinaryCandidates, commonProjectScanRoots, discoverProjectRoot, discoverProjects, findClaudeDesktopApp, normalizeState, probeCli, projectFile, resolveProjects, resolveTdkBinary, startAppServer, startupScanRoots } from "../src/app.js";

const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectFixture(name) {
  const root = mkdtempSync(join(tmpdir(), "flisk-app-test-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".tdk"), { recursive: true });
  writeFileSync(join(root, ".tdk", "project.json"), JSON.stringify({ project: { name } }));
  return root;
}

async function serverFor(options) {
  const started = await startAppServer({ port: 0, token: "test-session-token", dockerCheck: async () => true, ...options });
  servers.push(started.server);
  return started;
}

const supported = { state: "supported", lifecycle: true, version: "1.3.145", minVersion: "1.3.145", installUrl: "https://example.test", message: null };

function fakeCli({ version = "1.3.145", commands = ["up", "down"], versionStatus = 0, versionStderr = "", program = "flisk" } = {}) {
  const calls = [];
  const execute = async (_project, args) => {
    calls.push(args);
    if (args[0] === "--version") return { status: versionStatus, stdout: versionStatus ? "" : `${version}\n`, stderr: versionStderr };
    const known = commands.includes(args[0]);
    const alias = args[0] === "up" ? "up|deploy" : args[0];
    return { status: 0, stderr: "", stdout: known ? `Usage: ${program} ${alias} [options]\n` : `Usage: ${program} [options] [command]\n` };
  };
  return { execute, calls };
}

describe("CLI capability probe", () => {
  it("reports lifecycle support for a capable CLI", async () => {
    const { execute } = fakeCli();
    const result = await probeCli(execute);
    assert.equal(result.state, "supported");
    assert.equal(result.lifecycle, true);
    assert.equal(result.version, "1.3.145");
  });

  it("accepts 1.3.144 because it has flisk up and flisk down", async () => {
    const result = await probeCli(fakeCli({ version: "1.3.144" }).execute);
    assert.equal(result.lifecycle, true);
  });

  it("reports stable 1.3.140 as unsupported with an actionable message", async () => {
    const { execute } = fakeCli({ version: "1.3.140", commands: [] });
    const result = await probeCli(execute);
    assert.equal(result.state, "unsupported");
    assert.equal(result.lifecycle, false);
    assert.match(result.message, /1\.3\.140.*Update the CLI/);
  });

  it("reports a missing binary and a failing version check separately", async () => {
    const missing = await probeCli(fakeCli({ versionStatus: 1, versionStderr: "spawn tdk ENOENT" }).execute);
    assert.equal(missing.state, "missing");
    assert.match(missing.message, /TDK_BIN/);
    const failing = await probeCli(fakeCli({ versionStatus: 1 }).execute);
    assert.equal(failing.state, "failed");
    assert.equal(failing.lifecycle, false);
  });

  it("only runs read-only probe commands", async () => {
    const { execute, calls } = fakeCli();
    await probeCli(execute);
    assert(calls.every((args) => args.includes("--version") || args.includes("--help")));
  });

  it("falls through a version-answering but incapable CLI to a capable one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flisk-app-probe-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "flisk"), "");
    writeFileSync(join(dir, "tdk"), "");
    const savedPath = process.env.PATH;
    const savedFliskBin = process.env.FLISK_BIN;
    const savedTdkBin = process.env.TDK_BIN;
    process.env.PATH = dir;
    delete process.env.FLISK_BIN;
    delete process.env.TDK_BIN;
    try {
      const probed = [];
      const result = await probeCli(async (_probe, args, options = {}) => {
        const binary = options.binary ?? "";
        probed.push(binary);
        const capable = binary.endsWith("/tdk");
        if (args[0] === "--version") return { status: 0, stdout: "1.3.204\n", stderr: "" };
        const program = capable ? "tdk" : "flisk";
        const usage = capable ? `Usage: ${program} ${args[0]} [options]\n` : `Usage: ${program} [options] [command]\n`;
        return { status: 0, stdout: usage, stderr: "" };
      });
      assert.equal(result.state, "supported");
      assert.equal(result.lifecycle, true);
      assert.equal(result.version, "1.3.204");
      assert.equal(result.program, "tdk");
      assert.ok(probed.some((binary) => binary.endsWith("/flisk")), "the incapable flisk was probed first");
      assert.ok(probed.some((binary) => binary.endsWith("/tdk")), "the capable tdk was probed");
    } finally {
      process.env.PATH = savedPath;
      if (savedFliskBin === undefined) delete process.env.FLISK_BIN;
      else process.env.FLISK_BIN = savedFliskBin;
      if (savedTdkBin === undefined) delete process.env.TDK_BIN;
      else process.env.TDK_BIN = savedTdkBin;
    }
  });
});

describe("CLI binary discovery", () => {
  it("prefers the current flisk binary over the legacy tdk alias", () => {
    const dir = mkdtempSync(join(tmpdir(), "flisk-app-bin-"));
    tempDirs.push(dir);
    for (const name of ["flisk", "tdk"]) writeFileSync(join(dir, name), "");
    const candidates = cliBinaryCandidates({ PATH: dir });
    const fliskIndex = candidates.indexOf(join(dir, "flisk"));
    const tdkIndex = candidates.indexOf(join(dir, "tdk"));
    assert.ok(fliskIndex >= 0, "flisk is discovered");
    assert.ok(tdkIndex >= 0, "tdk is discovered");
    assert.ok(fliskIndex < tdkIndex, "flisk comes first");
  });

  it("finds a legacy tdk-only install", () => {
    const dir = mkdtempSync(join(tmpdir(), "flisk-app-bin-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "tdk"), "");
    const candidates = cliBinaryCandidates({ PATH: dir });
    assert.ok(candidates.includes(join(dir, "tdk")));
  });

  it("honours an explicit FLISK_BIN path over anything on PATH", () => {
    assert.equal(resolveTdkBinary({ FLISK_BIN: "/opt/custom/flisk", PATH: "/usr/bin" }), "/opt/custom/flisk");
    assert.equal(resolveTdkBinary({ TDK_BIN: "/opt/custom/tdk", PATH: "/usr/bin" }), "/opt/custom/tdk");
  });

  it("prefers FLISK_BIN over TDK_BIN when both are set", () => {
    assert.equal(resolveTdkBinary({ FLISK_BIN: "/opt/new/flisk", TDK_BIN: "/opt/old/tdk", PATH: "" }), "/opt/new/flisk");
  });
});

describe("CLI capability probe naming", () => {
  it("detects the flisk CLI and enables lifecycle", async () => {
    const { execute, calls } = fakeCli({ version: "1.3.204" });
    const result = await probeCli(execute);
    assert.equal(result.state, "supported");
    assert.equal(result.lifecycle, true);
    assert.equal(result.program, "flisk");
    assert.equal(result.label, "Flisk CLI");
    // The CLI prints "Usage: flisk up|deploy ..."; the alias list must still answer `up`.
    assert.ok(calls.some((args) => args[0] === "up" && args[1] === "--help"));
  });

  it("still accepts the legacy tdk CLI name", async () => {
    const result = await probeCli(fakeCli({ program: "tdk" }).execute);
    assert.equal(result.state, "supported");
    assert.equal(result.program, "tdk");
    assert.equal(result.label, "TDK CLI");
  });

  it("names the CLI it found in the unsupported message", async () => {
    const result = await probeCli(fakeCli({ commands: [] }).execute);
    assert.equal(result.state, "unsupported");
    assert.match(result.message, /Flisk CLI 1\.3\.145 does not support `flisk up\/down`/);
  });
});

describe("FliskOS local server", () => {
  it("rejects lifecycle actions without spawning a mutating command when unsupported", async () => {
    const calls = [];
    const runCommand = async (_project, args) => {
      calls.push(args);
      if (args[0] === "--version") return { status: 0, stdout: "1.3.140\n", stderr: "" };
      return { status: 0, stderr: "", stdout: "Usage: flisk [options] [command]\n" };
    };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand });
    const origin = new URL(started.url).origin;
    const headers = { "content-type": "application/json", origin, "x-flisk-token": started.token };
    const cliState = await (await fetch(`${origin}/api/cli`, { headers })).json();
    assert.equal(cliState.lifecycle, false);
    const response = await fetch(`${origin}/api/actions`, { method: "POST", headers, body: JSON.stringify({ project: "a", operation: "start" }) });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "cli_unsupported");
    assert.match(body.error, /Update the CLI/);
    assert(!calls.some((args) => args.includes("--json")));
  });

  it("runs lifecycle actions when the installed CLI reports itself as flisk", async () => {
    const calls = [];
    const runCommand = async (_project, args) => {
      calls.push(args);
      if (args[0] === "--version") return { status: 0, stdout: "1.3.204\n", stderr: "" };
      if (args[0] === "up") return { status: 0, stderr: "", stdout: "Usage: flisk up|deploy [options]\n" };
      if (args[0] === "down") return { status: 0, stderr: "", stdout: "Usage: flisk down [options]\n" };
      return { status: 0, stderr: "", stdout: "Usage: flisk [options] [command]\n" };
    };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand, dockerCheck: async () => true });
    const origin = new URL(started.url).origin;
    const headers = { "content-type": "application/json", origin, "x-flisk-token": started.token };
    const cliState = await (await fetch(`${origin}/api/cli`, { headers })).json();
    assert.equal(cliState.lifecycle, true);
    assert.equal(cliState.program, "flisk");
    const response = await fetch(`${origin}/api/actions`, { method: "POST", headers, body: JSON.stringify({ project: "a", operation: "start", background: true }) });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(calls.some((args) => args[0] === "up" && args.includes("--json")));
  });

  it("refuses non-loopback binds", async () => {
    assert.throws(() => startAppServer({ projects: [], host: "0.0.0.0" }), /only bind to 127\.0\.0\.1/);
  });

  it("discovers the nearest project and validates explicitly selected roots", () => {
    const root = projectFixture("shop");
    const nested = join(root, "src", "api");
    mkdirSync(nested, { recursive: true });
    assert.equal(discoverProjectRoot(nested), root);
    assert.equal(resolveProjects(root, [root]).length, 1);
    assert.throws(() => resolveProjects(null, [join(root, "missing")]), /Not a Flisk project directory/);
  });

  it("finds projects below scan roots and skips dependency folders", () => {
    const root = mkdtempSync(join(tmpdir(), "flisk-app-scan-"));
    tempDirs.push(root);
    const project = join(root, "workspace", "project");
    mkdirSync(join(project, ".tdk"), { recursive: true });
    writeFileSync(join(project, ".tdk", "project.json"), JSON.stringify({ project: { name: "workspace-project" } }));
    const ignored = join(root, "node_modules", "example");
    mkdirSync(join(ignored, ".tdk"), { recursive: true });
    writeFileSync(join(ignored, ".tdk", "project.json"), JSON.stringify({ project: { name: "ignored" } }));

    const projects = discoverProjects({ currentRoot: null, scanRoots: [root] });
    assert.deepEqual(projects.map((entry) => entry.root), [project]);
    assert(commonProjectScanRoots("/Users/example").includes("/var/www"));
  });

  it("finds current .flisk projects next to legacy .tdk ones and reads their names", () => {
    const root = mkdtempSync(join(tmpdir(), "flisk-app-scan-"));
    tempDirs.push(root);
    const current = join(root, "current");
    mkdirSync(join(current, ".flisk"), { recursive: true });
    writeFileSync(join(current, ".flisk", "project.json"), JSON.stringify({ project: { name: "current-shop" } }));
    const legacy = join(root, "legacy");
    mkdirSync(join(legacy, ".tdk"), { recursive: true });
    writeFileSync(join(legacy, ".tdk", "project.json"), JSON.stringify({ project: { name: "legacy-shop" } }));

    const projects = discoverProjects({ currentRoot: null, scanRoots: [root] });
    assert.deepEqual(projects.map((entry) => [entry.name, entry.root]), [["current-shop", current], ["legacy-shop", legacy]]);
    const nested = join(current, "services", "api");
    mkdirSync(nested, { recursive: true });
    assert.equal(discoverProjectRoot(nested), current);
    assert.equal(projectFile(current), join(current, ".flisk", "project.json"));
    assert.equal(projectFile(join(root, "missing")), null);
  });

  it("registers a .flisk project through Open project", async () => {
    const root = mkdtempSync(join(tmpdir(), "fliskos-open-test-"));
    tempDirs.push(root);
    mkdirSync(join(root, ".flisk"), { recursive: true });
    writeFileSync(join(root, ".flisk", "project.json"), JSON.stringify({ project: { name: "opened" } }));
    const { server } = await serverFor({ projects: [], probe: async () => supported, runCommand: async () => ({ status: 0, stdout: "{}", stderr: "" }) });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/add`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flisk-token": "test-session-token", origin: `http://127.0.0.1:${server.address().port}` },
      body: JSON.stringify({ path: root }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.project.name, "opened");
  });

  it("reaches shallow projects before a large sibling tree exhausts the directory cap", () => {
    const root = mkdtempSync(join(tmpdir(), "flisk-app-scan-"));
    tempDirs.push(root);
    const project = join(root, "a-project");
    mkdirSync(join(project, ".tdk"), { recursive: true });
    writeFileSync(join(project, ".tdk", "project.json"), JSON.stringify({ project: { name: "shallow" } }));
    for (let index = 0; index < 20; index += 1) mkdirSync(join(root, "z-large", `dir-${index}`), { recursive: true });

    const projects = discoverProjects({ currentRoot: null, scanRoots: [root], maxDirectoriesPerRoot: 10 });
    assert.deepEqual(projects.map((entry) => entry.root), [project]);
  });

  it("returns project status and port conflicts from CLI JSON", async () => {
    const projects = [
      { id: "a", name: "a", root: "/projects/a" },
      { id: "b", name: "b", root: "/projects/b" },
    ];
    const runCommand = async (project, args) => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: args[0] === "status"
          ? { resources: [{ name: "api", stack: "shop", type: "backend", status: "ready" }], stacks: [{ name: "shop" }], ports: [{ name: "api", hostPort: 8080 }], tilt: { resources: { items: [{ metadata: { name: "api" } }] } } }
          : { services: [{ name: "api", url: "http://localhost:8080" }] },
      }),
    });
    const started = await serverFor({ projects, runCommand });
    const pageResponse = await fetch(started.url);
    assert.equal(pageResponse.status, 200);
    const pageText = await pageResponse.text();
    assert.match(pageText, /<script src="\/app\.js" defer><\/script>/);
    assert.match(pageText, /<script src="\/inspect\.js" defer><\/script>/);
    const scriptResponse = await fetch(new URL("/app.js", started.url));
    assert.equal(scriptResponse.status, 200);
    assert.match(await scriptResponse.text(), /function refreshData/);
    const inspectResponse = await fetch(new URL("/inspect.js", started.url));
    assert.equal(inspectResponse.status, 200);
    assert.match(inspectResponse.headers.get("content-type"), /text\/javascript/);
    assert.match(await inspectResponse.text(), /const FLISK_INSPECT/);
    const response = await fetch(new URL("/api/projects", started.url), {
      headers: { "x-flisk-token": started.token },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.projects[0].resources[0].url, "http://localhost:8080/");
    assert.deepEqual(body.projects[0].conflicts, [{
      port: 8080,
      claimants: [
        { label: "a (api)", path: "/projects/a" },
        { label: "b (api)", path: "/projects/b" },
      ],
    }]);
  });

  it("gives bring-your-own resources a direct endpoint from directUrl or their declared port", async () => {
    const runCommand = async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: {
          resources: [
            { name: "sourcing-api", stack: "sourcing", type: "bring-your-own", port: 4002, url: null, directUrl: "http://localhost:4002", status: "unknown" },
            { name: "searxng", stack: "sourcing", type: "bring-your-own", port: 4005, url: null, status: "unknown" },
            { name: "jobs", stack: "sourcing", type: "worker", port: null, url: null, status: "unknown" },
          ],
          stacks: [],
          ports: [],
        },
      }),
    });
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand });
    const origin = new URL(started.url).origin;
    const body = await (await fetch(`${origin}/api/projects`, { headers: { "x-flisk-token": started.token } })).json();
    const [api, search, jobs] = body.projects[0].resources;
    assert.equal(api.url, "http://localhost:4002/");
    assert.equal(search.url, "http://localhost:4005/");
    assert.equal(jobs.url, null);
  });

  it("routes scoped actions through the installed Flisk CLI", async () => {
    const project = { id: "a", name: "a", root: "/projects/a" };
    const calls = [];
    const runCommand = async (_project, args) => {
      calls.push(args);
      return { status: 0, stderr: "", stdout: JSON.stringify({ data: { operation: "restart" } }) };
    };
    const started = await serverFor({ projects: [project], runCommand, probe: async () => supported });
    const origin = new URL(started.url).origin;
    const response = await fetch(`${origin}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-flisk-token": started.token },
      body: JSON.stringify({ project: "a", operation: "start", stack: "shop", resources: ["api"] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["up", "--json", "shop", "--only", "api"]]);
  });

  it("maps whole-project stop and restart to flisk down / flisk up and refuses scoped ones", async () => {
    const calls = [];
    const runCommand = async (_project, args) => { calls.push(args); return { status: 0, stderr: "", stdout: JSON.stringify({ data: {} }) }; };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand, probe: async () => supported });
    const origin = new URL(started.url).origin;
    const send = (body) => fetch(`${origin}/api/actions`, { method: "POST", headers: { "content-type": "application/json", origin, "x-flisk-token": started.token }, body: JSON.stringify(body) });
    assert.equal((await send({ project: "a", operation: "stop" })).status, 200);
    assert.deepEqual(calls.splice(0), [["down", "--json", "--force"]]);
    assert.equal((await send({ project: "a", operation: "restart" })).status, 200);
    assert.deepEqual(calls.splice(0), [["down", "--json", "--force"], ["up", "--json"]]);
    assert.equal((await send({ project: "a", operation: "stop", stack: "shop" })).status, 400);
    assert.equal((await send({ project: "a", operation: "restart", resources: ["api"] })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("creates an agent resource through flisk resource and rejects unknown types", async () => {
    const calls = [];
    const runCommand = async (_project, args) => { calls.push(args); return { status: 0, stderr: "", stdout: JSON.stringify({ data: {} }) }; };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand, probe: async () => supported });
    const origin = new URL(started.url).origin;
    const send = (body) => fetch(`${origin}/api/resources`, { method: "POST", headers: { "content-type": "application/json", origin, "x-flisk-token": started.token }, body: JSON.stringify(body) });
    assert.equal((await send({ project: "a", name: "bot", type: "agent" })).status, 200);
    assert.deepEqual(calls.splice(0), [["resource", "bot", "--type", "agent", "--yes"]]);
    assert.equal((await send({ project: "a", name: "bot", type: "nope" })).status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("tools panel", () => {
  it("runs only the fixed argv for each allowlisted tool and rejects anything else", async () => {
    const calls = [];
    const runCommand = async (_project, args) => { calls.push(args); return { status: 0, stderr: "", stdout: "ok" }; };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand });
    const origin = new URL(started.url).origin;
    const send = (body) => fetch(`${origin}/api/tools`, { method: "POST", headers: { "content-type": "application/json", origin, "x-flisk-token": started.token }, body: JSON.stringify(body) });
    assert.equal((await send({ project: "a", tool: "doctor-fix-preview" })).status, 200);
    assert.equal((await send({ project: "a", tool: "doctor-fix-apply" })).status, 200);
    assert.equal((await send({ project: "a", tool: "up-preview" })).status, 200);
    assert.equal((await send({ project: "a", tool: "down-preview" })).status, 200);
    assert.equal((await send({ project: "a", tool: "runtime-check-assets" })).status, 200);
    assert.deepEqual(calls.splice(0), [
      ["doctor", "--fix", "--dry-run"],
      ["doctor", "--fix", "--yes"],
      ["up", "--dry-run"],
      ["down", "--dry-run"],
      ["runtime", "--check-assets"],
    ]);
    assert.equal((await send({ project: "a", tool: "infra-enable", service: "elk" })).status, 200);
    assert.equal((await send({ project: "a", tool: "infra-disable", service: "verdaccio" })).status, 200);
    assert.deepEqual(calls.splice(0), [["config", "enable-infra", "elk"], ["config", "disable-infra", "verdaccio"]]);
    assert.equal((await send({ project: "a", tool: "rm -rf" })).status, 400);
    assert.equal((await send({ project: "a", tool: "infra-enable", service: "--force" })).status, 400);
    assert.equal((await send({ project: "missing", tool: "up-preview" })).status, 400);
    assert.equal(calls.length, 0);
    assert.ok(Object.keys(TOOL_COMMANDS).every((key) => Array.isArray(TOOL_COMMANDS[key].argv)));
  });
});

describe("persistent UI state", () => {
  it("keeps closed stacks across launches", () => {
    const state = normalizeState({ closedStacks: ["proj/core", 42, "proj/jobs"] });
    assert.deepEqual(state.closedStacks, ["proj/core", "proj/jobs"]);
  });
});

describe("scan folders", () => {
  function folderOfProjects() {
    const folder = mkdtempSync(join(tmpdir(), "fliskos-scan-folder-"));
    tempDirs.push(folder);
    for (const name of ["shop", "blog"]) {
      mkdirSync(join(folder, name, ".flisk"), { recursive: true });
      writeFileSync(join(folder, name, ".flisk", "project.json"), JSON.stringify({ project: { name } }));
    }
    return realpathSync(folder);
  }

  async function serve(statePath, projects = []) {
    const { server } = await serverFor({ projects, statePath, probe: async () => supported, runCommand: async () => ({ status: 1, stdout: "", stderr: "" }) });
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (path, body, method = body ? "POST" : "GET") => {
      const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "x-flisk-token": "test-session-token", origin: base }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
  }

  it("keeps saved scan folders in the state file, up to twenty", () => {
    const many = Array.from({ length: 30 }, (_, index) => `/code/${index}`);
    assert.deepEqual(normalizeState({ scanRoots: ["/a", 1, "/a", "/b"] }).scanRoots, ["/a", "/b"]);
    assert.equal(normalizeState({ scanRoots: many }).scanRoots.length, 20);
    assert.deepEqual(normalizeState(null).scanRoots, []);
  });

  it("scans the common folders and the saved ones at startup, and only --scan-root with --no-scan", () => {
    const state = normalizeState({ scanRoots: ["/Users/example/tdk-pr-work"] });
    const roots = startupScanRoots({ scan: true, extra: ["/extra"], state, home: "/Users/example" });
    assert(roots.includes("/Users/example/src"));
    assert.deepEqual(roots.slice(-2), ["/Users/example/tdk-pr-work", "/extra"]);
    assert.deepEqual(startupScanRoots({ scan: false, extra: ["/extra"], state, home: "/Users/example" }), ["/extra"]);
  });

  it("saves a folder of projects through Open project, lists them, and stops scanning it on request", async () => {
    const folder = folderOfProjects();
    const statePath = join(mkdtempSync(join(tmpdir(), "fliskos-scan-state-")), "state.json");
    tempDirs.push(dirname(statePath));
    const call = await serve(statePath);

    const added = await call("/api/projects/add", { path: folder });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.scanFolder, { path: folder, found: 2, added: 2 });
    assert.deepEqual(added.body.projects.map((project) => project.name), ["blog", "shop"]);
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(saved.scanRoots, [folder]);
    assert.deepEqual(saved.knownRoots, [join(folder, "blog"), join(folder, "shop")]);
    assert.deepEqual((await call("/api/state")).body.scanRoots, [folder]);
    assert.equal((await call("/api/meta")).body.roots[0], folder);

    const again = await call("/api/projects/add", { path: folder });
    assert.deepEqual(again.body.scanFolder, { path: folder, found: 2, added: 0 });
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).scanRoots, [folder]);

    // The page saves its own state with PUT; that must not drop or replace the scan folders.
    await call("/api/state", { pins: { projects: ["p1"], resources: [] }, scanRoots: [], knownRoots: [] }, "PUT");
    const afterPut = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(afterPut.scanRoots, [folder]);
    assert.equal(afterPut.knownRoots.length, 2);
    assert.deepEqual(afterPut.pins.projects, ["p1"]);

    assert.deepEqual(await call("/api/scan-folders/remove", { path: folder }), { status: 200, body: { ok: true, scanRoots: [] } });
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).scanRoots, []);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).knownRoots.length, 2, "projects already listed stay");
    assert.equal((await call("/api/scan-folders/remove", { path: folder })).status, 404);
  });

  it("still opens a single project, and refuses a folder with no project in or below it", async () => {
    const folder = folderOfProjects();
    const call = await serve(null);
    const single = await call("/api/projects/add", { path: join(folder, "shop") });
    assert.equal(single.status, 200);
    assert.equal(single.body.project.name, "shop");
    assert.equal(single.body.scanFolder, undefined);
    assert.equal((await call("/api/state")).body.scanRoots.length, 0);
    const empty = mkdtempSync(join(tmpdir(), "fliskos-empty-"));
    tempDirs.push(empty);
    const refused = await call("/api/projects/add", { path: empty });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /No Flisk project in that folder or below it/);
    assert.equal((await call("/api/scan-folders/remove", { path: "" })).status, 400);
  });
});

describe("Build with AI", () => {
  it("finds the Claude app only on macOS, in /Applications or ~/Applications", () => {
    const home = "/Users/someone";
    assert.equal(findClaudeDesktopApp("linux", () => true, home), null);
    assert.equal(findClaudeDesktopApp("darwin", () => false, home), null);
    assert.equal(findClaudeDesktopApp("darwin", (path) => path === "/Applications/Claude.app", home), "/Applications/Claude.app");
    assert.equal(findClaudeDesktopApp("darwin", (path) => path === "/Users/someone/Applications/Claude.app", home), "/Users/someone/Applications/Claude.app");
  });

  it("opens the starter prompt in the Claude app when it is installed", async () => {
    const opened = [];
    const started = await serverFor({ projects: [], claudeDesktopApp: () => "/Applications/Claude.app", openAiApp: async (app, prompt) => { opened.push([app, prompt]); } });
    const response = await fetch(new URL("/api/ai/build", started.url), {
      method: "POST",
      headers: { "x-flisk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build an app with Flisk" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, opened: "claude-desktop" });
    assert.deepEqual(opened, [["/Applications/Claude.app", "Build an app with Flisk"]]);
  });

  it("reports no desktop app, so the client shows the web chats, and opens nothing", async () => {
    const opened = [];
    const started = await serverFor({ projects: [], claudeDesktopApp: () => null, openAiApp: async () => { opened.push(true); } });
    const response = await fetch(new URL("/api/ai/build", started.url), {
      method: "POST",
      headers: { "x-flisk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build an app with Flisk" }),
    });
    assert.deepEqual(await response.json(), { ok: true, opened: null });
    assert.equal(opened.length, 0);
  });

  it("refuses an empty or oversized prompt", async () => {
    const started = await serverFor({ projects: [], claudeDesktopApp: () => "/Applications/Claude.app", openAiApp: async () => {} });
    for (const body of [{ prompt: "" }, { prompt: "x".repeat(14_337) }]) {
      const response = await fetch(new URL("/api/ai/build", started.url), {
        method: "POST",
        headers: { "x-flisk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  });
});

describe("Build with AI failures and token savings in the projects API", () => {
  it("returns an error when the Claude app fails to open, so the client falls back to the web chats", async () => {
    const started = await serverFor({ projects: [], claudeDesktopApp: () => "/Applications/Claude.app", openAiApp: async () => { throw new Error("open exited with code 1"); } });
    const response = await fetch(new URL("/api/ai/build", started.url), {
      method: "POST",
      headers: { "x-flisk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build an app with Flisk" }),
    });
    assert.equal(response.status, 500);
  });

  it("adds tokens to a project once measured, and leaves them out while the status is pending", async () => {
    const root = projectFixture("shop");
    writeFileSync(join(root, "Tiltfile"), "x".repeat(40));
    const runCommand = async (_project, args) => ({ status: 0, stderr: "", stdout: JSON.stringify({ data: args[0] === "status" ? { resources: [], stacks: [], ports: [], tilt: {} } : { services: [] } }) });
    const started = await serverFor({ projects: [{ id: "shop", name: "shop", root }], runCommand, dockerCheck: async () => true });
    const headers = { "x-flisk-token": started.token };
    const pending = await (await fetch(new URL("/api/projects?fast=1", started.url), { headers })).json();
    assert.equal(pending.projects[0].pending, true);
    assert.equal("tokens" in pending.projects[0], false);
    let tokens;
    for (let attempt = 0; attempt < 50 && !tokens; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tokens = (await (await fetch(new URL("/api/projects", started.url), { headers })).json()).projects[0].tokens;
    }
    assert.ok(tokens, "tokens never appeared");
    assert.equal(tokens.generatedTokens, 10);
    assert.ok(tokens.authoredTokens > 0);
    assert.equal(tokens.truncated, false);
  });
});

describe("Open project", () => {
  it("adds an existing Flisk project once, and refuses folders without .tdk/project.json", async () => {
    const started = await serverFor({ projects: [], probe: async () => supported });
    const origin = new URL(started.url).origin;
    const add = (path) => fetch(`${origin}/api/projects/add`, { method: "POST", headers: { "content-type": "application/json", origin, "x-flisk-token": started.token }, body: JSON.stringify({ path }) });
    const root = projectFixture("shop");

    const first = await add(root);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.alreadyListed, false);
    assert.equal(firstBody.project.name, "shop");
    assert.equal((await (await add(root)).json()).alreadyListed, true);

    const empty = mkdtempSync(join(tmpdir(), "flisk-app-test-"));
    tempDirs.push(empty);
    assert.equal((await add(empty)).status, 400);
    assert.equal((await add("/etc")).status, 400);
    assert.equal((await add(join(root, "missing"))).status, 400);
  });
});
