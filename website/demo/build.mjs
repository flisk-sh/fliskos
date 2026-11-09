// Builds website/public/demo: the real FliskOS interface, answering from responses recorded from the real server with
// sample projects. Wrangler runs this before each deploy, so the demo always matches the app.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentHub } from "../../src/agents.js";
import { startAppServer } from "../../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const appFiles = join(here, "..", "..", "public");
const TOKEN = "demo";

const project = (name, id) => ({ id, name, root: `/Users/you/code/${name}` });
const PROJECTS = [project("acme-shop", "project-demo000001"), project("support-agent", "project-demo000002"), project("billing-api", "project-demo000003")];

const resource = (name, type, status, stack) => ({ name, type, status, stack, buildStatus: "ok", runtimeStatus: status === "ready" ? "ok" : "pending" });
const SAMPLE = {
  "acme-shop": { stacks: [{ name: "shop" }], tilt: { resources: [{ name: "web" }] }, resources: [resource("web", "frontend", "ready", "shop"), resource("api", "backend", "ready", "shop"), resource("worker", "worker", "ready", "shop"), resource("migrator", "migrator", "ready", "shop"), resource("postgres", "database", "ready", "shop"), resource("redis", "cache", "ready", "shop")] },
  "support-agent": { stacks: [{ name: "agents" }], tilt: { resources: [{ name: "agent" }] }, resources: [resource("agent", "agent", "ready", "agents"), resource("tools", "mcp", "ready", "agents"), resource("postgres", "database", "ready", "agents"), resource("nats", "queue", "ready", "agents")] },
  "billing-api": { stacks: [], tilt: { resources: [] }, resources: [resource("api", "backend", "stopped"), resource("postgres", "database", "stopped"), resource("mailer", "worker", "stopped")] },
};
const PASSED = { "acme-shop": 18, "support-agent": 20, "billing-api": 15 };
const WARNINGS = [{ name: "Docker build cache", isWarning: true, message: "The build cache is using 14 GB. Run flisk doctor --fix to clean it up." }, { name: "Service ports", isWarning: true, message: "Port 5432 is also configured by billing-api." }, { name: "Node version", isWarning: true, message: "api pins Node 20; the project default is 22." }, { name: "Unused volume", isWarning: true, message: "A volume from a removed service is still on disk." }, { name: "Env file", isWarning: true, message: "mailer reads SMTP_HOST, which is not set." }];
const checks = (name) => [...Array.from({ length: PASSED[name] }, (_, index) => ({ name: `Check ${index + 1}`, didPass: true, message: "OK" })), ...WARNINGS.slice(0, 20 - PASSED[name])];
const logLines = (name) => ["Starting", "Listening on 0.0.0.0:3000", "Connected to postgres", "GET /health 200 2ms", "GET /ready 200 3ms"].map((line, index) => ({ text: `12:0${index}:14 ${name} | ${line}` }));

const respond = (data) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
async function runCommand(entry, args) {
  const sample = SAMPLE[entry.name] ?? {};
  if (args[0] === "status") return respond(sample);
  if (args[0] === "networks") return respond({ services: (sample.resources ?? []).filter((item) => ["web", "api", "agent"].includes(item.name)).map((item) => ({ name: item.name, url: `http://${item.name}.${entry.name}.localhost:8081` })) });
  if (args[0] === "doctor") return respond({ ready: true, checks: checks(entry.name) });
  if (args[0] === "logs") return respond({ lines: logLines(args.at(-1)) });
  return respond({});
}

const now = Date.now();
const turn = (id, prompt, seconds, events) => ({ id, prompt, withStack: true, state: "done", startedAt: now - seconds * 1000, endedAt: now - (seconds - 90) * 1000, dropped: 0, error: null, events: [{ kind: "user", text: prompt }, ...events] });
const THREADS = [
  { id: "aaaaaa000001", project: PROJECTS[1].id, projectName: "support-agent", root: PROJECTS[1].root, provider: "claude", mode: "plan", title: "Why does /ready fail after a restart?", createdAt: now - 180000, updatedAt: now - 90000, turns: [turn("bbbbbb000001", "Why does /ready fail after a restart?", 180, [
    { kind: "status", text: "Model claude-opus-5" },
    { kind: "tool", title: "Read services/agent/src/server.ts", status: "done" },
    { kind: "tool", title: "$ flisk logs agent --tail 50", status: "done" },
    { kind: "tool", title: "$ flisk status --json", status: "done" },
    { kind: "text", text: "**/ready returns 503 for about four seconds after a restart.** The agent opens its checkpoint store before Postgres accepts connections, and the first connection attempt is never retried.\n\n- `agent` starts as soon as `migrator` exits, not when `postgres` is healthy.\n- `src/server.ts:42` caches the failed connection, so `/ready` keeps failing until the pool times out.\n- `/health` stays green throughout, so nothing restarts it.\n\nRetry the connection in `openStore()` and it clears by itself." },
  ])] },
  { id: "aaaaaa000002", project: PROJECTS[0].id, projectName: "acme-shop", root: PROJECTS[0].root, provider: "codex", mode: "edit", title: "Add a health check to the worker", createdAt: now - 3600000, updatedAt: now - 3400000, turns: [turn("bbbbbb000002", "Add a health check to the worker", 3600, [
    { kind: "tool", title: "$ rg -n listen services/worker", status: "done" },
    { kind: "tool", title: "Edit services/worker/src/index.ts", status: "done" },
    { kind: "text", text: "Added `GET /health` to the worker. It answers 200 once the queue connection is open." },
  ])] },
];

export async function buildDemo(out = join(here, "..", "public", "demo")) {
  const scratch = mkdtempSync(join(tmpdir(), "fliskos-demo-"));
  const threadsDir = join(scratch, "threads");
  mkdirSync(threadsDir);
  for (const thread of THREADS) writeFileSync(join(threadsDir, `${thread.id}.json`), JSON.stringify(thread));

  const agents = createAgentHub({ dir: threadsDir, locate: () => "/demo/agent", versionOf: async () => "1.0.0" });
  const app = await startAppServer({
    projects: PROJECTS,
    probe: async () => ({ state: "supported", lifecycle: true, version: "1.4.0", program: "flisk", label: "Flisk CLI", minVersion: "1.0.0", installUrl: "https://flisk.sh" }),
    runCommand,
    token: TOKEN,
    agents,
    dockerCheck: async () => true,
    claudeDesktopApp: () => null,
    statePath: join(scratch, "state.json"),
    fetchImpl: async () => { throw new Error("The demo reads nothing from this machine."); },
  });
  const origin = new URL(app.url).origin;
  const read = async (path) => (await fetch(origin + path, { headers: { "x-flisk-token": TOKEN } })).json();

  const get = {};
  for (const path of ["/api/projects", "/api/cli", "/api/state", "/api/agents"]) get[path] = await read(path);
  for (const { id, name } of PROJECTS) {
    for (const route of ["doctor", "apps", "config/log"]) get[`/api/${route}?project=${id}`] = await read(`/api/${route}?project=${id}`);
    for (const item of SAMPLE[name].resources) get[`/api/logs?project=${id}&resource=${item.name}`] = await read(`/api/logs?project=${id}&resource=${item.name}`);
    get[`/api/agents/board?project=${id}`] = { state: "not-running", boardUrl: "http://localhost:4100", sessions: [] };
  }
  get["/api/apps"] = await read("/api/apps");
  get["/api/agents/board"] = { state: "not-running", boardUrl: "http://localhost:4100", sessions: [] };
  // These two describe the machine doing the build, so they are replaced with sample values.
  const meta = await read("/api/meta");
  get["/api/meta"] = { ...meta, defaultParent: "~/code", roots: ["~/code"] };
  get["/api/disk"] = { freeGb: 214.6, dockerResponding: true, items: [] };

  const { threads: listed } = await read("/api/agents/threads");
  const threads = await Promise.all(listed.map(async ({ id }) => (await read(`/api/agents/thread?id=${id}`)).thread));

  await new Promise((done) => app.server.close(done));
  app.server.closeAllConnections?.();
  rmSync(scratch, { recursive: true, force: true });

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "data.js"), `window.FLISK_DEMO = ${JSON.stringify({ builtAt: now, get, threads })};\n`);
  copyFileSync(join(here, "demo-api.js"), join(out, "demo-api.js"));
  for (const file of ["app.js", "os.js", "inspect.js"]) copyFileSync(join(appFiles, file), join(out, file));
  const page = readFileSync(join(appFiles, "index.html"), "utf8")
    .replace("__FLISK_CENTER_TOKEN__", TOKEN)
    // Always dark, to match the page around it.
    .replaceAll("(prefers-color-scheme: dark)", "all")
    .replaceAll("color-scheme: light dark", "color-scheme: dark")
    .replaceAll("(prefers-color-scheme: light)", "not all")
    .replace(/src="\/(inspect|app|os)\.js"/g, 'src="/demo/$1.js"')
    .replace('<script src="/demo/inspect.js"', '<script src="/demo/data.js"></script>\n    <script src="/demo/demo-api.js"></script>\n    <script src="/demo/inspect.js"');
  writeFileSync(join(out, "index.html"), page);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Built ${await buildDemo()}`);
  process.exit(0);
}
