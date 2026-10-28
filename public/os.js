// The FliskOS views next to the projects: Agents (coding agents working in a project, like T3 Code) and Apps
// (the other Flisk tools, pointed at a project). Loaded after app.js and uses its globals (api, esc, render, page, ...).

const MODE_LABELS = { plan: "Read only", edit: "Edit files" };
const TURN_LABELS = { done: "Done", stopped: "Stopped", interrupted: "Interrupted when FliskOS quit" };
const STATE_DOTS = { running: "pending", done: "ready", failed: "error", interrupted: "error" };

const agents = {
  providers: null,
  threads: [],
  threadId: null, // the open thread; null shows the new-thread form
  thread: null,
  // `prefilled` marks a prompt FliskOS wrote (from logs or an app) that the user has not edited yet.
  draft: { project: null, provider: null, mode: "plan", prompt: "", prefilled: false, withStack: true },
  reply: "",
  busy: false,
  rendered: null, // which pane is on screen: "new" or a thread id
  lastTranscript: null,
};
let agentPollTimer = null;

const sortedProjects = () => [...projects].sort((left, right) => left.name.localeCompare(right.name));

function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(ms).toLocaleDateString();
}

// Agent text is escaped first; only code fences, inline code, bold and line breaks become markup.
function richText(text) {
  return String(text ?? "").split(/```[^\n]*\n?/).map((part, index) => (index % 2
    ? `<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`
    : esc(part).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>"))).join("");
}

function updateAgentCount() {
  const running = agents.threads.filter((thread) => thread.state === "running").length;
  document.querySelector("#agents-count").textContent = running ? String(running) : "";
}

async function loadProviders(force = false) {
  if (agents.providers && !force) return;
  try {
    agents.providers = (await api("/api/agents")).providers;
  } catch (error) {
    agents.providers = [];
    showNotice(error.message, true);
  }
  if (page === "agents") renderAgents(agents.threadId == null);
}

async function loadThreads() {
  try {
    agents.threads = (await api("/api/agents/threads")).threads;
  } catch {
    return;
  }
  updateAgentCount();
  if (page === "agents") refreshAgentPanes();
}

function providerChips() {
  if (!agents.providers) return `<span class="provider-chip missing">Looking for agents…</span>`;
  const chips = agents.providers.map((provider) => (provider.installed
    ? `<span class="provider-chip" title="Runs on your own ${esc(provider.label)} login. Not signed in? Run ${esc(provider.login)} in a terminal."><i class="state-dot ready"></i>${esc(provider.label)}${provider.version ? ` <small>${esc(provider.version)}</small>` : ""}</span>`
    : `<span class="provider-chip missing"><i class="state-dot"></i>${esc(provider.label)} <small>not installed</small> <a href="${esc(provider.install)}" target="_blank" rel="noreferrer noopener">Install</a></span>`)).join("");
  return `${chips}<button class="link-btn" type="button" data-agent="refresh" title="Look for agents again after installing one">${btnIcon("restart")}Check again</button>`;
}

function threadListMarkup() {
  if (!agents.threads.length) return `<div class="thread-empty">No threads yet.</div>`;
  return agents.threads.map((thread) => `<button class="thread-item ${thread.id === agents.threadId ? "active" : ""}" type="button" data-agent-thread="${esc(thread.id)}" title="${esc(thread.title)}"><i class="state-dot ${STATE_DOTS[thread.state] ?? ""}"></i><span class="thread-item-copy"><span class="thread-item-title">${esc(thread.title)}</span><span class="thread-item-meta">${esc(thread.providerLabel)} · ${esc(thread.projectName)} · ${esc(ago(thread.updatedAt))}</span></span></button>`).join("");
}

function newThreadMarkup() {
  const draft = agents.draft;
  const list = sortedProjects();
  if (!list.length) return `<div class="agent-form"><div class="empty"><span class="empty-icon" aria-hidden="true">F</span><strong>No Flisk projects yet</strong><p>Agents work inside a Flisk project. Create or open one first.</p></div></div>`;
  if (!list.some((project) => project.id === draft.project)) draft.project = selectedProjectId ?? list[0].id;
  const known = agents.providers ?? [];
  const installed = known.filter((provider) => provider.installed);
  if (!installed.some((provider) => provider.id === draft.provider)) draft.provider = installed[0]?.id ?? null;
  const provider = known.find((entry) => entry.id === draft.provider);
  const projectOptions = list.map((project) => `<option value="${esc(project.id)}" ${project.id === draft.project ? "selected" : ""}>${esc(project.name)}</option>`).join("");
  const providerOptions = known.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === draft.provider ? "selected" : ""} ${entry.installed ? "" : "disabled"}>${esc(entry.label)}${entry.installed ? "" : " (not installed)"}</option>`).join("");
  const modes = Object.entries(MODE_LABELS).map(([id, label]) => `<label><input type="radio" name="agent-mode" value="${id}" ${draft.mode === id ? "checked" : ""}>${label}</label>`).join("");
  const ready = installed.length > 0 && !agents.busy;
  return `<form class="agent-form" id="agent-new">
    <h2>New thread</h2>
    <div class="agent-row">
      <label class="field">Project<select id="agent-project">${projectOptions}</select></label>
      <label class="field">Agent<select id="agent-provider" ${installed.length ? "" : "disabled"}>${providerOptions || `<option>Looking for agents…</option>`}</select></label>
      <div class="field">Mode<div class="mode-switch" role="radiogroup" aria-label="Mode">${modes}</div></div>
    </div>
    <p class="mode-note" id="agent-mode-note">${esc(provider?.modes?.[draft.mode] ?? "")}</p>
    <textarea id="agent-prompt" rows="6" aria-label="What should the agent do?" placeholder="What should the agent do? It works in the project folder, on your own login.">${esc(draft.prompt)}</textarea>
    <div class="agent-form-foot"><label class="check"><input type="checkbox" id="agent-stack" ${draft.withStack ? "checked" : ""}>Send the stack status with the first message</label><span class="spacer"></span><span class="shortcut-note">⌘↩ starts</span><button class="button primary" type="submit" id="agent-start" ${ready ? "" : "disabled"}>${btnIcon("start")}Start</button></div>
    ${agents.providers && !installed.length ? `<div class="notice show">No coding agent was found on this machine. Install one from the links above, sign in to it once in a terminal, then press Check again.</div>` : ""}
  </form>`;
}

function eventMarkup(event, key, turn) {
  if (event.kind === "user") return `<div class="msg user"><div class="bubble">${esc(event.text)}</div>${turn.withStack ? `<span class="stack-chip">sent with the stack status</span>` : ""}</div>`;
  if (event.kind === "text") return `<div class="msg agent">${richText(event.text)}</div>`;
  if (event.kind === "thinking") return `<details class="agent-thinking" data-key="${esc(key)}"${openDetails.has(key) ? " open" : ""}><summary>Thinking</summary><pre>${esc(event.text)}</pre></details>`;
  if (event.kind === "plan") return `<div class="agent-plan"><pre>${esc(event.text)}</pre></div>`;
  if (event.kind === "error") return `<div class="turn-error">${esc(event.text)}</div>`;
  if (event.kind === "tool") {
    const status = event.status ?? "running";
    const title = event.title ?? "Tool";
    const line = `<i class="state-dot ${status === "done" ? "ready" : status === "running" ? "pending" : "error"}"></i><span class="agent-tool-title" title="${esc(title)}">${esc(title)}</span><span class="agent-tool-status">${esc(status)}</span>`;
    return event.output
      ? `<details class="agent-tool ${esc(status)}" data-key="${esc(key)}"${openDetails.has(key) ? " open" : ""}><summary>${line}</summary><pre>${esc(event.output)}</pre></details>`
      : `<div class="agent-tool ${esc(status)}"><div class="agent-tool-line">${line}</div></div>`;
  }
  return `<div class="agent-status">${esc(event.text)}</div>`;
}

function turnFootMarkup(turn) {
  if (turn.state === "running") return `<div class="turn-foot"><i class="working-dot"></i>Working…</div>`;
  if (turn.state === "failed") return `<div class="turn-error">${esc(turn.error || "The agent stopped with an error.")}</div>`;
  const parts = [TURN_LABELS[turn.state] ?? turn.state];
  if (Number.isFinite(turn.costUsd)) parts.push(`$${turn.costUsd.toFixed(2)}`);
  const ms = Number.isFinite(turn.durationMs) ? turn.durationMs : turn.endedAt && turn.startedAt ? turn.endedAt - turn.startedAt : null;
  if (ms != null) parts.push(`${(ms / 1000).toFixed(1)}s`);
  return `<div class="turn-foot">${esc(parts.join(" · "))}</div>`;
}

function transcriptMarkup(thread) {
  return thread.turns.map((turn, turnIndex) => {
    const dropped = turn.dropped ? `<div class="agent-status">${turn.dropped} earlier events are not shown.</div>` : "";
    return `${dropped}${turn.events.map((event, index) => eventMarkup(event, `agent/${thread.id}/${turnIndex}/${index}`, turn)).join("")}${turnFootMarkup(turn)}`;
  }).join("");
}

function threadHeadMarkup(thread) {
  const running = thread.state === "running";
  return `<div><h2>${esc(thread.title)}</h2><div class="thread-meta">${esc(thread.providerLabel)} · ${esc(MODE_LABELS[thread.mode] ?? thread.mode)} · <button class="link-btn" type="button" data-select-project="${esc(thread.project)}">${esc(thread.projectName)}</button></div></div>
    <div class="thread-actions">${running ? `<button class="button danger" type="button" data-agent="stop">${btnIcon("stop")}Stop</button>` : ""}<button class="icon-btn" type="button" data-agent="delete" title="Delete thread" aria-label="Delete thread" ${running ? "disabled" : ""}><svg viewBox="0 0 20 20" aria-hidden="true">${ICONS.close}</svg></button></div>`;
}

function threadPaneMarkup() {
  const thread = agents.thread;
  if (!thread) return `<div class="transcript"><div class="skel-row"></div><div class="skel-row"></div></div>`;
  agents.lastTranscript = transcriptMarkup(thread);
  return `<div class="thread-head" id="agent-thread-head">${threadHeadMarkup(thread)}</div>
    <div class="transcript" id="agent-transcript" aria-live="polite">${agents.lastTranscript}</div>
    <form class="composer" id="agent-reply-form"><textarea id="agent-reply" rows="2" aria-label="Reply" placeholder="Reply to ${esc(thread.providerLabel)}… (⌘↩ sends)">${esc(agents.reply)}</textarea><button class="button primary" type="submit" id="agent-send" ${thread.state === "running" || agents.busy ? "disabled" : ""}>Send</button></form>`;
}

// The page re-renders every few seconds; once a pane is on screen only its changing parts are replaced,
// so the text being typed, the caret and the transcript's scroll position stay put.
function renderAgents(force = false) {
  document.querySelector("#breadcrumb").innerHTML = "<strong>Agents</strong>";
  const pane = agents.threadId ?? "new";
  const ready = agents.threadId == null || content.querySelector("#agent-transcript");
  if (!force && agents.rendered === pane && ready && content.querySelector(".agents-page")) {
    refreshAgentPanes();
    return;
  }
  agents.rendered = pane;
  content.innerHTML = `<div class="content-inner agents-page">
    <div class="page-head"><div><h1>Agents</h1><p>Claude Code, Codex, Cursor, Grok and fx, working in your Flisk projects. Each one runs on your own login; FliskOS holds no keys.</p></div>
      <div class="head-actions"><button class="button primary" type="button" data-agent="new">${btnIcon("plus")}New thread</button></div></div>
    <div id="notice" class="notice" role="status"></div>
    <div class="agent-providers" id="agent-providers">${providerChips()}</div>
    <div class="agents-layout">
      <nav class="thread-list" id="agent-threads" aria-label="Agent threads">${threadListMarkup()}</nav>
      <section class="thread-pane" aria-label="${agents.threadId ? "Thread" : "New thread"}">${agents.threadId ? threadPaneMarkup() : newThreadMarkup()}</section>
    </div>
  </div>`;
  const transcript = content.querySelector("#agent-transcript");
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function refreshAgentPanes() {
  const list = content.querySelector("#agent-threads");
  if (list) list.innerHTML = threadListMarkup();
  const chips = content.querySelector("#agent-providers");
  if (chips) chips.innerHTML = providerChips();
  const thread = agents.thread;
  if (!thread || agents.rendered !== thread.id) return;
  const head = content.querySelector("#agent-thread-head");
  if (head) head.innerHTML = threadHeadMarkup(thread);
  const transcript = content.querySelector("#agent-transcript");
  const markup = transcriptMarkup(thread);
  if (transcript && markup !== agents.lastTranscript) {
    // Follow new output only when the reader is already at the bottom.
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
    transcript.innerHTML = markup;
    agents.lastTranscript = markup;
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }
  const send = content.querySelector("#agent-send");
  if (send) send.disabled = thread.state === "running" || agents.busy;
}

function scheduleThreadPoll() {
  clearTimeout(agentPollTimer);
  if (agents.thread?.state === "running" && page === "agents") agentPollTimer = setTimeout(() => void fetchThread(), 700);
}

async function fetchThread(full = false) {
  const id = agents.threadId;
  if (!id) return;
  const wasRunning = agents.thread?.state === "running";
  try {
    const known = !full && agents.thread?.id === id ? `&version=${agents.thread.version}` : "";
    const result = await api(`/api/agents/thread?id=${encodeURIComponent(id)}${known}`);
    if (agents.threadId !== id) return;
    if (!result.unchanged) agents.thread = result.thread;
    if (page === "agents") renderAgents();
    if (wasRunning && agents.thread.state !== "running") void loadThreads();
    scheduleThreadPoll();
  } catch (error) {
    if (agents.threadId !== id) return;
    showNotice(error.message, true);
    agents.threadId = null;
    agents.thread = null;
    if (page === "agents") renderAgents(true);
  }
}

function openThread(id) {
  if (agents.threadId !== id) {
    agents.threadId = id;
    agents.thread = null;
    agents.reply = "";
  }
  renderAgents(true);
  void fetchThread(true);
}

function openAgentComposer({ project = null, prompt = "" } = {}) {
  page = "agents";
  agents.threadId = null;
  agents.thread = null;
  const draft = agents.draft;
  if (prompt) Object.assign(draft, { prompt, prefilled: true });
  // A prompt written for another project does not carry over; one the user typed does.
  else if (project && project !== draft.project && draft.prefilled) Object.assign(draft, { prompt: "", prefilled: false });
  if (project) draft.project = project;
  void loadProviders();
  void loadThreads();
  render();
  renderAgents(true);
  content.querySelector("#agent-prompt")?.focus();
}

async function startThread() {
  const draft = agents.draft;
  if (!draft.prompt.trim()) return showNotice("Write what the agent should do.", true);
  agents.busy = true;
  const start = content.querySelector("#agent-start");
  if (start) start.disabled = true;
  try {
    const { thread } = await api("/api/agents/threads", { method: "POST", body: JSON.stringify({ project: draft.project, provider: draft.provider, mode: draft.mode, prompt: draft.prompt, withStack: draft.withStack }) });
    Object.assign(draft, { prompt: "", prefilled: false });
    agents.thread = thread;
    agents.threadId = thread.id;
    agents.threads = [thread, ...agents.threads.filter((entry) => entry.id !== thread.id)];
    updateAgentCount();
    agents.busy = false;
    renderAgents(true);
    scheduleThreadPoll();
  } catch (error) {
    agents.busy = false;
    if (start) start.disabled = false;
    showNotice(error.message, true);
  }
}

async function sendReply() {
  const prompt = agents.reply.trim();
  if (!prompt || !agents.thread) return;
  agents.busy = true;
  refreshAgentPanes();
  try {
    const { thread } = await api("/api/agents/thread/send", { method: "POST", body: JSON.stringify({ id: agents.thread.id, prompt }) });
    agents.reply = "";
    const box = content.querySelector("#agent-reply");
    if (box) box.value = "";
    agents.thread = thread;
    void loadThreads();
    scheduleThreadPoll();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    agents.busy = false;
    refreshAgentPanes();
  }
}

async function stopThread() {
  if (!agents.thread) return;
  try {
    await api("/api/agents/thread/stop", { method: "POST", body: JSON.stringify({ id: agents.thread.id }) });
  } catch (error) {
    showNotice(error.message, true);
  }
  void fetchThread();
}

async function deleteThread() {
  const thread = agents.thread;
  if (!thread || !window.confirm(`Delete the thread “${thread.title}”? The agent's own session history is not touched.`)) return;
  try {
    await api("/api/agents/thread/delete", { method: "POST", body: JSON.stringify({ id: thread.id }) });
    agents.threadId = null;
    agents.thread = null;
    agents.threads = agents.threads.filter((entry) => entry.id !== thread.id);
    renderAgents(true);
  } catch (error) {
    showNotice(error.message, true);
  }
}

function updateModeNote() {
  const provider = agents.providers?.find((entry) => entry.id === agents.draft.provider);
  const note = content.querySelector("#agent-mode-note");
  if (note) note.textContent = provider?.modes?.[agents.draft.mode] ?? "";
}

// ---------- Apps ----------
const apps = { project: null, list: null, loadedFor: undefined, loading: false };

function appsProjectId() {
  if (apps.project && projects.some((project) => project.id === apps.project)) return apps.project;
  return selectedProjectId ?? sortedProjects()[0]?.id ?? null;
}

async function loadApps() {
  const project = appsProjectId();
  apps.loading = true;
  try {
    apps.list = (await api(`/api/apps${project ? `?project=${encodeURIComponent(project)}` : ""}`)).apps;
    apps.loadedFor = project;
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    apps.loading = false;
  }
  if (page === "apps") render();
}

function appCard(app) {
  const actions = app.actions.map((action, index) => {
    if (action.kind === "link") return `<a class="button" href="${esc(action.href)}" target="_blank" rel="noreferrer noopener">${esc(action.label)}</a>`;
    if (action.kind === "copy") return `<button class="button" type="button" data-app-copy="${esc(action.value)}" title="Copy: ${esc(action.value)}">${btnIcon("copy")}${esc(action.label)}</button>`;
    if (action.kind === "agent") return `<button class="button primary" type="button" data-app-agent="${esc(app.id)}" data-index="${index}">${btnIcon("sparkle")}${esc(action.label)}</button>`;
    return "";
  }).join("");
  return `<article class="app-card"><h3>${esc(app.name)}</h3><span class="app-host">${esc(new URL(app.url).host)}</span><p>${esc(app.blurb)}</p>${app.note ? `<span class="app-note">${esc(app.note)}</span>` : ""}<div class="app-actions"><a class="button" href="${esc(app.url)}" target="_blank" rel="noreferrer noopener">Open</a>${actions}</div></article>`;
}

function renderApps() {
  document.querySelector("#breadcrumb").innerHTML = "<strong>Apps</strong>";
  const current = appsProjectId();
  if (apps.loadedFor !== current && !apps.loading) void loadApps();
  const options = sortedProjects().map((project) => `<option value="${esc(project.id)}" ${project.id === current ? "selected" : ""}>${esc(project.name)}</option>`).join("");
  content.innerHTML = `<div class="content-inner">
    <div class="page-head"><div><h1>Apps</h1><p>The rest of Flisk, pointed at the project you pick. Links open in your browser; commands are copied, never run.</p></div></div>
    <div id="notice" class="notice" role="status"></div>
    ${options ? `<div class="apps-project"><label class="field">Project <select id="apps-project">${options}</select></label></div>` : ""}
    <div class="apps-grid">${apps.list ? apps.list.map(appCard).join("") : `<div class="skel-row"></div><div class="skel-row"></div>`}</div>
  </div>`;
}

// ---------- Events ----------
document.querySelector("#agents-nav").addEventListener("click", () => {
  page = "agents";
  void loadProviders();
  void loadThreads();
  render();
  if (agents.threadId) void fetchThread(true);
});

document.querySelector("#apps-nav").addEventListener("click", () => {
  page = "apps";
  render();
});

document.querySelector("#ask-agent-logs").addEventListener("click", () => {
  const view = logView;
  if (!view) return;
  // The same redacted, trimmed prompt the "Inspect with" links use.
  const prompt = FLISK_INSPECT.logsPrompt({ project: view.owner?.name || view.project, path: view.owner?.path || "", resource: view.name, lines: view.lines });
  document.querySelector("#logs").close();
  openAgentComposer({ project: view.project, prompt });
});

content.addEventListener("click", (event) => {
  const thread = event.target.closest("[data-agent-thread]");
  if (thread) return openThread(thread.dataset.agentThread);
  const copy = event.target.closest("[data-app-copy]");
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.appCopy).then(() => showNotice(`Copied: ${copy.dataset.appCopy}`), () => showNotice("Could not copy. Select the command and copy it by hand.", true));
    return;
  }
  const appAgent = event.target.closest("[data-app-agent]");
  if (appAgent) {
    const action = apps.list?.find((app) => app.id === appAgent.dataset.appAgent)?.actions[Number(appAgent.dataset.index)];
    if (action?.prompt) openAgentComposer({ project: appsProjectId(), prompt: action.prompt });
    return;
  }
  const button = event.target.closest("[data-agent]");
  if (!button) return;
  const what = button.dataset.agent;
  if (what === "new") {
    agents.threadId = null;
    agents.thread = null;
    renderAgents(true);
    content.querySelector("#agent-prompt")?.focus();
  } else if (what === "stop") void stopThread();
  else if (what === "delete") void deleteThread();
  else if (what === "refresh") void loadProviders(true);
});

content.addEventListener("submit", (event) => {
  if (event.target.id === "agent-new") {
    event.preventDefault();
    void startThread();
  } else if (event.target.id === "agent-reply-form") {
    event.preventDefault();
    void sendReply();
  }
});

content.addEventListener("input", (event) => {
  if (event.target.id === "agent-prompt") Object.assign(agents.draft, { prompt: event.target.value, prefilled: false });
  else if (event.target.id === "agent-reply") agents.reply = event.target.value;
});

content.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "agent-project") agents.draft.project = target.value;
  else if (target.id === "agent-provider") {
    agents.draft.provider = target.value;
    updateModeNote();
  } else if (target.name === "agent-mode") {
    agents.draft.mode = target.value;
    updateModeNote();
  } else if (target.id === "agent-stack") agents.draft.withStack = target.checked;
  else if (target.id === "apps-project") {
    apps.project = target.value;
    void loadApps();
  }
});

// Cmd/Ctrl+Enter sends from either text box.
content.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !event.target.matches("#agent-prompt, #agent-reply")) return;
  event.preventDefault();
  event.target.form?.requestSubmit();
});

// The thread list and the apps' project links follow changes made elsewhere (another window, a finished agent).
setInterval(() => {
  if (page === "agents") void loadThreads();
  else if (page === "apps") void loadApps();
}, 7000);
void loadThreads();
