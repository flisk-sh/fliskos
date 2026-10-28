import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { AGENT_PROMPT_LIMIT, AgentError, applyAcpUpdate, createAgentHub, createRecorder, decidePermission, describeTool, parseClaudeEvent, parseCodexEvent, parseCursorEvent, promptArg } from "../src/agents.js";
import { startAppServer } from "../src/app.js";

const FAKE_STREAM = fileURLToPath(new URL("./fixtures/fake-stream-agent.mjs", import.meta.url));
const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const CLAUDE_TURN = fileURLToPath(new URL("./fixtures/claude-plan-turn.ndjson", import.meta.url));

const hubs = [];
const servers = [];
const dirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const hub of hubs.splice(0)) hub.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function projectFixture(name = "shop") {
  return { id: `project-${name}`, name, root: tempDir("fliskos-agent-project-") };
}

function hubWith(locations, options = {}) {
  const hub = createAgentHub({ locate: (provider) => locations[provider.id] ?? null, versionOf: async () => "1.0.0 (fake)", ...options });
  hubs.push(hub);
  return hub;
}

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the agent.");
}

const settle = (hub, id) => until(() => {
  const thread = hub.get(id);
  return thread.state !== "running" ? thread : null;
});

const lastTurn = (thread) => thread.turns.at(-1);
const echoOf = (turn) => {
  const event = turn.events.find((entry) => entry.kind === "text" && entry.text.startsWith("echo:"));
  return event ? JSON.parse(event.text.slice(5)) : null;
};

function recorded(lines, parse) {
  const turn = { events: [], dropped: 0 };
  const rec = createRecorder(turn);
  for (const line of lines) parse(line, rec);
  return turn;
}

describe("agent output parsers", () => {
  it("reads a recorded Claude Code plan-mode turn", () => {
    const lines = readFileSync(CLAUDE_TURN, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const turn = recorded(lines, parseClaudeEvent);
    assert.deepEqual(turn.events.map((event) => [event.kind, event.title ?? event.text, event.status ?? null]), [
      ["status", "Model claude-opus-5[1m]", null],
      ["tool", "Read · /work/note.txt", "done"],
      ["text", "hello", null],
    ]);
    assert.equal(turn.events[1].output, "1\thello\n2\t");
    assert.equal(turn.state, "done");
    assert.equal(turn.session, "c8e18bcf-e7e4-4ff4-a6b5-e85d30bf05e2");
    assert.equal(turn.costUsd, 0.5097755);
    assert.equal(turn.durationMs, 7020);
  });

  it("marks Claude Code tool calls the mode refused and reports a failed result", () => {
    const turn = recorded([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "rm -rf build" } }] } },
      { type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: "s1", permission_denials: [{ tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "rm -rf build" } }] },
    ], parseClaudeEvent);
    assert.equal(turn.events[0].status, "refused");
    assert.equal(turn.events[0].title, "Bash · rm -rf build");
    assert.match(turn.events[1].text, /Refused 1 tool call/);
    assert.equal(turn.state, "failed");
    assert.equal(turn.error, "boom");
  });

  it("reads Codex exec JSON events", () => {
    const turn = recorded([
      { type: "thread.started", thread_id: "th_1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls -la", aggregated_output: "", exit_code: null, status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls -la", aggregated_output: "a\nb", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "c2", type: "command_execution", command: "npm test", aggregated_output: "1 failing", exit_code: 1, status: "completed" } },
      { type: "item.completed", item: { id: "c3", type: "command_execution", command: "curl example.com", aggregated_output: "", exit_code: null, status: "declined" } },
      { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "src/a.js", kind: "update" }], status: "completed" } },
      { type: "item.completed", item: { id: "t1", type: "todo_list", items: [{ text: "Read", completed: true }, { text: "Fix", completed: false }] } },
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
    ], parseCodexEvent);
    assert.deepEqual(turn.events.map((event) => [event.kind, event.title ?? event.text, event.status ?? null]), [
      ["tool", "$ ls -la", "done"],
      ["tool", "$ npm test", "failed"],
      ["tool", "$ curl example.com", "refused"],
      ["tool", "Edit src/a.js", "done"],
      ["plan", "✓ Read\n○ Fix", null],
      ["text", "Done", null],
    ]);
    assert.equal(turn.events[0].output, "a\nb");
    assert.equal(turn.session, "th_1");
    assert.equal(turn.state, "done");
    const failed = recorded([{ type: "turn.failed", error: { message: "usage limit reached" } }], parseCodexEvent);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "usage limit reached");
  });

  it("reads Cursor Agent stream-json events", () => {
    const turn = recorded([
      { type: "system", subtype: "init", session_id: "chat-1", model: "gpt-5" },
      { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "tool_call", subtype: "started", call_id: "c1", tool_call: { readToolCall: { args: { path: "README.md" } } } },
      { type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { readToolCall: { args: { path: "README.md" }, result: { success: { content: "x" } } } } },
      { type: "tool_call", subtype: "started", call_id: "c2", tool_call: { function: { name: "run_terminal_cmd", arguments: '{"command":"npm test"}' } } },
      { type: "tool_call", subtype: "completed", call_id: "c2", tool_call: { function: { name: "run_terminal_cmd", arguments: '{"command":"npm test"}', result: { rejected: { reason: "not allowed" } } } } },
      { type: "assistant", message: { content: [{ type: "text", text: "The README is short." }] } },
      { type: "result", subtype: "success", is_error: false, result: "The README is short.", session_id: "chat-1", duration_ms: 900 },
    ], parseCursorEvent);
    assert.deepEqual(turn.events.map((event) => [event.kind, event.title ?? event.text, event.status ?? null]), [
      ["status", "Model gpt-5", null],
      ["tool", "read · README.md", "done"],
      ["tool", "run_terminal_cmd · npm test", "refused"],
      ["text", "The README is short.", null],
    ]);
    assert.equal(turn.session, "chat-1");
    assert.equal(turn.state, "done");
  });

  it("merges ACP chunks into segments and updates tool calls in place", () => {
    const turn = { events: [], dropped: 0 };
    const rec = createRecorder(turn);
    for (const update of [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Think" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit app.js", kind: "edit", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "app.js", oldText: "a", newText: "b" }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m9", content: { type: "text", text: "A" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m9", content: { type: "text", text: "B" } },
      { sessionUpdate: "plan", entries: [{ content: "Read", status: "completed" }, { content: "Edit", status: "in_progress" }, { content: "Test", status: "pending" }] },
      { sessionUpdate: "usage_update", used: 1, size: 2 },
    ]) applyAcpUpdate(update, rec);
    assert.deepEqual(turn.events.map((event) => [event.kind, event.title ?? event.text, event.status ?? null]), [
      ["thinking", "Think", null],
      ["text", "Hello", null],
      ["tool", "Edit app.js", "done"],
      ["text", "After", null],
      ["text", "AB", null],
      ["plan", "✓ Read\n→ Edit\n○ Test", null],
    ]);
    assert.equal(turn.events[2].output, "Changed app.js");
  });

  it("keeps the event list bounded and counts what it dropped", () => {
    const turn = { events: [], dropped: 0 };
    const rec = createRecorder(turn);
    for (let index = 0; index < 450; index += 1) rec.add({ kind: "status", text: `line ${index}` });
    rec.add({ kind: "text", text: "x".repeat(20_000) });
    assert.equal(turn.events.length, 400);
    assert.equal(turn.dropped, 51);
    assert.equal(turn.events.at(-1).text.length, 8001);
  });
});

describe("ACP permission answers", () => {
  const options = [{ optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }];
  const ask = (kind, mode, choices = options) => decidePermission({ toolCall: { kind }, options: choices }, mode);

  it("allows reads in both modes, edits only in Edit files, and never commands", () => {
    assert.deepEqual(ask("read", "plan"), { allowed: true, response: { outcome: { outcome: "selected", optionId: "yes" } } });
    assert.equal(ask("edit", "plan").allowed, false);
    assert.equal(ask("edit", "plan").response.outcome.optionId, "no");
    assert.equal(ask("edit", "edit").response.outcome.optionId, "yes");
    assert.equal(ask("execute", "edit").response.outcome.optionId, "no");
    assert.equal(ask("delete", "edit").allowed, false);
    assert.equal(ask(undefined, "edit").allowed, false);
  });

  it("never picks allow_always and cancels when no fitting option exists", () => {
    assert.deepEqual(ask("edit", "edit", [{ optionId: "always", kind: "allow_always" }]), { allowed: false, response: { outcome: { outcome: "cancelled" } } });
    assert.deepEqual(ask("execute", "plan", [{ optionId: "yes", kind: "allow_once" }]), { allowed: false, response: { outcome: { outcome: "cancelled" } } });
  });
});

describe("agent helpers", () => {
  it("names tool calls by what they act on and keeps prompts from reading as options", () => {
    assert.equal(describeTool("Bash", { command: "npm   test\n--watch" }), "Bash · npm test --watch");
    assert.equal(describeTool("Read", { file_path: "/a/b.js" }), "Read · /a/b.js");
    assert.equal(describeTool("Think", {}), "Think");
    assert.equal(describeTool(undefined, null), "Tool");
    assert.equal(promptArg("--help me"), " --help me");
    assert.equal(promptArg("fix it"), "fix it");
  });
});

describe("agent hub: stream agents", () => {
  it("runs Claude Code headless in the project with the mode's flags and resumes the session on the next turn", async () => {
    const project = projectFixture();
    const hub = hubWith({ claude: [process.execPath, FAKE_STREAM] });
    const started = hub.start({ project, provider: "claude", mode: "edit", prompt: "Fix the login page", context: "Flisk project shop" });
    assert.equal(started.state, "running");
    assert.equal(started.title, "Fix the login page");
    const thread = await settle(hub, started.id);
    const turn = lastTurn(thread);
    assert.equal(turn.state, "done");
    assert.deepEqual(turn.events[0], { kind: "user", text: "Fix the login page" });
    assert.deepEqual(turn.events.find((event) => event.kind === "tool"), { kind: "tool", title: "Read · README.md", status: "done", output: "1\tREADME" });
    const echo = echoOf(turn);
    assert.deepEqual(echo.args, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
    assert.equal(echo.prompt, "Fix the login page\n\n---\nFlisk project shop");
    assert.equal(realpathSync(echo.cwd), realpathSync(project.root));
    assert.equal(turn.costUsd, 0.25);
    assert.equal(thread.session, "fake-session-1");
    assert.equal(thread.root, undefined, "the API view leaves out the project path");

    hub.send(thread.id, { prompt: "Now add a test" });
    const next = lastTurn(await settle(hub, thread.id));
    assert.deepEqual(echoOf(next).args.slice(-2), ["--resume", "fake-session-1"]);
    assert.equal(echoOf(next).prompt, "Now add a test");

    const plan = await settle(hub, hub.start({ project, provider: "claude", mode: "plan", prompt: "Just look" }).id);
    assert.equal(echoOf(lastTurn(plan)).args[5], "plan");
  });

  it("stops a running turn and records it as stopped", async () => {
    const hub = hubWith({ claude: [process.execPath, FAKE_STREAM] });
    const thread = hub.start({ project: projectFixture(), provider: "claude", mode: "plan", prompt: "WAIT here" });
    await until(() => echoOf(lastTurn(hub.get(thread.id))));
    assert.equal(hub.isRunning(thread.id), true);
    assert.deepEqual(hub.stop(thread.id), { ok: true });
    const stopped = await settle(hub, thread.id);
    assert.equal(lastTurn(stopped).state, "stopped");
    assert.equal(lastTurn(stopped).error, null);
    assert.throws(() => hub.stop(thread.id), (error) => error instanceof AgentError && error.status === 409);
  });

  it("reports a login failure with the agent's own login command", async () => {
    const hub = hubWith({ claude: [process.execPath, FAKE_STREAM] });
    const thread = await settle(hub, hub.start({ project: projectFixture(), provider: "claude", mode: "plan", prompt: "FAIL now" }).id);
    assert.equal(lastTurn(thread).state, "failed");
    assert.match(lastTurn(thread).error, /Not signed in/);
    assert.match(lastTurn(thread).error, /claude auth login/);
  });

  it("refuses agents that are not installed, unknown agents and modes, and too many at once", async () => {
    const project = projectFixture();
    const hub = hubWith({ claude: [process.execPath, FAKE_STREAM] }, { maxRunning: 1 });
    assert.throws(() => hub.start({ project, provider: "codex", mode: "plan", prompt: "hi" }), (error) => error.status === 409 && /Codex is not installed.*codex login/.test(error.message));
    assert.throws(() => hub.start({ project, provider: "nope", mode: "plan", prompt: "hi" }), (error) => error.status === 400);
    assert.throws(() => hub.start({ project, provider: "claude", mode: "yolo", prompt: "hi" }), (error) => error.status === 400);
    const first = hub.start({ project, provider: "claude", mode: "plan", prompt: "WAIT one" });
    assert.throws(() => hub.start({ project, provider: "claude", mode: "plan", prompt: "two" }), (error) => error.status === 429);
    assert.throws(() => hub.send(first.id, { prompt: "again" }), (error) => error.status === 409);
    assert.throws(() => hub.remove(first.id), (error) => error.status === 409);
    hub.stop(first.id);
    await settle(hub, first.id);
    assert.equal(hub.list().length, 1, "a refused start leaves no thread behind");
  });

  it("lists installed agents with their versions", async () => {
    const hub = hubWith({ claude: [process.execPath, FAKE_STREAM], fx: [process.execPath, FAKE_ACP] });
    const providers = await hub.providers();
    assert.deepEqual(providers.map((provider) => [provider.id, provider.installed, provider.version]), [
      ["claude", true, "1.0.0 (fake)"],
      ["codex", false, null],
      ["cursor", false, null],
      ["grok", false, null],
      ["fx", true, "1.0.0 (fake)"],
    ]);
    assert.match(providers[0].modes.edit, /Edits files/);
    assert.equal(providers[3].login, "grok login");
  });

  it("keeps threads on disk, marks cut-off turns as interrupted, and deletes them", async () => {
    const dir = tempDir("fliskos-threads-");
    const project = projectFixture();
    const first = hubWith({ claude: [process.execPath, FAKE_STREAM] }, { dir });
    const thread = await settle(first, first.start({ project, provider: "claude", mode: "plan", prompt: "Remember me" }).id);
    const file = join(dir, `${thread.id}.json`);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).turns[0].state, "done");

    const reopened = hubWith({}, { dir });
    assert.deepEqual(reopened.list().map((entry) => [entry.title, entry.state]), [["Remember me", "done"]]);

    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.turns[0].state = "running";
    writeFileSync(file, JSON.stringify(saved));
    writeFileSync(join(dir, "broken.json"), "{");
    const afterCrash = hubWith({}, { dir });
    assert.equal(afterCrash.get(thread.id).turns[0].state, "interrupted");
    afterCrash.remove(thread.id);
    assert.deepEqual(readdirSync(dir).filter((name) => name !== "broken.json"), []);
    assert.throws(() => afterCrash.get(thread.id), (error) => error.status === 404);
  });
});

describe("agent hub: ACP agents", () => {
  it("streams an ACP turn, refuses edits in Read only and FliskOS file reads", async () => {
    const hub = hubWith({ fx: [process.execPath, FAKE_ACP] });
    const thread = await settle(hub, hub.start({ project: projectFixture(), provider: "fx", mode: "plan", prompt: "FS check", context: "Stack: shop" }).id);
    const turn = lastTurn(thread);
    assert.equal(turn.state, "done");
    assert.equal(thread.session, "acp-session-1");
    const texts = turn.events.filter((event) => event.kind === "text").map((event) => event.text);
    assert.equal(texts[0], "Hello");
    assert(texts.includes("fs:refused"));
    assert.match(texts.at(-1), /^permission:no received:initialize,session\/new,session\/prompt prompt:"FS check\\n\\n---\\nStack: shop"$/);
    assert.deepEqual(turn.events.find((event) => event.kind === "tool"), { kind: "tool", title: "Edit app.js", status: "refused", output: "Changed app.js" });
    assert(turn.events.some((event) => event.kind === "status" && event.text === "Refused: Edit app.js"));
  });

  it("allows edits in Edit files and reloads the session on the next turn without repeating its history", async () => {
    const hub = hubWith({ grok: [process.execPath, FAKE_ACP] });
    const thread = await settle(hub, hub.start({ project: projectFixture(), provider: "grok", mode: "edit", prompt: "Edit it" }).id);
    assert.match(lastTurn(thread).events.at(-1).text, /^permission:yes /);
    assert.equal(lastTurn(thread).events.find((event) => event.kind === "tool").status, "done");

    hub.send(thread.id, { prompt: "Again" });
    const next = lastTurn(await settle(hub, thread.id));
    assert.match(next.events.at(-1).text, /received:initialize,session\/load,session\/prompt/);
    // The replayed history would otherwise open the transcript (and merge into the first chunk).
    assert.equal(next.events.find((event) => event.kind === "text").text, "Hello");
    assert(!next.events.some((event) => event.text?.includes("OLD HISTORY")));
  });

  it("starts a new session when the agent cannot load one", async () => {
    const hub = hubWith({ fx: [process.execPath, FAKE_ACP, "NOLOAD"] });
    const thread = await settle(hub, hub.start({ project: projectFixture(), provider: "fx", mode: "plan", prompt: "One" }).id);
    hub.send(thread.id, { prompt: "Two" });
    const next = lastTurn(await settle(hub, thread.id));
    assert(next.events.some((event) => event.kind === "status" && /cannot reopen the earlier session/.test(event.text)));
    assert.match(next.events.at(-1).text, /received:initialize,session\/new,session\/prompt/);
  });

  it("fails an ACP turn whose agent exits before it answers, even with exit code 0", async () => {
    const hub = hubWith({ fx: [process.execPath, FAKE_ACP] });
    const thread = await settle(hub, hub.start({ project: projectFixture(), provider: "fx", mode: "plan", prompt: "EXIT early" }).id);
    assert.equal(lastTurn(thread).state, "failed");
    assert.match(lastTurn(thread).error, /fx exited with code 0/);
    assert.equal(hub.isRunning(thread.id), false);
  });

  it("cancels an ACP turn when it is stopped", async () => {
    const hub = hubWith({ fx: [process.execPath, FAKE_ACP] });
    const thread = hub.start({ project: projectFixture(), provider: "fx", mode: "plan", prompt: "WAIT for it" });
    await until(() => lastTurn(hub.get(thread.id)).events.some((event) => event.text?.startsWith("permission:")));
    hub.stop(thread.id);
    const stopped = await settle(hub, thread.id);
    assert.equal(lastTurn(stopped).state, "stopped");
  });
});

describe("agents API", () => {
  async function serve(project, hub) {
    const started = await startAppServer({ projects: [project], port: 0, token: "test-session-token", dockerCheck: async () => true, probe: async () => ({ state: "supported", lifecycle: true }), runCommand: async () => ({ status: 1, stdout: "", stderr: "" }), agents: hub });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.server.address().port}`;
    return async (path, body, method = body ? "POST" : "GET") => {
      const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "x-flisk-token": "test-session-token", origin: base }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
  }

  it("lists agents, starts a thread with the stack summary, polls it and deletes it", async () => {
    const project = projectFixture();
    const call = await serve(project, hubWith({ claude: [process.execPath, FAKE_STREAM] }));
    const agents = await call("/api/agents");
    assert.equal(agents.status, 200);
    assert.deepEqual(agents.body.providers.filter((provider) => provider.installed).map((provider) => provider.id), ["claude"]);

    const created = await call("/api/agents/threads", { project: project.id, provider: "claude", mode: "plan", prompt: "  What runs here?  " });
    assert.equal(created.status, 202);
    const { id } = created.body.thread;
    const done = await until(async () => {
      const polled = await call(`/api/agents/thread?id=${id}`);
      return polled.body.thread.state === "done" ? polled.body.thread : null;
    });
    const echo = echoOf(lastTurn(done));
    assert.match(echo.prompt, /^What runs here\?\n\n---\nFlisk project "shop" at .+`flisk status --json`/s);
    assert.deepEqual(await call(`/api/agents/thread?id=${id}&version=${done.version}`), { status: 200, body: { unchanged: true, version: done.version, state: "done" } });
    assert.equal((await call("/api/agents/threads")).body.threads[0].id, id);
    assert.equal((await call(`/api/agents/threads?project=${project.id}`)).body.threads.length, 1);
    assert.equal((await call("/api/agents/threads?project=other")).body.threads.length, 0);

    const plain = await call("/api/agents/threads", { project: project.id, provider: "claude", mode: "plan", prompt: "No context", withStack: false });
    const plainDone = await until(async () => {
      const polled = await call(`/api/agents/thread?id=${plain.body.thread.id}`);
      return polled.body.thread.state === "done" ? polled.body.thread : null;
    });
    assert.equal(echoOf(lastTurn(plainDone)).prompt, "No context");

    assert.equal((await call("/api/agents/thread/stop", { id })).status, 409);
    assert.deepEqual(await call("/api/agents/thread/delete", { id }), { status: 200, body: { ok: true } });
    assert.equal((await call(`/api/agents/thread?id=${id}`)).status, 404);
  });

  it("rejects a missing project, an empty or oversized prompt and an unknown agent", async () => {
    const project = projectFixture();
    const call = await serve(project, hubWith({ claude: [process.execPath, FAKE_STREAM] }));
    assert.equal((await call("/api/agents/threads", { project: "nope", provider: "claude", mode: "plan", prompt: "hi" })).status, 400);
    assert.equal((await call("/api/agents/threads", { project: project.id, provider: "claude", mode: "plan", prompt: "   " })).status, 400);
    assert.equal((await call("/api/agents/threads", { project: project.id, provider: "claude", mode: "plan", prompt: "x".repeat(AGENT_PROMPT_LIMIT + 1) })).status, 400);
    assert.equal((await call("/api/agents/threads", { project: project.id, provider: "nope", mode: "plan", prompt: "hi" })).status, 400);
    assert.equal((await call("/api/agents/thread/send", { id: "missing0000", prompt: "hi" })).status, 404);
  });
});
