import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { AGENT_PROMPT_LIMIT, AgentError, createAgentHub } from "./agents.js";
import { appsForProject } from "./apps.js";
import { createTokenCache } from "./token-savings.js";

const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0"; } catch { return "0.0.0"; }
})();

// Current CLIs keep a project's config in .flisk/; projects made before the rename still have .tdk/.
const PROJECT_DIRS = [".flisk", ".tdk"];
const PROJECT_FILES = PROJECT_DIRS.map((dir) => join(dir, "project.json"));
const PORT_FILES = [join(".flisk", ".flisk-out", "tilt-port.json"), join(".tdk", ".tdk-out", "tilt-port.json")];
const MAX_BODY = 64 * 1024;
const MAX_SCAN_DEPTH = 8;
const MAX_DIRECTORIES_PER_ROOT = 25_000;
const MAX_DISCOVERED_PROJECTS = 500;
const SCAN_SKIP_NAMES = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "target", "dist", "build",
  ".cache", ".npm", ".bun", ".venv", "venv", ".tox", "Pods", "DerivedData",
]);
const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const CLIENT_SCRIPTS = new Map([
  ["/app.js", readFileSync(new URL("../public/app.js", import.meta.url), "utf8")],
  ["/inspect.js", readFileSync(new URL("../public/inspect.js", import.meta.url), "utf8")],
  ["/os.js", readFileSync(new URL("../public/os.js", import.meta.url), "utf8")],
]);

// The project.json a Flisk project root carries, .flisk/ first, or null when the folder is not a project.
export function projectFile(root) {
  return PROJECT_FILES.map((file) => join(root, file)).find((path) => existsSync(path)) ?? null;
}

export function discoverProjectRoot(start = process.cwd()) {
  let directory = resolve(start);
  while (true) {
    if (projectFile(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function projectName(root) {
  try {
    const value = JSON.parse(readFileSync(projectFile(root), "utf8"));
    return typeof value.project?.name === "string" ? value.project.name : basename(root);
  } catch {
    return basename(root);
  }
}

export function resolveProjects(currentRoot, additionalRoots = []) {
  const roots = [...new Set([...(currentRoot ? [resolve(currentRoot)] : []), ...additionalRoots.map((root) => resolve(root))])];
  return roots.map((root) => {
    if (!isAbsolute(root) || !projectFile(root)) {
      throw new Error(`Not a Flisk project directory: ${root}`);
    }
    return {
      id: `project-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`,
      name: projectName(root),
      root,
    };
  });
}

export function commonProjectScanRoots(home = homedir()) {
  return [
    join(home, "ollama"),
    join(home, "Ollama"),
    "/var/www",
    join(home, "Codex"),
    join(home, "Documents", "Codex"),
    join(home, "GitHub"),
    join(home, "github"),
    join(home, "Documents", "GitHub"),
    join(home, "Documents", "github"),
    join(home, "src"),
    join(home, "Code"),
    join(home, "code"),
    join(home, "Projects"),
    join(home, "projects"),
    join(home, "Developer"),
    join(home, "dev"),
    join(home, "work"),
    join(home, "Work"),
    join(home, "workspace"),
    join(home, "Workspaces"),
    join(home, "Documents", "Projects"),
    join(home, "Documents", "Workspaces"),
  ];
}

// The folders scanned at startup: the common ones and the saved scan folders unless --no-scan, plus every --scan-root.
export function startupScanRoots({ scan = true, extra = [], state = normalizeState(null), home = homedir() } = {}) {
  return [...new Set([...(scan ? [...commonProjectScanRoots(home), ...state.scanRoots] : []), ...extra])];
}

export function discoverProjects({
  currentRoot = discoverProjectRoot(),
  projectRoots = [],
  scanRoots = commonProjectScanRoots(),
  maxDepth = MAX_SCAN_DEPTH,
  maxDirectoriesPerRoot = MAX_DIRECTORIES_PER_ROOT,
  maxProjects = MAX_DISCOVERED_PROJECTS,
} = {}) {
  const discovered = new Set(projectRoots.map((root) => resolve(root)));
  if (currentRoot) discovered.add(resolve(currentRoot));

  for (const scanRoot of [...new Set(scanRoots.map((root) => resolve(root)))]) {
    if (!existsSync(scanRoot)) continue;
    const queue = [{ path: scanRoot, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < maxDirectoriesPerRoot && discovered.size < maxProjects) {
      const current = queue.shift();
      visited += 1;
      if (projectFile(current.path)) {
        discovered.add(current.path);
        continue;
      }
      if (current.depth >= maxDepth) continue;
      let entries;
      try {
        entries = readdirSync(current.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || SCAN_SKIP_NAMES.has(entry.name)) continue;
        if (entry.name.startsWith(".") && !PROJECT_DIRS.includes(entry.name)) continue;
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return resolveProjects(null, [...discovered]).sort((left, right) =>
    left.name.localeCompare(right.name) || left.root.localeCompare(right.root),
  );
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Never show the account name: the home path becomes ~ and any other /Users/<name> becomes /Users/****.
export function maskPaths(text) {
  const home = homedir();
  return text.split(home).join("~").replace(/\/Users\/(?!\*{4})[^/\\"\s]+/g, "/Users/****");
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(maskPaths(JSON.stringify(data)));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > MAX_BODY) {
      request.destroy();
      throw new HttpError(413, "Request body is too large.");
    }
  }
  if (!body) return {};
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  return value;
}

// Commands behind the config panel. Only these fixed argv lists can run, whatever the request says.
export const CONFIG_COMMANDS = { regenerate: ["config", "regenerate"], verify: ["config", "verify"], migrate: ["config", "migrate"] };
export const CONFIG_LOG_LIMIT = 200;

// Tools panel. Each key is one button; the request only picks a key, never an argv.
// `mutates` tells the server to refresh cached status after the command runs.
export const TOOL_COMMANDS = {
  "doctor-fix-preview": { argv: ["doctor", "--fix", "--dry-run"], mutates: false },
  "doctor-fix-apply": { argv: ["doctor", "--fix", "--yes"], mutates: true },
  "up-preview": { argv: ["up", "--dry-run"], mutates: false },
  "down-preview": { argv: ["down", "--dry-run"], mutates: false },
  "runtime-check-assets": { argv: ["runtime", "--check-assets"], mutates: false },
};
// Optional infrastructure services `flisk config enable-infra` / `disable-infra` accept.
export const INFRA_SERVICES = ["monitoring", "elk", "debezium", "golden_image", "verdaccio"];
export const INFRA_TOOLS = { "infra-enable": "enable-infra", "infra-disable": "disable-infra" };

export const RESOURCE_TYPES = ["backend", "frontend", "worker", "mcp", "bring-your-own", "sdk", "agent"];
export const PROJECT_TEMPLATES = ["restaurant", "saas", "erp", "user-management", "ecommerce", "example"];
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

function actionResult(result) {
  return { ok: result.status === 0, timedOut: result.status == null, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4000) };
}

// New projects may only be created inside the user's home folder or the temp dir.
function allowedParent(parent) {
  if (typeof parent !== "string" || parent.includes("\0")) return null;
  if (parent === "~" || parent.startsWith("~/")) parent = join(homedir(), parent.slice(1));
  if (!isAbsolute(parent)) return null;
  try {
    const real = realpathSync(parent);
    if (!statSync(real).isDirectory()) return null;
    const roots = [homedir(), tmpdir()].map((root) => { try { return realpathSync(root); } catch { return root; } });
    return roots.some((root) => real === root || real.startsWith(root + sep)) ? real : null;
  } catch {
    return null;
  }
}

// Space cleanup candidates. Only regenerable caches and unused Docker data: never Downloads, Trash or project files.
export function cleanupCandidates(home = homedir()) {
  const emptyDir = (path) => ({ binary: "find", args: [path, "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"] });
  return [
    { id: "app-caches", label: "Application caches", note: "~/Library/Caches. Apps rebuild these as needed.", path: join(home, "Library", "Caches"), run: emptyDir(join(home, "Library", "Caches")) },
    { id: "logs", label: "Log files", note: "~/Library/Logs", path: join(home, "Library", "Logs"), run: emptyDir(join(home, "Library", "Logs")) },
    { id: "npm", label: "npm cache", note: "Re-downloaded on the next install.", path: join(home, ".npm"), run: { binary: "npm", args: ["cache", "clean", "--force"] } },
    { id: "bun", label: "Bun cache", note: "Re-downloaded on the next install.", path: join(home, ".bun", "install", "cache"), run: { binary: "bun", args: ["pm", "cache", "rm"] } },
    { id: "pnpm", label: "pnpm store (unreferenced packages)", note: "pnpm store prune", path: join(home, "Library", "pnpm"), run: { binary: "pnpm", args: ["store", "prune"] } },
    { id: "dot-cache", label: "~/.cache", note: "Tool caches such as pip and Hugging Face.", path: join(home, ".cache"), run: emptyDir(join(home, ".cache")) },
    { id: "brew", label: "Homebrew downloads", note: "brew cleanup -s", path: join(home, "Library", "Caches", "Homebrew"), run: { binary: "brew", args: ["cleanup", "-s"] } },
    { id: "docker", label: "Unused Docker images and build cache", note: "docker system prune -af (keeps volumes). Needs Docker to be running.", path: null, requiresDocker: true, run: { binary: "docker", args: ["system", "prune", "-af"] } },
  ];
}

// ---------- Persistent UI state (pins, hidden projects, collapsed sections, known project roots) ----------
// The page's origin changes with the random port, so browser storage does not survive a restart; this file does.
export function defaultStatePath() {
  if (process.env.FLISKOS_STATE) return process.env.FLISKOS_STATE;
  // The app was called Flisk App, and TDK App before that; the old overrides keep working.
  if (process.env.FLISK_APP_STATE) return process.env.FLISK_APP_STATE;
  if (process.env.TDK_APP_STATE) return process.env.TDK_APP_STATE;
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "FliskOS", "state.json")
    : join(homedir(), ".config", "fliskos", "state.json");
}

// The state file moved with each rename. Read the newest old location until the new one exists,
// so pins, hidden projects and known roots survive the upgrade.
export function legacyStatePaths() {
  return process.platform === "darwin"
    ? [join(homedir(), "Library", "Application Support", "Flisk App", "state.json"), join(homedir(), "Library", "Application Support", "TDK App", "state.json")]
    : [join(homedir(), ".config", "flisk-app", "state.json"), join(homedir(), ".config", "tdk-app", "state.json")];
}

const STATE_LIST_LIMIT = 500;
const MAX_SCAN_FOLDERS = 20;
const cleanList = (value) => (Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && item.length > 0 && item.length <= 400))].slice(0, STATE_LIST_LIMIT) : []);

export function normalizeState(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pins = value.pins && typeof value.pins === "object" && !Array.isArray(value.pins) ? value.pins : {};
  return {
    pins: { projects: cleanList(pins.projects), resources: cleanList(pins.resources) },
    hidden: cleanList(value.hidden),
    collapsed: cleanList(value.collapsed),
    closedStacks: cleanList(value.closedStacks),
    knownRoots: cleanList(value.knownRoots),
    // Folders of projects the user added with Open project; they are scanned at every start like the common ones.
    scanRoots: cleanList(value.scanRoots).slice(0, MAX_SCAN_FOLDERS),
    // Off unless the user turned it on: logs and doctor output are only offered to an AI service after an explicit opt-in.
    aiInspect: value.aiInspect === true,
  };
}

export function readAppState(path, { legacy = legacyStatePaths() } = {}) {
  const target = path ?? defaultStatePath();
  let missing = false;
  try {
    return normalizeState(JSON.parse(readFileSync(target, "utf8")));
  } catch (error) {
    missing = error?.code === "ENOENT";
  }
  // Migrate the pre-rename file only when the default location has no file AT ALL. A corrupt
  // (but existing) state file must fall through to empty state, not silently resurrect stale
  // pre-rename pins/hidden/knownRoots that the next write would cement. Production callers pass
  // defaultStatePath() itself (src/cli.js) or null; an explicit custom path never migrates.
  if (missing && (path == null || path === defaultStatePath())) {
    for (const candidate of legacy) {
      try {
        return normalizeState(JSON.parse(readFileSync(candidate, "utf8")));
      } catch {}
    }
  }
  return normalizeState(null);
}

// Write to a temp file and rename so a crash never leaves a half-written state file.
export function writeAppState(state, path = defaultStatePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

// CLI-supplied names are passed as argv; a leading "-" would be parsed as a flag.
const isArgName = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !value.startsWith("-") && !value.includes("\0");

function readMachine(result) {
  let envelope;
  const stdout = String(result.stdout ?? "");
  try {
    envelope = JSON.parse(stdout);
  } catch {
    // Some Flisk versions print a diagnostic line before their compact JSON
    // envelope. Preserve the structured result instead of treating the whole
    // response as invalid JSON.
    const lines = stdout.trim().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line.startsWith("{")) continue;
      try {
        const candidate = JSON.parse(line);
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && ("data" in candidate || "errors" in candidate)) {
          envelope = candidate;
          break;
        }
      } catch {}
    }
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(String(result.stderr ?? "").trim() || (result.status == null ? "Flisk did not respond (timed out or could not start)." : `Flisk returned invalid JSON (exit ${result.status}).`));
  }
  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  if ((result.status !== 0 || errors.length) && envelope.data == null) {
    throw new Error(errors.map((error) => error?.message).filter((message) => typeof message === "string" && message).join("\n") || String(result.stderr ?? "").trim() || "Flisk command failed.");
  }
  if (envelope.data == null) throw new Error("Flisk returned no data.");
  return envelope.data;
}

export function savedTiltPort(root) {
  for (const file of PORT_FILES) {
    try {
      const value = JSON.parse(readFileSync(join(root, file), "utf8"));
      if (Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) return value.port;
    } catch {}
  }
  return null;
}

// Turns `tilt get uiresources -o json` into a start-up progress estimate.
// Per resource: built and running = 1, built and starting = 0.75, building = 0.4, waiting = 0. Disabled resources are ignored.
export function tiltProgress(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  let total = 0;
  let score = 0;
  let ready = 0;
  const building = [];
  const starting = [];
  const errors = [];
  for (const item of items) {
    const name = item?.metadata?.name;
    const status = item?.status && typeof item.status === "object" ? item.status : {};
    const update = typeof status.updateStatus === "string" ? status.updateStatus : "none";
    const runtime = typeof status.runtimeStatus === "string" ? status.runtimeStatus : "none";
    if (typeof name !== "string" || name === "(Tiltfile)" || (update === "none" && runtime === "none")) continue;
    total += 1;
    const built = update === "ok" || update === "not_applicable";
    const running = runtime === "ok" || runtime === "not_applicable";
    if (update === "error" || runtime === "error") { errors.push(name); score += 1; continue; }
    if (built && running) { score += 1; ready += 1; }
    else if (built) { score += 0.75; starting.push(name); }
    else if (update === "in_progress") { score += 0.4; building.push(name); }
  }
  const percent = total ? Math.round((score / total) * 100) : 0;
  const list = (names) => (names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "));
  const step = errors.length ? `Failed: ${list(errors)}`
    : building.length ? `Building ${list(building)}`
    : starting.length ? `Starting ${list(starting)}`
    : total && ready === total ? "All resources ready"
    : total ? "Waiting for resources" : "Waiting for Tilt";
  return { percent, total, ready, building, starting, errors, step };
}

// The CLI ships as `flisk`; `tdk` is the legacy name that older installs still expose.
const CLI_BINARY_NAMES = ["flisk", "tdk"];
const CLI_FALLBACK_NAME = "flisk";

let selectedCliBinary = null;

// An explicit path always wins, so a project can pin the CLI it was built against.
function cliBinaryOverride(env = process.env) {
  const override = [env.FLISK_BIN, env.TDK_BIN].find((value) => typeof value === "string" && value.trim());
  return override ? override.trim() : null;
}

export function cliBinaryCandidates(env = process.env) {
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  // Keep the app's native-first PATH for Colima/Lima, but prefer conventional
  // package-manager installs for the CLI over older copies in language-manager bins.
  const preferredEntries = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin"), join(homedir(), ".n", "bin")];
  const directories = [...new Set([...preferredEntries, ...pathEntries])];
  // The current `flisk` name wins over the legacy `tdk` alias wherever both are installed.
  return CLI_BINARY_NAMES.flatMap((name) => directories.map((entry) => join(entry, name)))
    .filter((candidate) => existsSync(candidate));
}

export function resolveTdkBinary(env = process.env) {
  const override = cliBinaryOverride(env);
  if (override) return override;
  if (selectedCliBinary && existsSync(selectedCliBinary)) return selectedCliBinary;
  return cliBinaryCandidates(env)[0] ?? CLI_FALLBACK_NAME;
}

// The name the CLI is invoked by, used in messages and in the argv the UI shows.
export function cliCommandName(env = process.env) {
  return basename(resolveTdkBinary(env));
}

export function runTdk(project, args, { binary = CLI_FALLBACK_NAME, timeoutMs = 30_000, detached = false } = {}) {
  return new Promise((resolvePromise) => {
    const savedPort = project.root ? savedTiltPort(project.root) : null;
    // GUI apps inherit a much smaller PATH than a terminal. Flisk projects on
    // macOS commonly install Bun under ~/.bun/bin, so expose that location to
    // child CLI processes even when the app was launched from Finder/Launchpad.
    const pathEntries = [join(homedir(), ".bun", "bin"), ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean);
    const env = {
      ...process.env,
      PATH: [...new Set(pathEntries)].join(delimiter),
      ...(savedPort ? { TILT_PORT: String(savedPort) } : {}),
    };
    const command = CLI_BINARY_NAMES.includes(binary) ? resolveTdkBinary(env) : binary;
    const child = spawn(command, args, {
      cwd: project.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Lifecycle commands run in their own process group so quitting the app never stops a start or stop half-way.
      detached,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    };
    const stop = () => {
      child.kill("SIGTERM");
      // A CLI that ignores SIGTERM must not outlive the request.
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    };
    const timer = setTimeout(() => {
      stop();
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) {
        stop();
        finish(null);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) {
        stop();
        finish(null);
      }
    });
    child.once("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

export const MANUAL_UPDATE_COMMAND = "curl -fsSL https://flisk.sh/install.sh | sh";
export const MIN_CLI_VERSION = null;
const INSTALL_URL = "https://github.com/flisk-sh/flisk#install";
// The CLI starts and stops through `up` and `down` (no scoped start/stop/restart exist).
const LIFECYCLE_COMMANDS = ["up", "down"];

// Commander prints command-specific help ("Usage: flisk up|deploy [options]") only when the
// command exists; an older CLI falls back to the root help ("Usage: flisk [options] [command]").
// The program name is whatever the CLI prints, so a renamed binary still matches.
function usageOf(help) {
  const match = /^Usage:\s+(\S+)(?:\s+(\S+))?/m.exec(help?.stdout ?? "");
  if (!match) return null;
  return { program: match[1], command: match[2] ?? "" };
}

function supportsLifecycleCommand(help, command) {
  if (!help || help.status !== 0) return false;
  const usage = usageOf(help);
  if (!usage) return false;
  // Commander lists command aliases together: "up|deploy" still answers `up`.
  return usage.command.split("|").includes(command);
}

// The CLI is installed as `flisk`; the legacy `tdk` name is still accepted from older installs.
export function cliLabel(program) {
  // The legacy binary is still the old CLI, so it keeps the old name in messages.
  if (program === "tdk") return "TDK CLI";
  if (program === "flisk") return "Flisk CLI";
  return `${program} CLI`;
}

// Non-mutating probe: `<cli> --version` for display and `<cli> <cmd> --help` per lifecycle command.
export async function probeCli(execute, cwd = process.cwd()) {
  const probe = { root: cwd };
  const base = { minVersion: MIN_CLI_VERSION, installUrl: INSTALL_URL, version: null };
  // A machine can have stale CLI copies earlier on PATH. Try installed candidates until
  // one answers --version AND supports the lifecycle commands, so a half-broken install
  // cannot shadow a capable one further down the list (the flisk-first ordering makes
  // that a cross-name possibility). When nothing is fully capable, the first
  // version-answering candidate is still the CLI used for status, logs and updates.
  const override = cliBinaryOverride();
  const candidates = override ? [override] : cliBinaryCandidates();
  let binary = candidates[0] ?? CLI_FALLBACK_NAME;
  let versionResult = { status: null, stdout: "", stderr: "" };
  let helps = [];
  let accepted = null;
  for (const candidate of candidates.length ? candidates : [binary]) {
    const result = await execute(probe, ["--version"], { binary: candidate, timeoutMs: 10_000 });
    if (result.status !== 0) {
      versionResult = result;
      continue;
    }
    const candidateHelps = await Promise.all(LIFECYCLE_COMMANDS.map((command) =>
      execute(probe, [command, "--help"], { binary: candidate, timeoutMs: 10_000 }),
    ));
    const entry = { candidate, result, helps: candidateHelps };
    accepted ??= entry;
    if (LIFECYCLE_COMMANDS.every((command, index) => supportsLifecycleCommand(candidateHelps[index], command))) {
      accepted = entry;
      break;
    }
  }
  if (accepted) {
    binary = accepted.candidate;
    versionResult = accepted.result;
    helps = accepted.helps;
    selectedCliBinary = accepted.candidate;
  }
  const program = helps.map((help) => usageOf(help)).find(Boolean)?.program ?? basename(binary);
  const label = cliLabel(program);
  if (versionResult.status !== 0) {
    const missing = /ENOENT/.test(versionResult.stderr);
    return {
      ...base,
      program,
      label,
      state: missing ? "missing" : "failed",
      lifecycle: false,
      message: missing
        ? `The ${label} was not found. Install the ${label}, or set FLISK_BIN (or TDK_BIN) to its path.`
        : `The ${label} did not respond to a version check (${versionResult.stderr.trim() || "timeout or non-zero exit"}). Check FLISK_BIN and your install.`,
    };
  }
  const version = versionResult.stdout.trim().split(/\s+/).pop() || null;
  for (const [index, command] of LIFECYCLE_COMMANDS.entries()) {
    if (!supportsLifecycleCommand(helps[index], command)) {
      return {
        ...base,
        version,
        program,
        label,
        state: "unsupported",
        lifecycle: false,
        message: `${label} ${version ?? "(unknown version)"} does not support \`${program} ${LIFECYCLE_COMMANDS.join("/")}\`. Update the CLI to enable Start, Stop and Restart; status, logs and endpoints still work.`,
      };
    }
  }
  return { ...base, version, program, label, state: "supported", lifecycle: true, message: null };
}

// Older CLI versions omit directUrl. A bring-your-own app runs on the host at its declared port, so that is the address.
export function directUrlFromPort(resource) {
  const port = resource?.port;
  return resource?.type === "bring-your-own" && Number.isInteger(port) && port > 0 && port <= 65535 ? `http://localhost:${port}` : null;
}

async function projectStatus(project, execute) {
  const status = readMachine(await execute(project, ["status", "--json", "--tilt"]));
  let services = [];
  try {
    services = readMachine(await execute(project, ["networks", "--json"])).services ?? [];
  } catch {}
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Flisk returned an unexpected status format.");
  const objects = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : []);
  const urls = new Map(objects(services).map((service) => [service.name, service.url]));
  return {
    project,
    resources: objects(status.resources).map((resource) => ({
      ...resource,
      url: safeUrl(urls.get(resource.name) ?? resource.url ?? resource.directUrl ?? directUrlFromPort(resource)),
    })),
    stacks: objects(status.stacks),
    ports: objects(status.ports),
    tiltRunning: isOwnTiltRunning(status.tilt, objects(status.resources)),
  };
}

// `flisk status --tilt` reports whichever Tilt answers on the shared UI port, and that Tilt can belong to another
// project. A project is running only when that Tilt has a resource named like one of the project's own resources.
export function isOwnTiltRunning(tilt, ownResources) {
  if (!tilt || typeof tilt !== "object") return false;
  const raw = tilt.resources;
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(raw.items) ? raw.items : [];
  const tiltNames = new Set(items.map((item) => item?.metadata?.name ?? item?.name).filter((name) => typeof name === "string"));
  return ownResources.some((resource) => typeof resource.name === "string" && tiltNames.has(resource.name));
}

// Turns `flisk doctor --json` data into a 0-100 score: pass = 1, warning = 0.5, fail = 0, skipped ignored.
export function summarizeDoctor(data) {
  const raw = data && typeof data === "object" && Array.isArray(data.checks) ? data.checks : [];
  const checks = raw.filter((check) => check && typeof check === "object").map((check) => ({
    name: typeof check.name === "string" ? check.name : "Unnamed check",
    status: check.isSkipped ? "skipped" : check.didPass ? "pass" : check.isWarning ? "warning" : "fail",
    message: typeof check.message === "string" ? check.message : "",
    fix: typeof check.fix === "string" ? check.fix : "",
  }));
  const counted = checks.filter((check) => check.status !== "skipped");
  const points = counted.reduce((sum, check) => sum + (check.status === "pass" ? 1 : check.status === "warning" ? 0.5 : 0), 0);
  return {
    score: counted.length ? Math.round((points / counted.length) * 100) : null,
    passed: counted.filter((check) => check.status === "pass").length,
    warnings: counted.filter((check) => check.status === "warning").length,
    failed: counted.filter((check) => check.status === "fail").length,
    total: counted.length,
    ready: Boolean(data?.ready),
    checks,
  };
}

export const DOCKER_UNAVAILABLE = "The container runtime isn't responding. Start Colima or Docker Desktop, wait until Docker responds, then try again.";

// A nearly full disk is the most common reason Docker Desktop's engine stops answering.
export function lowDiskNote(path = homedir(), thresholdGb = 5) {
  try {
    const stats = statfsSync(path);
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    return freeGb < thresholdGb ? ` Your disk has only ${freeGb.toFixed(1)} GB free, which is the most likely cause. Free some space first (for example with \`docker system prune\` once Docker responds, or by deleting large files).` : "";
  } catch {
    return "";
  }
}

function freeGb(path = homedir()) {
  try {
    const stats = statfsSync(path);
    return (stats.bavail * stats.bsize) / 1024 ** 3;
  } catch {
    return Infinity;
  }
}

// Quits Docker Desktop (force-quitting if it is stuck), reopens it and waits until the engine answers.
export async function restartDockerDesktop({ check = checkDocker, run = (command, args) => runTdk({ root: homedir() }, args, { binary: command, timeoutMs: 20_000 }), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitMs = 240_000, platform = process.platform, free = freeGb } = {}) {
  if (platform !== "darwin") return { ok: false, message: "Restarting Docker automatically is only supported on macOS. Restart Docker manually." };
  const gb = free();
  if (gb < 2) return { ok: false, lowDisk: true, message: `Only ${gb.toFixed(1)} GB of disk is free, so Docker cannot start. Free at least 5 GB, then try again.` };
  await run("osascript", ["-e", 'tell application "Docker" to quit']);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const running = await run("pgrep", ["-f", "Docker Desktop"]);
    if (running.status !== 0) break;
    if (attempt === 4) await run("pkill", ["-9", "-f", "/Applications/Docker.app"]);
    await sleep(2500);
  }
  const opened = await run("open", ["-a", "Docker"]);
  if (opened.status !== 0) return { ok: false, message: "Could not open Docker Desktop. Is it installed in /Applications?" };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    if (await check().catch(() => false)) return { ok: true, message: "Docker is running again." };
  }
  return { ok: false, message: "Docker Desktop was reopened but is still not responding. Check its window for errors." };
}

// Start the selected Colima runtime when a project uses its Docker context.
// Other macOS Docker contexts keep the existing Docker Desktop recovery path.
export async function restartContainerRuntime({ check = checkDocker, run = (command, args, options = {}) => runTdk({ root: homedir() }, args, { binary: command, timeoutMs: options.timeoutMs ?? 20_000 }), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitMs = 240_000, platform = process.platform, free = freeGb } = {}) {
  if (platform !== "darwin") return { ok: false, message: "Starting the container runtime automatically is only supported on macOS. Start it manually, then try again." };
  const context = await run("docker", ["context", "show"], { timeoutMs: 10_000 });
  if (context.status === 0 && context.stdout.trim() === "colima") {
    const gb = free();
    if (gb < 2) return { ok: false, lowDisk: true, message: `Only ${gb.toFixed(1)} GB of disk is free, so Colima cannot start. Free at least 5 GB, then try again.` };
    const current = await run("colima", ["status"], { timeoutMs: 10_000 });
    if (current.status !== 0) {
      const started = await run("colima", ["start"], { timeoutMs: waitMs });
      if (started.status !== 0) {
        const detail = (started.stderr || started.stdout || "").trim();
        return { ok: false, message: `Could not start Colima.${detail ? ` ${detail}` : ""}` };
      }
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await check().catch(() => false)) return { ok: true, message: "Colima is running again." };
      await sleep(4000);
    }
    return { ok: false, message: "Colima was started but Docker is still not responding. Check Colima's logs, then try again." };
  }
  return restartDockerDesktop({ check, run, sleep, waitMs, platform, free });
}

export async function checkDocker(execute = runTdk) {
  const result = await execute({ root: homedir() }, ["info", "--format", "{{.ServerVersion}}"], { binary: process.env.DOCKER_BIN || "docker", timeoutMs: 8000 });
  return result.status === 0;
}

function safeUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function findConflicts(snapshots) {
  const owners = new Map();
  for (const snapshot of snapshots) {
    for (const port of snapshot.ports) {
      const claimants = owners.get(port.hostPort) ?? [];
      // The path tells two checkouts of the same project apart, so the list stays actionable.
      claimants.push({ projectId: snapshot.project.id, label: `${snapshot.project.name} (${port.name})`, path: snapshot.project.root });
      owners.set(port.hostPort, claimants);
    }
  }
  return [...owners].filter(([, claimants]) => claimants.length > 1).map(([port, claimants]) => ({ port, claimants }));
}

// A short description of the project's stack that goes to the agent after the first prompt of a thread.
export function stackContext(project, snapshot) {
  const lines = [`Flisk project "${project.name}" at ${project.root}. Flisk runs it locally on Docker and Tilt: \`flisk status --json\` shows the stack, \`flisk logs <resource>\` its logs, and \`flisk up\` / \`flisk down\` start and stop it.`];
  const resources = Array.isArray(snapshot?.resources) ? snapshot.resources : [];
  if (resources.length) {
    lines.push(`Stack status from FliskOS: ${snapshot.tiltRunning ? "running" : "stopped"}.`);
    for (const resource of resources.slice(0, 40)) {
      lines.push(`- ${resource.name}${resource.type ? ` (${resource.type})` : ""}${resource.stack ? `, stack ${resource.stack}` : ""}: ${resource.status ?? "unknown"}${resource.url ? `, ${resource.url}` : ""}`);
    }
    if (resources.length > 40) lines.push(`- and ${resources.length - 40} more`);
  }
  return lines.join("\n");
}

const agentPrompt = (value) => (typeof value === "string" && value.trim() && value.length <= AGENT_PROMPT_LIMIT ? value.trim() : null);
const PROMPT_ERROR = `Write a prompt of up to ${AGENT_PROMPT_LIMIT.toLocaleString("en-US")} characters.`;

export function startAppServer({ projects, projectsReady = Promise.resolve(), probe = probeCli, host = "127.0.0.1", port = 0, token = randomBytes(32).toString("hex"), runCommand = runTdk, openPath = openProjectPath, claudeDesktopApp = findClaudeDesktopApp, openAiApp = openInClaudeApp, dockerCheck = checkDocker, dockerRestart = restartContainerRuntime, prewarm = false, statePath = null, agents = null }) {
  if (host !== "127.0.0.1") throw new Error("FliskOS can only bind to 127.0.0.1.");
  // Threads are kept next to the state file, so they survive a restart; without a state file they live in memory.
  const hub = agents ?? createAgentHub({ dir: statePath ? join(dirname(statePath), "threads") : null, appVersion: APP_VERSION });
  let capability = null;
  let updating = false;
  const tokenCache = createTokenCache();
  // Null until the first measurement finishes, so the bar appears on a later poll.
  const tokensFor = (snapshot) => {
    if (snapshot.pending) return {};
    const tokens = tokenCache.get(snapshot.project.root);
    return tokens ? { tokens } : {};
  };
  let restartingDocker = false;
  const configLogs = [];
  // Background lifecycle jobs (one per project) and a short cache of Tilt progress.
  const jobs = new Map();
  const progressCache = new Map();
  const JOB_TIMEOUT_MS = 30 * 60_000;
  // Several projects can default to the same Tilt port, so only trust progress from the Tilt whose Tiltfile is in this project.
  const tiltOwners = new Map();
  // macOS reports some paths through symlinks (/var -> /private/var); compare resolved paths on both sides.
  const resolvedPath = (path) => { try { return realpathSync(path); } catch { return path; } };
  const tiltOwner = async (port, project) => {
    const cached = tiltOwners.get(port);
    if (cached && Date.now() - cached.at < 15_000) return cached.root;
    let root = null;
    const result = await runCommand(project, ["get", "tiltfile", "-o", "json", "--port", String(port)], { binary: process.env.TILT_BIN || "tilt", timeoutMs: 8000 });
    if (result.status === 0) {
      try {
        const path = JSON.parse(result.stdout)?.items?.[0]?.spec?.path;
        // The Tiltfile lives in the project's .flisk/ (or legacy .tdk/) folder, so the part before it is the root.
        if (typeof path === "string") root = resolvedPath(path.split(new RegExp(`\\${sep}\\.(?:flisk|tdk)\\${sep}`))[0]);
      } catch {}
    }
    tiltOwners.set(port, { at: Date.now(), root });
    return root;
  };
  const getProgress = async (project) => {
    const cached = progressCache.get(project.id);
    if (cached && Date.now() - cached.at < 2000) return cached.value;
    const port = savedTiltPort(project.root) ?? 10350;
    if ((await tiltOwner(port, project)) !== resolvedPath(project.root)) {
      progressCache.set(project.id, { at: Date.now(), value: null });
      return null;
    }
    const result = await runCommand(project, ["get", "uiresources", "-o", "json", "--port", String(port)], { binary: process.env.TILT_BIN || "tilt", timeoutMs: 8000 });
    let value = null;
    if (result.status === 0) { try { value = tiltProgress(JSON.parse(result.stdout)); } catch {} }
    progressCache.set(project.id, { at: Date.now(), value });
    return value;
  };
  const publicJob = async (job) => {
    const project = projects.find((entry) => entry.id === job.project);
    const active = job.state === "running" || (job.detached && job.state === "done");
    const progress = project && job.operation !== "stop" && (active || Date.now() - (job.endedAt ?? 0) < 60_000) ? await getProgress(project).catch(() => null) : null;
    let state = job.state;
    if (job.state === "done" && job.detached && progress && progress.percent < 100 && !progress.errors.length && Date.now() - job.startedAt < JOB_TIMEOUT_MS) state = "settling";
    return { id: job.id, project: job.project, operation: job.operation, state, message: job.message, startedAt: job.startedAt, endedAt: job.endedAt, elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt, progress };
  };
  let appState = statePath ? readAppState(statePath) : normalizeState(null);
  const lastVerify = new Map();
  // Stale-while-revalidate status cache: answers instantly after the first load, refreshes in the background.
  const statusCache = new Map();
  const STATUS_FRESH_MS = 4000;
  const refreshStatus = (project) => {
    const entry = statusCache.get(project.id) ?? {};
    if (entry.pending) return entry.pending;
    entry.pending = projectStatus(project, runCommand).catch((error) => ({
      project, resources: [], stacks: [], ports: [], tiltRunning: false,
      error: error instanceof Error ? error.message : String(error),
    })).then((snapshot) => {
      entry.snapshot = snapshot;
      entry.at = Date.now();
      entry.pending = null;
      return snapshot;
    });
    statusCache.set(project.id, entry);
    return entry.pending;
  };
  const getStatus = (project) => {
    const entry = statusCache.get(project.id);
    if (!entry?.snapshot) return refreshStatus(project);
    if (Date.now() - entry.at > STATUS_FRESH_MS) void refreshStatus(project);
    return entry.snapshot;
  };
  const invalidateStatus = (project) => {
    const entry = statusCache.get(project.id);
    if (entry) entry.at = 0;
  };
  if (prewarm) {
    // Warm the probe immediately, but start the status wave only after it settles: the probe
    // pins the capable binary (selectedCliBinary), and a broken `flisk` earlier on PATH would
    // otherwise shadow a working `tdk` for the whole first wave.
    const warmed = Promise.resolve().then(() => cliCapability());
    void Promise.resolve(projectsReady).then(() => warmed).then(() => {
      for (const project of projects) void refreshStatus(project);
    });
  }
  const doctorCache = new Map();
  const DOCTOR_TTL_MS = 120_000;
  const loadDoctor = (project, force) => {
    const cached = doctorCache.get(project.id);
    if (cached && !force && (cached.pending || Date.now() - cached.at < DOCTOR_TTL_MS)) return cached.promise;
    const entry = { at: Date.now(), pending: true };
    entry.promise = (async () => {
      try {
        // Include running-service health probes so Doctor can report failed
        // HTTP resources such as nats-http-bridge, not only host readiness.
        const data = readMachine(await runCommand(project, ["doctor", "--json"], { timeoutMs: 45_000 }));
        return { ...summarizeDoctor(data), at: new Date().toISOString() };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
      } finally {
        entry.pending = false;
        entry.at = Date.now();
      }
    })();
    doctorCache.set(project.id, entry);
    return entry.promise;
  };
  // Cache only a positive result so installing or updating the CLI is picked up on the next load.
  // Concurrent callers (the 7s poll, the 900ms pending poll, actions, the prewarm wave) share one
  // in-flight probe instead of each spawning its own multi-candidate scan against a broken CLI.
  let probing = null;
  const cliCapability = async () => {
    if (capability?.lifecycle) return capability;
    if (!probing) {
      const attempt = probe(runCommand)
        .catch((error) => ({
          state: "failed", lifecycle: false, version: null, minVersion: MIN_CLI_VERSION, installUrl: INSTALL_URL,
          program: CLI_FALLBACK_NAME, label: cliLabel(CLI_FALLBACK_NAME),
          message: `The ${cliLabel(CLI_FALLBACK_NAME)} could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        }))
        .then((result) => {
          // A probe superseded by a CLI update must not clobber the fresh result.
          if (probing === attempt) capability = result;
          return result;
        })
        .finally(() => {
          if (probing === attempt) probing = null;
        });
      probing = attempt;
    }
    return probing;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const origin = `http://127.0.0.1:${actualPort}`;
      if (request.headers.host !== `127.0.0.1:${actualPort}`) return sendJson(response, 403, { error: "Invalid host." });
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/" && request.method === "GET") {
        if (!sameSecret(url.searchParams.get("token") ?? "", token)) return sendJson(response, 404, { error: "Not found." });
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        return response.end(HTML.replace("__FLISK_CENTER_TOKEN__", token));
      }
      if (CLIENT_SCRIPTS.has(url.pathname) && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        return response.end(CLIENT_SCRIPTS.get(url.pathname));
      }
      if (!url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found." });
      if (!sameSecret(request.headers["x-flisk-token"]?.toString() ?? "", token)) return sendJson(response, 403, { error: "Invalid session token." });
      if (request.headers.origin && request.headers.origin !== origin) return sendJson(response, 403, { error: "Invalid origin." });
      if (request.method !== "GET" && request.method !== "HEAD" && request.headers.origin !== origin) return sendJson(response, 403, { error: "A same-origin request is required." });

      if (url.pathname === "/api/cli" && request.method === "GET") {
        return sendJson(response, 200, await cliCapability());
      }
      if (url.pathname === "/api/cli/update" && request.method === "POST") {
        // Runs the CLI's own `flisk upgrade`; never elevates privileges. On failure the client shows the manual command.
        if (updating) return sendJson(response, 409, { error: "An update is already running." });
        updating = true;
        try {
          let result = await runCommand({ root: homedir() }, ["upgrade", "--yes", "--all"], { timeoutMs: 300_000 });
          if (result.status !== 0 && /unknown option.*--all|unknown option.*'--all'/i.test(`${result.stdout}\n${result.stderr}`)) {
            result = await runCommand({ root: homedir() }, ["upgrade", "--yes"], { timeoutMs: 300_000 });
          }
          // Drop the cached result AND any in-flight probe so the re-probe below cannot join
          // a pre-update attempt and report the old version.
          capability = null;
          probing = null;
          const cli = await cliCapability();
          return sendJson(response, 200, { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-2000), cli });
        } finally {
          updating = false;
        }
      }
      if (url.pathname === "/api/docker/restart" && request.method === "POST") {
        if (restartingDocker) return sendJson(response, 409, { error: "Docker is already being restarted." });
        restartingDocker = true;
        try {
          return sendJson(response, 200, await dockerRestart());
        } finally {
          restartingDocker = false;
        }
      }
      if (url.pathname === "/api/doctor" && request.method === "GET") {
        const project = projects.find((entry) => entry.id === url.searchParams.get("project"));
        if (!project) return sendJson(response, 400, { error: "Select a project." });
        return sendJson(response, 200, await loadDoctor(project, url.searchParams.get("refresh") === "1"));
      }
      if (url.pathname === "/api/projects" && request.method === "GET") {
        await projectsReady;
        // One broken project must not take the whole dashboard down.
        // ?fast=1 answers at once: projects without a status yet come back as pending and fill in on the next poll.
        const fast = url.searchParams.get("fast") === "1";
        const snapshots = await Promise.all(projects.map((project) => {
          const cached = statusCache.get(project.id)?.snapshot;
          if (fast && !cached) {
            void refreshStatus(project);
            return { project, resources: [], stacks: [], ports: [], tiltRunning: false, pending: true };
          }
          return getStatus(project);
        }));
        const conflicts = findConflicts(snapshots);
        return sendJson(response, 200, {
          projects: snapshots.map((snapshot) => ({
            id: snapshot.project.id,
            name: snapshot.project.name,
            path: snapshot.project.root,
            tiltRunning: snapshot.tiltRunning,
            ...(snapshot.error ? { error: snapshot.error } : {}),
            ...(snapshot.pending ? { pending: true } : {}),
            resources: snapshot.resources,
            stacks: snapshot.stacks,
            ports: snapshot.ports.map((port) => ({ name: port.name, port: port.hostPort })),
            ...tokensFor(snapshot),
            conflicts: conflicts.filter((conflict) => conflict.claimants.some((claimant) => claimant.projectId === snapshot.project.id)).map((conflict) => ({
              port: conflict.port,
              claimants: conflict.claimants.map((claimant) => ({ label: claimant.label, path: claimant.path })),
            })),
          })),
        });
      }
      if (url.pathname === "/api/logs" && request.method === "GET") {
        const project = projects.find((entry) => entry.id === url.searchParams.get("project"));
        const resource = url.searchParams.get("resource");
        if (!project || !isArgName(resource)) return sendJson(response, 400, { error: "Select a project and resource." });
        const result = readMachine(await runCommand(project, ["logs", "--json", "--tail", "100", "--service", resource]));
        return sendJson(response, 200, { lines: Array.isArray(result.lines) ? result.lines : [] });
      }
      if (url.pathname === "/api/actions" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        if (!project || typeof body.project !== "string" || !["start", "stop", "restart"].includes(body.operation)) return sendJson(response, 400, { error: "Choose a valid project and lifecycle action." });
        const cli = await cliCapability();
        if (!cli.lifecycle) {
          return sendJson(response, 409, { error: cli.message, code: "cli_unsupported", cli: { state: cli.state, version: cli.version, minVersion: cli.minVersion, installUrl: cli.installUrl, program: cli.program, label: cli.label } });
        }
        const hasStack = body.stack != null && body.stack !== "";
        if (hasStack && !isArgName(body.stack)) return sendJson(response, 400, { error: "Invalid stack name." });
        if (body.resources != null && (!Array.isArray(body.resources) || body.resources.length > 30 || !body.resources.every((name) => isArgName(name)))) return sendJson(response, 400, { error: "Invalid resource selection." });
        const scoped = hasStack || Boolean(body.resources?.length);
        // `flisk down` has no scope, so stop and restart act on the whole project.
        if (scoped && body.operation !== "start") return sendJson(response, 400, { error: "Flisk can only stop or restart a whole project. Start accepts a stack or resources." });
        const dockerOk = await Promise.resolve(dockerCheck()).catch(() => false);
        if (!dockerOk) return sendJson(response, 503, { error: `${DOCKER_UNAVAILABLE}${lowDiskNote()}`, code: "docker_unavailable", lowDisk: lowDiskNote() !== "" });
        const up = ["up", "--json"];
        if (hasStack) up.push(body.stack);
        if (body.resources?.length) up.push("--only", ...body.resources);
        const lifecycle = async (timeoutMs) => {
          try {
            if (body.operation !== "start") readMachine(await runCommand(project, ["down", "--json", "--force"], { timeoutMs: 180_000, detached: true }));
            return body.operation === "stop" ? { operation: "stop" } : readMachine(await runCommand(project, up, { timeoutMs, detached: true }));
          } finally {
            invalidateStatus(project);
          }
        };
        // One lifecycle per project at a time, whether the request waits or the page polls: a synchronous
        // request registers the same job record, so a background request cannot start a second run beside it.
        const running = jobs.get(project.id);
        if (running && running.state === "running") return sendJson(response, 409, { error: "An action is already running for this project.", job: await publicJob(running) });
        const job = { id: randomBytes(6).toString("hex"), project: project.id, operation: body.operation, state: "running", startedAt: Date.now(), endedAt: null, message: "", detached: false };
        jobs.set(project.id, job);
        progressCache.delete(project.id);
        if (body.background === true) {
          // Answer at once; the page polls /api/jobs for progress. Starts can take many minutes the first time images build.
          void lifecycle(JOB_TIMEOUT_MS).then((result) => {
            job.detached = Boolean(result?.startedDetached);
            job.state = "done";
            job.message = body.operation === "stop" ? "Stopped." : result?.startedDetached ? "Startup launched; resources are still settling." : "Started.";
          }).catch((error) => {
            job.state = "failed";
            job.message = error instanceof Error ? error.message : String(error);
          }).finally(() => { job.endedAt = Date.now(); });
          return sendJson(response, 202, { job: await publicJob(job) });
        }
        let result;
        try {
          result = await lifecycle(180_000);
          job.state = "done";
          job.message = body.operation === "stop" ? "Stopped." : result.startedDetached ? "Startup launched; resources are still settling." : "Started.";
        } catch (error) {
          job.state = "failed";
          job.message = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          job.endedAt = Date.now();
        }
        return sendJson(response, 200, { data: result, message: result.startedDetached ? "Startup launched; Flisk will report readiness as it settles." : "Flisk lifecycle operation completed." });
      }
      if (url.pathname === "/api/jobs" && request.method === "GET") {
        const recent = [...jobs.values()].filter((job) => job.state === "running" || job.detached || Date.now() - (job.endedAt ?? 0) < 120_000);
        const listed = await Promise.all(recent.map(publicJob));
        // Also report starts the app did not launch (for example from a terminal, or before a restart of the app).
        for (const project of projects) {
          if (jobs.get(project.id)?.state === "running") continue;
          const port = savedTiltPort(project.root) ?? 10350;
          if ((await tiltOwner(port, project).catch(() => null)) !== resolvedPath(project.root)) continue;
          if (listed.some((job) => job.project === project.id)) continue;
          const progress = await getProgress(project).catch(() => null);
          if (progress && (progress.percent < 100 || progress.errors.length)) {
            listed.push({ id: null, project: project.id, operation: "start", state: progress.errors.length ? "failed" : "settling", message: progress.errors.length ? progress.step : "", startedAt: null, endedAt: null, elapsedMs: null, progress, external: true });
          }
        }
        return sendJson(response, 200, { jobs: listed });
      }
      if (url.pathname === "/api/disk" && request.method === "GET") {
        const gb = freeGb();
        const dockerUp = await Promise.resolve(dockerCheck()).catch(() => false);
        const items = await Promise.all(cleanupCandidates().map(async (item) => {
          let sizeMb = null;
          if (item.path && existsSync(item.path)) {
            const sized = await runCommand({ root: homedir() }, ["-sk", item.path], { binary: "du", timeoutMs: 30_000 });
            const kb = Number.parseInt(String(sized.stdout ?? "").split(/\s/)[0], 10);
            if (sized.status === 0 && Number.isFinite(kb)) sizeMb = Math.round(kb / 1024);
          }
          return { id: item.id, label: item.label, note: item.note, sizeMb, available: item.requiresDocker ? dockerUp : item.path ? existsSync(item.path) : true, requiresDocker: Boolean(item.requiresDocker) };
        }));
        return sendJson(response, 200, { freeGb: Number.isFinite(gb) ? Number(gb.toFixed(1)) : null, dockerResponding: dockerUp, items });
      }
      if (url.pathname === "/api/disk/clean" && request.method === "POST") {
        const body = await readBody(request);
        const known = new Map(cleanupCandidates().map((item) => [item.id, item]));
        if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > known.size || !body.ids.every((id) => typeof id === "string" && known.has(id))) return sendJson(response, 400, { error: "Choose what to clean." });
        const before = freeGb();
        const results = [];
        for (const id of [...new Set(body.ids)]) {
          const item = known.get(id);
          const result = await runCommand({ root: homedir() }, item.run.args, { binary: item.run.binary, timeoutMs: 600_000 });
          results.push({ id, label: item.label, ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-300) });
        }
        const after = freeGb();
        return sendJson(response, 200, { results, freedGb: Number.isFinite(before) && Number.isFinite(after) ? Number(Math.max(0, after - before).toFixed(1)) : null, freeGb: Number.isFinite(after) ? Number(after.toFixed(1)) : null });
      }
      if (url.pathname === "/api/meta" && request.method === "GET") {
        const home = homedir();
        const roots = commonProjectScanRoots().filter((root) => existsSync(root));
        const tilde = (path) => (path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path);
        return sendJson(response, 200, { defaultParent: tilde(roots.find((root) => root.startsWith(home)) ?? home), roots: [...new Set([...appState.scanRoots, ...roots].map(tilde))], templates: PROJECT_TEMPLATES, resourceTypes: RESOURCE_TYPES });
      }
      if (url.pathname === "/api/resources" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        const type = body.type ?? "backend";
        if (!project || !NAME_RE.test(body.name ?? "") || !RESOURCE_TYPES.includes(type)) return sendJson(response, 400, { error: "Choose a project, a kebab-case resource name and a valid type." });
        const args = ["resource", body.name, "--type", type, "--yes"];
        for (const [flag, value, test] of [["--stack", body.stack, NAME_RE], ["--framework", body.framework, ID_RE], ["--language", body.language, ID_RE]]) {
          if (value == null || value === "") continue;
          if (typeof value !== "string" || !test.test(value)) return sendJson(response, 400, { error: `Invalid ${flag.slice(2)}.` });
          args.push(flag, value);
        }
        if (body.port != null && body.port !== "") {
          if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) return sendJson(response, 400, { error: "Invalid port." });
          args.push("--port", String(body.port));
        }
        const result = actionResult(await runCommand(project, args, { timeoutMs: 300_000 }));
        doctorCache.delete(project.id);
        invalidateStatus(project);
        return sendJson(response, 200, result);
      }
      if (url.pathname === "/api/stacks" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        const names = body.resources;
        if (!project || !NAME_RE.test(body.name ?? "") || !Array.isArray(names) || !names.length || names.length > 30 || !names.every((name) => typeof name === "string" && NAME_RE.test(name))) {
          return sendJson(response, 400, { error: "Choose a project, a kebab-case stack name and at least one resource." });
        }
        const result = actionResult(await runCommand(project, ["stack", body.name, "--resources", ...names, "--yes"], { timeoutMs: 120_000 }));
        invalidateStatus(project);
        return sendJson(response, 200, result);
      }
      if (url.pathname === "/api/tools" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        if (!project) return sendJson(response, 400, { error: "Choose a project." });
        let argv;
        if (Object.hasOwn(INFRA_TOOLS, body.tool)) {
          if (!INFRA_SERVICES.includes(body.service)) return sendJson(response, 400, { error: "Choose a supported infrastructure service." });
          argv = ["config", INFRA_TOOLS[body.tool], body.service];
        } else if (Object.hasOwn(TOOL_COMMANDS, body.tool)) {
          argv = TOOL_COMMANDS[body.tool].argv;
        } else return sendJson(response, 400, { error: "Choose a tool from the panel." });
        const mutates = Object.hasOwn(TOOL_COMMANDS, body.tool) ? TOOL_COMMANDS[body.tool].mutates : true;
        const raw = await runCommand(project, argv, { timeoutMs: 180_000 });
        if (mutates) {
          // Repairs and infra toggles change what status and doctor report, so drop the cached reads.
          invalidateStatus(project);
          doctorCache.delete(project.id);
        }
        return sendJson(response, 200, { ...actionResult(raw), tool: body.tool, argv: [cliCommandName(), ...argv] });
      }
      if (url.pathname === "/api/config" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        const commands = CONFIG_COMMANDS;
        if (!project || typeof body.operation !== "string" || !Object.hasOwn(commands, body.operation)) return sendJson(response, 400, { error: "Choose a project and regenerate, verify or migrate." });
        const started = Date.now();
        const raw = await runCommand(project, commands[body.operation], { timeoutMs: 120_000 });
        const result = actionResult(raw);
        const entry = { id: randomBytes(6).toString("hex"), at: new Date().toISOString(), project: project.id, name: project.name, action: body.operation, ok: result.ok, exitCode: raw.status ?? null, durationMs: Date.now() - started, output: result.output };
        configLogs.unshift(entry);
        if (configLogs.length > CONFIG_LOG_LIMIT) configLogs.length = CONFIG_LOG_LIMIT;
        // Regenerate and Migrate rewrite files, so an earlier drift check no longer describes them.
        if (body.operation === "verify") lastVerify.set(project.id, { ok: result.ok, at: entry.at, exitCode: entry.exitCode });
        else lastVerify.delete(project.id);
        return sendJson(response, 200, { ...result, entry });
      }
      if (url.pathname === "/api/state" && request.method === "GET") {
        const { knownRoots, ...visible } = appState;
        return sendJson(response, 200, visible);
      }
      if (url.pathname === "/api/state" && request.method === "PUT") {
        const body = await readBody(request);
        // Known projects and scan folders change only through Open project and Stop scanning, never from the page's state.
        const next = normalizeState({ ...appState, ...body, knownRoots: appState.knownRoots, scanRoots: appState.scanRoots });
        appState = next;
        if (statePath) writeAppState(appState, statePath);
        const { knownRoots, ...visible } = appState;
        return sendJson(response, 200, visible);
      }
      if (url.pathname === "/api/config/log" && request.method === "GET") {
        const project = projects.find((entry) => entry.id === url.searchParams.get("project"));
        if (!project) return sendJson(response, 400, { error: "Select a project." });
        return sendJson(response, 200, {
          status: lastVerify.get(project.id) ?? null,
          entries: configLogs.filter((entry) => entry.project === project.id).slice(0, 50),
        });
      }
      if (url.pathname === "/api/projects/add" && request.method === "POST") {
        // Registers an existing Flisk project that the scan did not find, for example one outside the common folders.
        // A folder with projects below it (such as ~/code) is saved as a scan folder and scanned at every start.
        const body = await readBody(request);
        const root = allowedParent(body.path);
        if (!root) return sendJson(response, 400, { error: "Choose an existing folder inside your home directory." });
        const scanFolder = !projectFile(root);
        const found = scanFolder ? discoverProjects({ currentRoot: null, scanRoots: [root] }) : resolveProjects(null, [root]);
        if (!found.length) return sendJson(response, 400, { error: "No Flisk project in that folder or below it. Choose a folder that contains .flisk (or one with projects inside), or create a new project." });
        if (scanFolder && !appState.scanRoots.includes(root) && appState.scanRoots.length >= MAX_SCAN_FOLDERS) {
          return sendJson(response, 409, { error: `FliskOS already scans ${MAX_SCAN_FOLDERS} folders. Stop scanning one first.` });
        }
        const added = found.filter((project) => !projects.some((entry) => entry.root === project.root));
        projects.push(...added);
        appState = normalizeState({
          ...appState,
          knownRoots: [...appState.knownRoots, ...found.map((project) => project.root)],
          scanRoots: scanFolder ? [...appState.scanRoots, root] : appState.scanRoots,
        });
        if (statePath) writeAppState(appState, statePath);
        const listed = (project) => ({ id: project.id, name: project.name, path: project.root });
        if (scanFolder) return sendJson(response, 200, { ok: true, scanFolder: { path: root, found: found.length, added: added.length }, scanRoots: appState.scanRoots, projects: found.map(listed) });
        return sendJson(response, 200, { ok: true, alreadyListed: !added.length, project: listed(found[0]) });
      }
      if (url.pathname === "/api/scan-folders/remove" && request.method === "POST") {
        // Stops scanning a saved folder. Projects already listed stay; hide any you no longer want.
        const body = await readBody(request);
        if (typeof body.path !== "string" || !body.path || body.path.includes("\0")) return sendJson(response, 400, { error: "Choose a scan folder." });
        // The page shows paths with the home folder as ~, so accept that form too.
        const target = body.path === "~" || body.path.startsWith("~/") ? join(homedir(), body.path.slice(1)) : body.path;
        const matches = (saved) => saved === target || resolvedPath(saved) === resolvedPath(target);
        if (!appState.scanRoots.some(matches)) return sendJson(response, 404, { error: "FliskOS does not scan that folder." });
        appState = normalizeState({ ...appState, scanRoots: appState.scanRoots.filter((saved) => !matches(saved)) });
        if (statePath) writeAppState(appState, statePath);
        return sendJson(response, 200, { ok: true, scanRoots: appState.scanRoots });
      }
      if (url.pathname === "/api/projects/create" && request.method === "POST") {
        const body = await readBody(request);
        const parent = allowedParent(body.parent);
        const template = body.template == null || body.template === "" ? null : body.template;
        if (!parent) return sendJson(response, 400, { error: "Choose an existing folder inside your home directory." });
        if (!NAME_RE.test(body.name ?? "")) return sendJson(response, 400, { error: "Project name must be kebab-case, for example my-shop." });
        if (template && !PROJECT_TEMPLATES.includes(template)) return sendJson(response, 400, { error: "Unknown template." });
        const target = join(parent, body.name);
        if (existsSync(target)) return sendJson(response, 409, { error: `${target} already exists.` });
        let result;
        if (template) {
          result = actionResult(await runCommand({ root: parent }, ["project", template, "--path", target, "--yes"], { timeoutMs: 300_000 }));
        } else {
          mkdirSync(target);
          result = actionResult(await runCommand({ root: target }, ["project", "--yes"], { timeoutMs: 120_000 }));
          if (!result.ok) { try { rmdirSync(target); } catch {} }
        }
        if (result.ok && projectFile(target)) {
          const [created] = resolveProjects(null, [target]);
          if (!projects.some((entry) => entry.root === created.root)) projects.push(created);
          return sendJson(response, 200, { ...result, project: { id: created.id, name: created.name, path: created.root } });
        }
        return sendJson(response, 200, { ...result, ok: false, output: result.output || "Flisk did not create a project here." });
      }
      if (url.pathname === "/api/ai/build" && request.method === "POST") {
        // Tries the Claude desktop app first. When it is not installed the client falls back to the web chats.
        const body = await readBody(request);
        if (typeof body.prompt !== "string" || !body.prompt || body.prompt.length > CLAUDE_PROMPT_LIMIT) return sendJson(response, 400, { error: "Choose a starter prompt of up to 14,000 characters." });
        const app = claudeDesktopApp();
        if (!app) return sendJson(response, 200, { ok: true, opened: null });
        await openAiApp(app, body.prompt);
        return sendJson(response, 200, { ok: true, opened: "claude-desktop" });
      }
      if (url.pathname === "/api/agents" && request.method === "GET") {
        return sendJson(response, 200, { providers: await hub.providers() });
      }
      if (url.pathname === "/api/agents/threads" && request.method === "GET") {
        return sendJson(response, 200, { threads: hub.list(url.searchParams.get("project") || null) });
      }
      if (url.pathname === "/api/agents/threads" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        const prompt = agentPrompt(body.prompt);
        if (!project) return sendJson(response, 400, { error: "Choose a project for the agent to work in." });
        if (!prompt) return sendJson(response, 400, { error: PROMPT_ERROR });
        const context = body.withStack === false ? null : stackContext(project, statusCache.get(project.id)?.snapshot);
        return sendJson(response, 202, { thread: hub.start({ project, provider: body.provider, mode: body.mode, prompt, context }) });
      }
      if (url.pathname === "/api/agents/thread" && request.method === "GET") {
        const thread = hub.get(url.searchParams.get("id") ?? "");
        // The page polls while an agent works; an unchanged thread answers with its version only.
        if (url.searchParams.get("version") === String(thread.version)) return sendJson(response, 200, { unchanged: true, version: thread.version, state: thread.state });
        return sendJson(response, 200, { thread });
      }
      if (url.pathname === "/api/agents/thread/send" && request.method === "POST") {
        const body = await readBody(request);
        const prompt = agentPrompt(body.prompt);
        if (!prompt) return sendJson(response, 400, { error: PROMPT_ERROR });
        return sendJson(response, 202, { thread: hub.send(String(body.id ?? ""), { prompt }) });
      }
      if (url.pathname === "/api/agents/thread/stop" && request.method === "POST") {
        const body = await readBody(request);
        return sendJson(response, 200, hub.stop(String(body.id ?? "")));
      }
      if (url.pathname === "/api/agents/thread/delete" && request.method === "POST") {
        const body = await readBody(request);
        return sendJson(response, 200, hub.remove(String(body.id ?? "")));
      }
      if (url.pathname === "/api/apps" && request.method === "GET") {
        const id = url.searchParams.get("project");
        const project = id ? projects.find((entry) => entry.id === id) : null;
        if (id && !project) return sendJson(response, 400, { error: "Select a project." });
        return sendJson(response, 200, { apps: appsForProject(project, project ? statusCache.get(project.id)?.snapshot?.resources ?? [] : []) });
      }
      if (url.pathname === "/api/open" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        if (!project || !["project", "terminal"].includes(body.kind)) return sendJson(response, 400, { error: "Choose a valid project and open action." });
        await openPath(project.root, body.kind);
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: "Not found." });
    })().catch((error) => {
      if (!response.headersSent) sendJson(response, error instanceof HttpError || error instanceof AgentError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  // Agents work in the user's projects, so none may outlive the server.
  server.once("close", () => hub.shutdown());
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolvePromise({ server, token, agents: hub, url: `http://127.0.0.1:${address.port}/?token=${token}` });
    });
  });
}

export function openProjectPath(root, kind) {
  let command;
  let args;
  if (kind === "project") {
    if (process.platform === "darwin") [command, args] = ["open", [root]];
    else if (process.platform === "win32") [command, args] = ["explorer.exe", [root]];
    else [command, args] = ["xdg-open", [root]];
  } else if (process.platform === "darwin") [command, args] = ["open", ["-a", "Terminal", root]];
  else if (process.platform === "win32") [command, args] = ["wt.exe", ["-d", root]];
  else [command, args] = ["x-terminal-emulator", ["--working-directory", root]];
  return spawnDetached(command, args, root, process.platform === "win32");
}

// Claude's own chat route takes the prompt in `q` and caps it at 14,336 characters.
export const CLAUDE_PROMPT_LIMIT = 14_336;

// Only macOS is checked, since that is where the Claude app's install location was verified. Other platforms get no desktop option.
export function findClaudeDesktopApp(platform = process.platform, exists = existsSync, home = homedir()) {
  if (platform !== "darwin") return null;
  for (const candidate of ["/Applications/Claude.app", join(home, "Applications", "Claude.app")]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

// `open -a <app> <url>` hands the claude:// link to the app at the path we found, not to whichever app claims the scheme.
// Resolves only when `open` exits 0, so a failed launch falls back to the web chooser instead of reporting success.
export function openInClaudeApp(app, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("open", ["-a", app, `claude://claude.ai/new?q=${encodeURIComponent(prompt)}`], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`open exited with code ${code}`))));
  });
}

export function openBrowser(url) {
  if (process.platform === "darwin") return spawnDetached("open", [url]);
  if (process.platform === "win32") return spawnDetached("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  return spawnDetached("xdg-open", [url]);
}

function spawnDetached(command, args, cwd, windowsHide = true) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}
