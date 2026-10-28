// The agent runner: drives the coding-agent CLIs installed on this machine (Claude Code, Codex, Cursor Agent,
// Grok Build and fx) inside a Flisk project, one process per turn, and keeps each conversation as a thread.
// FliskOS holds no model keys: every agent runs on the login the user already has for it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const AGENT_MODES = ["plan", "edit"];
export const AGENT_PROMPT_LIMIT = 20_000;
export const MAX_RUNNING_TURNS = 4;
const MAX_EVENTS = 400;
const MAX_TEXT = 8_000;
const MAX_OUTPUT = 2_000;
const MAX_THREADS = 200;
const TURN_TIMEOUT_MS = 30 * 60_000;
const VERSION_TTL_MS = 60_000;
const THREAD_ID_RE = /^[a-f0-9]{12}$/;

// ACP agents ask before they act. Reading is always allowed, "Edit files" adds edits, and commands are always refused.
const READ_KINDS = ["read", "search", "fetch", "think"];
const ACP_MODES = {
  plan: "Reads freely. Every edit or command it asks for is refused.",
  edit: "File edits it asks for are allowed. Commands are refused.",
};

export class AgentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A prompt that starts with "-" would be parsed as an option, so a leading space keeps it a plain argument.
export function promptArg(prompt) {
  return prompt.startsWith("-") ? ` ${prompt}` : prompt;
}

// Each provider says how to run one turn headless. `stream` agents print NDJSON and exit; `acp` agents speak the
// Agent Client Protocol (JSON-RPC over stdio), which is how T3 Code drives Grok and fx too.
export const AGENT_PROVIDERS = [
  {
    id: "claude",
    label: "Claude Code",
    binaries: ["claude"],
    transport: "stream",
    stdin: true,
    install: "https://claude.com/product/claude-code",
    login: "claude auth login",
    modes: { plan: "Plan mode: reads and plans, no edits or commands.", edit: "Edits files. Shell commands run only if your Claude Code settings allow them." },
    args: ({ mode, resume }) => ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode === "edit" ? "acceptEdits" : "plan", ...(resume ? ["--resume", resume] : [])],
    parse: parseClaudeEvent,
  },
  {
    id: "codex",
    label: "Codex",
    binaries: ["codex"],
    transport: "stream",
    stdin: true,
    install: "https://developers.openai.com/codex/cli",
    login: "codex login",
    modes: { plan: "Read-only sandbox.", edit: "Edits files and runs commands inside the project sandbox, without network." },
    // The same argv the Codex TypeScript SDK builds; the prompt goes to stdin.
    args: ({ mode, resume }) => ["exec", "--experimental-json", "--skip-git-repo-check", "--sandbox", mode === "edit" ? "workspace-write" : "read-only", "--config", 'approval_policy="never"', ...(resume ? ["resume", resume] : [])],
    parse: parseCodexEvent,
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    binaries: ["cursor-agent"],
    transport: "stream",
    stdin: false,
    install: "https://cursor.com/cli",
    login: "cursor-agent login",
    modes: { plan: "Plan mode: reads and proposes, no edits.", edit: "Edits files. Shell commands run only if your Cursor settings allow them." },
    args: ({ mode, resume, prompt }) => ["-p", "--output-format", "stream-json", "--trust", ...(mode === "plan" ? ["--mode", "plan"] : []), ...(resume ? ["--resume", resume] : []), promptArg(prompt)],
    parse: parseCursorEvent,
  },
  {
    id: "grok",
    label: "Grok Build",
    binaries: ["grok"],
    transport: "acp",
    acpArgs: ["agent", "stdio"],
    install: "https://x.ai/cli",
    login: "grok login",
    modes: ACP_MODES,
  },
  {
    id: "fx",
    label: "fx",
    binaries: ["fx"],
    transport: "acp",
    acpArgs: ["acp"],
    install: "https://fx.sh",
    login: "fx login",
    modes: ACP_MODES,
  },
];

// ---------- Finding the agent CLIs ----------
// Apps opened from Finder get a short PATH, so the usual install folders are searched too.
function searchDirs(env = process.env) {
  const home = homedir();
  const preferred = [join(home, ".local", "bin"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin"), join(home, ".cursor", "bin"), join(home, ".fx", "bin"), join(home, ".grok", "bin")];
  return [...new Set([...preferred, ...(env.PATH ?? "").split(delimiter).filter(Boolean)])];
}

export function agentEnv(env = process.env) {
  return { ...env, PATH: searchDirs(env).join(delimiter) };
}

export function locateAgent(provider, env = process.env) {
  for (const name of provider.binaries) {
    for (const dir of searchDirs(env)) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

// `<agent> --version`, first line only. Answers null when the agent does not answer within five seconds.
export function agentVersion(command, prefix = [], env = process.env) {
  return new Promise((resolvePromise) => {
    let output = "";
    let child;
    try {
      child = spawn(command, [...prefix, "--version"], { env: agentEnv(env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      return resolvePromise(null);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", () => { clearTimeout(timer); resolvePromise(null); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const line = output.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
      resolvePromise(code === 0 && line ? line.slice(0, 80) : null);
    });
  });
}

// ---------- Turning each agent's output into one event list ----------
// Events: user, text, thinking, tool (title, status, output), plan, status and error.
const oneLine = (text, max = 160) => {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};
const clip = (text, max) => (typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text);

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => (typeof item === "string" ? item : item?.type === "text" ? item.text : "")).filter(Boolean).join("\n");
}

// Names a tool call by whichever argument says what it acts on: the command, the file, the pattern.
export function describeTool(name, input) {
  const keys = ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"];
  const value = input && typeof input === "object" ? keys.map((key) => input[key]).find((item) => typeof item === "string" && item.trim()) : null;
  const label = typeof name === "string" && name ? name : "Tool";
  return value ? `${label} · ${oneLine(value)}` : label;
}

export function parseClaudeEvent(event, rec) {
  if (event.type === "system" && event.subtype === "init") {
    rec.session(event.session_id);
    if (event.model) rec.add({ kind: "status", text: `Model ${event.model}` });
    return;
  }
  if (event.type === "assistant") {
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block?.type === "text" && block.text) rec.add({ kind: "text", text: block.text });
      else if (block?.type === "thinking" && block.thinking) rec.add({ kind: "thinking", text: block.thinking });
      else if (block?.type === "tool_use") rec.upsert(`tool:${block.id}`, { kind: "tool", title: describeTool(block.name, block.input), status: "running" });
    }
    return;
  }
  if (event.type === "user") {
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block?.type === "tool_result") rec.upsert(`tool:${block.tool_use_id}`, { kind: "tool", status: block.is_error ? "failed" : "done", output: textOf(block.content) });
    }
    return;
  }
  if (event.type === "result") {
    rec.session(event.session_id);
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    for (const denial of denials) rec.upsert(`tool:${denial.tool_use_id}`, { kind: "tool", title: describeTool(denial.tool_name, denial.tool_input), status: "refused" });
    if (denials.length) rec.add({ kind: "status", text: `Refused ${denials.length} tool call${denials.length === 1 ? "" : "s"} this mode does not allow.` });
    const ok = event.subtype === "success" && !event.is_error;
    rec.finish({ ok, error: ok ? null : oneLine(event.result || event.subtype || "Claude Code reported an error.", 600), costUsd: event.total_cost_usd, durationMs: event.duration_ms });
  }
}

function codexCommandStatus(item) {
  if (item.status === "declined") return "refused";
  if (item.status === "failed" || (item.status === "completed" && item.exit_code != null && item.exit_code !== 0)) return "failed";
  return item.status === "completed" ? "done" : "running";
}

export function parseCodexEvent(event, rec) {
  if (event.type === "thread.started") return rec.session(event.thread_id);
  if (typeof event.type === "string" && event.type.startsWith("item.")) {
    const item = event.item ?? {};
    const key = `item:${item.id}`;
    const done = event.type === "item.completed";
    if (item.type === "agent_message" && item.text) rec.upsert(key, { kind: "text", text: item.text });
    else if (item.type === "reasoning" && item.text) rec.upsert(key, { kind: "thinking", text: item.text });
    else if (item.type === "command_execution") rec.upsert(key, { kind: "tool", title: `$ ${oneLine(item.command)}`, status: codexCommandStatus(item), output: item.aggregated_output || undefined });
    else if (item.type === "file_change") rec.upsert(key, { kind: "tool", title: `Edit ${(item.changes ?? []).map((change) => change.path).join(", ")}`, status: item.status === "failed" ? "failed" : done ? "done" : "running" });
    else if (item.type === "mcp_tool_call") rec.upsert(key, { kind: "tool", title: `${item.server}.${item.tool}`, status: item.status === "failed" ? "failed" : item.status === "completed" ? "done" : "running" });
    else if (item.type === "web_search") rec.upsert(key, { kind: "tool", title: `Web search · ${oneLine(item.query)}`, status: done ? "done" : "running" });
    else if (item.type === "todo_list") rec.upsert(key, { kind: "plan", text: (item.items ?? []).map((entry) => `${entry.completed ? "✓" : "○"} ${entry.text}`).join("\n") });
    else if (item.type === "error" && item.message) rec.add({ kind: "error", text: item.message });
    return;
  }
  if (event.type === "turn.completed") return rec.finish({ ok: true });
  if (event.type === "turn.failed") return rec.finish({ ok: false, error: event.error?.message ?? "Codex reported a failed turn." });
  if (event.type === "error" && event.message) rec.add({ kind: "error", text: event.message });
}

export function parseCursorEvent(event, rec) {
  if (event.type === "system" && event.subtype === "init") {
    rec.session(event.session_id);
    if (event.model) rec.add({ kind: "status", text: `Model ${event.model}` });
    return;
  }
  if (event.type === "assistant") {
    const text = textOf(event.message?.content);
    if (text) rec.add({ kind: "text", text });
    return;
  }
  if (event.type === "tool_call") {
    // `tool_call` holds one entry such as { readToolCall: { args } } or { function: { name, arguments } }.
    const [rawName, call] = Object.entries(event.tool_call ?? {})[0] ?? [];
    let name = rawName === "function" ? call?.name : rawName?.replace(/ToolCall$/, "");
    let input = call?.args;
    if (rawName === "function" && typeof call?.arguments === "string") {
      try { input = JSON.parse(call.arguments); } catch { name = `${name} · ${oneLine(call.arguments)}`; }
    }
    const key = `tool:${event.call_id}`;
    if (event.subtype === "started") rec.upsert(key, { kind: "tool", title: describeTool(name, input), status: "running" });
    else if (event.subtype === "completed") {
      const result = call?.result && typeof call.result === "object" ? call.result : {};
      rec.upsert(key, { kind: "tool", status: result.rejected ? "refused" : result.error || result.failure ? "failed" : "done" });
    }
    return;
  }
  if (event.type === "result") {
    rec.session(event.session_id);
    const ok = event.subtype === "success" && !event.is_error;
    rec.finish({ ok, error: ok ? null : oneLine(event.result || "Cursor Agent reported an error.", 600), durationMs: event.duration_ms });
  }
}

const ACP_STATUS = { pending: "running", in_progress: "running", completed: "done", failed: "failed" };

function acpContentText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (item?.type === "content" && item.content?.type === "text") return item.content.text;
    if (item?.type === "diff" && item.path) return `Changed ${item.path}`;
    return "";
  }).filter(Boolean).join("\n");
}

export function applyAcpUpdate(update, rec) {
  const kind = update?.sessionUpdate;
  if ((kind === "agent_message_chunk" || kind === "agent_thought_chunk") && update.content?.type === "text") {
    rec.chunk(kind === "agent_message_chunk" ? "text" : "thinking", update.messageId, update.content.text);
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    const key = `tool:${update.toolCallId}`;
    const fields = { kind: "tool" };
    if (update.title) fields.title = oneLine(update.title, 300);
    else if (kind === "tool_call") fields.title = update.kind ?? "Tool";
    const status = ACP_STATUS[update.status] ?? (kind === "tool_call" ? "running" : null);
    // A call FliskOS refused stays "refused" when the agent then reports it as failed.
    if (status && !(status === "failed" && rec.get(key)?.status === "refused")) fields.status = status;
    const output = acpContentText(update.content);
    if (output) fields.output = output;
    rec.upsert(key, fields);
  } else if (kind === "plan") {
    const mark = { completed: "✓", in_progress: "→" };
    rec.upsert("plan", { kind: "plan", text: (update.entries ?? []).map((entry) => `${mark[entry.status] ?? "○"} ${entry.content}`).join("\n") });
  }
}

// Answers an ACP permission request under the thread's mode. Only `allow_once` is ever chosen, never `allow_always`,
// so nothing is remembered in the agent's own settings.
export function decidePermission(params, mode) {
  const kind = params?.toolCall?.kind ?? "other";
  const wanted = READ_KINDS.includes(kind) || (mode === "edit" && kind === "edit");
  const options = Array.isArray(params?.options) ? params.options : [];
  const pick = wanted
    ? options.find((option) => option?.kind === "allow_once")
    : options.find((option) => option?.kind === "reject_once") ?? options.find((option) => option?.kind === "reject_always");
  return {
    allowed: Boolean(wanted && pick),
    response: pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } },
  };
}

// ---------- One turn's event list ----------
export function createRecorder(turn, changed = () => {}) {
  const keyed = new Map();
  let open = null; // the text or thinking segment that ACP chunks without a message id keep appending to
  let segments = 0;
  const clean = (fields) => {
    const event = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      event[key] = key === "text" ? clip(value, MAX_TEXT) : key === "output" ? clip(value, MAX_OUTPUT) : key === "title" ? clip(value, 300) : value;
    }
    return event;
  };
  const recorder = {
    finished: false,
    get(key) {
      return keyed.get(key) ?? null;
    },
    add(fields, key = null) {
      const event = clean(fields);
      if (key) keyed.set(key, event);
      if (event.kind !== "text" && event.kind !== "thinking") open = null;
      turn.events.push(event);
      if (turn.events.length > MAX_EVENTS) turn.dropped += turn.events.splice(0, turn.events.length - MAX_EVENTS).length;
      changed();
      return event;
    },
    upsert(key, fields) {
      const existing = keyed.get(key);
      if (!existing) return recorder.add(fields, key);
      Object.assign(existing, clean(fields));
      changed();
      return existing;
    },
    chunk(kind, messageId, text) {
      if (typeof text !== "string" || !text) return;
      const key = messageId ? `${kind}:${messageId}` : open?.kind === kind ? open.key : `${kind}:segment-${(segments += 1)}`;
      const existing = keyed.get(key);
      if (existing) {
        existing.text = clip(`${existing.text ?? ""}${text}`, MAX_TEXT);
        changed();
      } else recorder.add({ kind, text }, key);
      open = { kind, key };
    },
    session(id) {
      if (typeof id === "string" && id) turn.session = id;
    },
    finish({ ok, error = null, stopped = false, costUsd, durationMs }) {
      if (recorder.finished) return;
      recorder.finished = true;
      turn.state = stopped ? "stopped" : ok ? "done" : "failed";
      turn.error = turn.state === "failed" ? clip(error || "The agent stopped without saying why.", MAX_OUTPUT) : null;
      if (Number.isFinite(costUsd)) turn.costUsd = costUsd;
      if (Number.isFinite(durationMs)) turn.durationMs = durationMs;
      turn.endedAt = Date.now();
      changed(true);
    },
  };
  return recorder;
}

// ---------- ACP client for one turn ----------
function acpTurn({ child, provider, cwd, prompt, mode, resume, rec, version }) {
  let nextId = 1;
  let live = false;
  let sessionId = null;
  const pending = new Map();
  const send = (message) => {
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const request = (method, params) => new Promise((resolvePromise, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve: resolvePromise, reject });
    send({ id, method, params });
  });
  const onMessage = (message) => {
    if (message.id != null && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || `${provider.label} answered with error ${message.error.code}.`));
      else waiter.resolve(message.result ?? {});
      return;
    }
    // Loading a session replays its history as updates; only this turn's updates are recorded.
    if (message.method === "session/update") {
      if (live) applyAcpUpdate(message.params?.update, rec);
      return;
    }
    if (message.method === "session/request_permission" && message.id != null) {
      const decision = decidePermission(message.params, mode);
      const call = message.params?.toolCall ?? {};
      rec.add({ kind: "status", text: `${decision.allowed ? "Allowed" : "Refused"}: ${oneLine(call.title || call.kind || "a tool call")}` });
      if (!decision.allowed && call.toolCallId) rec.upsert(`tool:${call.toolCallId}`, { kind: "tool", title: call.title ? oneLine(call.title, 300) : undefined, status: "refused" });
      send({ id: message.id, result: decision.response });
      return;
    }
    // FliskOS offers no file system or terminal to the agent, so those requests are declined.
    if (message.id != null && message.method) send({ id: message.id, error: { code: -32601, message: `FliskOS does not provide ${message.method}.` } });
  };
  const run = (async () => {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fliskos", title: "FliskOS", version } });
    if (resume && init?.agentCapabilities?.loadSession) {
      await request("session/load", { sessionId: resume, cwd, mcpServers: [] });
      sessionId = resume;
    } else {
      if (resume) rec.add({ kind: "status", text: `${provider.label} cannot reopen the earlier session, so this turn starts a new one.` });
      sessionId = (await request("session/new", { cwd, mcpServers: [] }))?.sessionId ?? null;
    }
    if (typeof sessionId !== "string" || !sessionId) throw new Error(`${provider.label} did not open a session.`);
    rec.session(sessionId);
    live = true;
    const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    const reason = result?.stopReason ?? "end_turn";
    rec.finish({ ok: reason === "end_turn", stopped: reason === "cancelled", error: `${provider.label} stopped: ${reason}.` });
  })();
  return {
    run,
    onMessage,
    cancel() {
      if (sessionId) send({ method: "session/cancel", params: { sessionId } });
    },
    fail(error) {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    },
  };
}

// ---------- Threads ----------
function summary(thread, providers, running) {
  const last = thread.turns.at(-1);
  return {
    id: thread.id,
    project: thread.project,
    projectName: thread.projectName,
    provider: thread.provider,
    providerLabel: providers.find((provider) => provider.id === thread.provider)?.label ?? thread.provider,
    mode: thread.mode,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    state: running ? "running" : last?.state ?? "done",
    turns: thread.turns.length,
    version: thread.version,
  };
}

function validThread(value) {
  return value && typeof value === "object" && THREAD_ID_RE.test(value.id ?? "") && typeof value.project === "string" && typeof value.root === "string" && Array.isArray(value.turns);
}

export function createAgentHub({ dir = null, providers = AGENT_PROVIDERS, locate = locateAgent, versionOf = agentVersion, spawnProcess = spawn, env = process.env, maxRunning = MAX_RUNNING_TURNS, appVersion = "0.0.0", turnTimeoutMs = TURN_TIMEOUT_MS } = {}) {
  const threads = new Map();
  const running = new Map();
  const saveTimers = new Map();
  const versions = new Map();
  const file = (id) => join(dir, `${id}.json`);

  const save = (thread) => {
    clearTimeout(saveTimers.get(thread.id));
    saveTimers.delete(thread.id);
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${file(thread.id)}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(thread));
      renameSync(temp, file(thread.id));
    } catch {}
  };
  // While a turn streams, write at most every 1.5 seconds; a finished turn is written at once.
  const saveSoon = (thread) => {
    if (!dir || saveTimers.has(thread.id)) return;
    const timer = setTimeout(() => save(thread), 1500);
    timer.unref?.();
    saveTimers.set(thread.id, timer);
  };

  if (dir && existsSync(dir)) {
    const loaded = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (!validThread(value)) continue;
        // A turn still marked running was cut off when FliskOS last quit.
        for (const turn of value.turns) if (turn.state === "running") Object.assign(turn, { state: "interrupted", endedAt: value.updatedAt ?? null });
        loaded.push(value);
      } catch {}
    }
    loaded.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    for (const thread of loaded.slice(0, MAX_THREADS)) threads.set(thread.id, thread);
  }

  const providerFor = (id) => providers.find((provider) => provider.id === id) ?? null;
  const resolveCommand = (provider) => {
    const found = locate(provider, env);
    if (!found) return null;
    return Array.isArray(found) ? { command: found[0], prefix: found.slice(1) } : { command: found, prefix: [] };
  };
  const touch = (thread) => {
    thread.version += 1;
    thread.updatedAt = Date.now();
  };

  const startTurn = (thread, prompt, context) => {
    const provider = providerFor(thread.provider);
    if (!provider) throw new AgentError(400, "Choose an agent FliskOS knows.");
    if (running.has(thread.id)) throw new AgentError(409, "This thread is already working. Wait for it or stop it.");
    if (running.size >= maxRunning) throw new AgentError(429, `${maxRunning} agents are already working. Wait for one to finish or stop one.`);
    const launch = resolveCommand(provider);
    if (!launch) throw new AgentError(409, `${provider.label} is not installed. Install it from ${provider.install}, run \`${provider.login}\` once, then try again.`);

    const turn = { id: randomBytes(6).toString("hex"), prompt, withStack: Boolean(context), state: "running", startedAt: Date.now(), endedAt: null, events: [], dropped: 0, error: null, session: null };
    thread.turns.push(turn);
    const rec = createRecorder(turn, (final = false) => {
      touch(thread);
      if (final) {
        if (turn.session) thread.session = turn.session;
        save(thread);
      } else saveSoon(thread);
    });
    rec.add({ kind: "user", text: prompt });

    // The stack summary goes after the user's own words, and only to the agent, not into the transcript.
    const fullPrompt = context ? `${prompt}\n\n---\n${context}` : prompt;
    const resume = thread.session;
    const args = provider.transport === "acp" ? provider.acpArgs : provider.args({ mode: thread.mode, resume, prompt: fullPrompt });
    const pipeIn = provider.transport === "acp" || provider.stdin;
    let child;
    try {
      child = spawnProcess(launch.command, [...launch.prefix, ...args], { cwd: thread.root, env: agentEnv(env), stdio: [pipeIn ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      rec.finish({ ok: false, error: `Could not start ${provider.label}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const entry = { child, turn, stopped: false, acp: null };
    running.set(thread.id, entry);
    // Only this turn's own entry is released: a reply can start the next turn before this process has exited.
    const release = () => {
      if (running.get(thread.id) === entry) running.delete(thread.id);
    };
    child.stdin?.on("error", () => {});

    let stderr = "";
    let noise = "";
    const tail = (text, chunk) => `${text}${chunk}`.slice(-2000);
    const loginHint = (text) => (/(log ?in|sign(ed)? in|auth|api key|credentials)/i.test(text) ? `\nRun \`${provider.login}\` in a terminal once, then try again.` : "");
    const failure = (fallback) => {
      const text = (stderr || noise).trim() || fallback;
      return `${text}${loginHint(text)}`;
    };

    if (provider.transport === "acp") {
      entry.acp = acpTurn({ child, provider, cwd: thread.root, prompt: fullPrompt, mode: thread.mode, resume, rec, version: appVersion });
      entry.acp.run.catch((error) => {
        rec.finish({ ok: false, stopped: entry.stopped, error: failure(error instanceof Error ? error.message : String(error)) });
      }).finally(() => {
        // An ACP agent keeps running after a turn; close it once the turn is over.
        release();
        touch(thread);
        child.stdin?.end();
        setTimeout(() => child.kill("SIGTERM"), 1000).unref?.();
      });
    } else if (provider.stdin) child.stdin.end(fullPrompt);

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { noise = tail(noise, `${line}\n`); continue; }
        if (!message || typeof message !== "object") continue;
        try {
          if (entry.acp) entry.acp.onMessage(message);
          else provider.parse(message, rec);
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr, chunk.toString()); });
    const timer = setTimeout(() => {
      rec.finish({ ok: false, error: `${provider.label} ran longer than ${Math.round(turnTimeoutMs / 60_000)} minutes and was stopped.` });
      child.kill("SIGTERM");
    }, turnTimeoutMs);
    timer.unref?.();
    const done = (code, error) => {
      clearTimeout(timer);
      release();
      entry.acp?.fail(new Error(failure(`${provider.label} exited.`)));
      if (error) rec.finish({ ok: false, error: `Could not start ${provider.label}: ${error.message}` });
      // An ACP turn ends with its prompt answer, so an ACP agent that exits first failed whatever its exit code.
      else rec.finish({ ok: !entry.acp && code === 0, stopped: entry.stopped, error: failure(`${provider.label} exited with code ${code}.`) });
      touch(thread);
      save(thread);
    };
    child.once("error", (error) => done(null, error));
    child.once("close", (code) => done(code, null));
  };

  return {
    async providers() {
      return Promise.all(providers.map(async (provider) => {
        const launch = resolveCommand(provider);
        let version = null;
        if (launch) {
          const cached = versions.get(provider.id);
          if (cached && cached.command === launch.command && Date.now() - cached.at < VERSION_TTL_MS) version = cached.version;
          else {
            version = await versionOf(launch.command, launch.prefix, env);
            versions.set(provider.id, { command: launch.command, version, at: Date.now() });
          }
        }
        return { id: provider.id, label: provider.label, installed: Boolean(launch), version, transport: provider.transport, modes: provider.modes, install: provider.install, login: provider.login };
      }));
    },
    list(projectId = null) {
      return [...threads.values()]
        .filter((thread) => !projectId || thread.project === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((thread) => summary(thread, providers, running.has(thread.id)));
    },
    get(id) {
      const thread = threads.get(id);
      if (!thread) throw new AgentError(404, "That thread is gone.");
      const { root, ...visible } = thread;
      return { ...visible, ...summary(thread, providers, running.has(id)), turns: thread.turns };
    },
    start({ project, provider, mode, prompt, context = null }) {
      const known = providerFor(provider);
      if (!known) throw new AgentError(400, "Choose an agent FliskOS knows.");
      if (!AGENT_MODES.includes(mode)) throw new AgentError(400, "Choose Read only or Edit files.");
      const now = Date.now();
      const thread = { id: randomBytes(6).toString("hex"), project: project.id, projectName: project.name, root: project.root, provider, mode, title: oneLine(prompt, 60), createdAt: now, updatedAt: now, session: null, version: 0, turns: [] };
      startTurn(thread, prompt, context);
      threads.set(thread.id, thread);
      // Keep the newest threads; the oldest idle one goes first.
      if (threads.size > MAX_THREADS) {
        const oldest = [...threads.values()].filter((entry) => !running.has(entry.id)).sort((left, right) => left.updatedAt - right.updatedAt)[0];
        if (oldest) this.remove(oldest.id);
      }
      save(thread);
      return this.get(thread.id);
    },
    send(id, { prompt, context = null }) {
      const thread = threads.get(id);
      if (!thread) throw new AgentError(404, "That thread is gone.");
      startTurn(thread, prompt, context);
      save(thread);
      return this.get(id);
    },
    stop(id) {
      const entry = running.get(id);
      if (!entry) throw new AgentError(409, "Nothing is running in this thread.");
      entry.stopped = true;
      const exited = () => entry.child.exitCode != null || entry.child.signalCode != null;
      // An ACP agent is asked to cancel first and gets a second to wrap up; a stream agent is stopped at once.
      if (entry.acp) {
        entry.acp.cancel();
        setTimeout(() => { if (!exited()) entry.child.kill("SIGTERM"); }, 1000).unref?.();
      } else entry.child.kill("SIGTERM");
      setTimeout(() => { if (!exited()) entry.child.kill("SIGKILL"); }, 3000).unref?.();
      return { ok: true };
    },
    remove(id) {
      if (running.has(id)) throw new AgentError(409, "Stop the thread before you delete it.");
      if (!threads.delete(id)) throw new AgentError(404, "That thread is gone.");
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      if (dir) try { rmSync(file(id), { force: true }); } catch {}
      return { ok: true };
    },
    isRunning(id) {
      return running.has(id);
    },
    shutdown() {
      for (const entry of running.values()) {
        entry.stopped = true;
        entry.child.kill("SIGTERM");
      }
      for (const thread of threads.values()) save(thread);
    },
  };
}
