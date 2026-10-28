// Stands in for an ACP agent (`fx acp`, `grok agent stdio`): JSON-RPC over stdio. Each prompt streams two chunks,
// opens an edit tool call, asks for permission and reports the answer, then ends the turn.
// Prompt words: WAIT holds the turn until session/cancel, FS asks the client to read a file, EXIT quits with code 0
// without answering; the NOLOAD argument hides loadSession.
const received = [];
let nextId = 1;
const waiters = new Map();
let pendingPrompt = null;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const ask = (method, params) => new Promise((resolve) => {
  const id = `agent-${nextId++}`;
  waiters.set(id, resolve);
  send({ id, method, params });
});
const noLoad = process.argv.includes("NOLOAD");

async function prompt(id, { sessionId, prompt: blocks }) {
  const text = blocks?.[0]?.text ?? "";
  if (text.includes("EXIT")) process.exit(0);
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Edit app.js", kind: "edit", status: "pending" });
  const answer = await ask("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "call-1", title: "Edit app.js", kind: "edit" },
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
  });
  const chosen = answer.result?.outcome?.optionId ?? answer.result?.outcome?.outcome;
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: chosen === "yes" ? "completed" : "failed", content: [{ type: "diff", path: "app.js", oldText: "a", newText: "b" }] });
  if (text.includes("FS")) {
    const read = await ask("fs/read_text_file", { sessionId, path: "app.js" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: `fs:${read.error ? "refused" : "read"}` } });
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m3", content: { type: "text", text: `permission:${chosen} received:${received.join(",")} prompt:${JSON.stringify(text)}` } });
  if (text.includes("WAIT")) {
    pendingPrompt = id;
    return;
  }
  send({ id, result: { stopReason: "end_turn" } });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method) received.push(message.method);
    if (!message.method && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    } else if (message.method === "initialize") {
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: !noLoad } } });
    } else if (message.method === "session/new") {
      send({ id: message.id, result: { sessionId: "acp-session-1" } });
    } else if (message.method === "session/load") {
      // A load replays history first; FliskOS must not record it again.
      update(message.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } });
      send({ id: message.id, result: null });
    } else if (message.method === "session/prompt") {
      void prompt(message.id, message.params);
    } else if (message.method === "session/cancel" && pendingPrompt != null) {
      send({ id: pendingPrompt, result: { stopReason: "cancelled" } });
      pendingPrompt = null;
    }
  }
});
