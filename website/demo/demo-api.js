// Stands in for the FliskOS server on os.flisk.si/demo/, so the real interface runs in the page on sample projects.
// Answers come from responses recorded from the real server at build time (data.js); this file only adds the changes
// a click makes: starting and stopping a project, and an agent replying in a thread.
(() => {
  const demo = window.FLISK_DEMO;
  const realFetch = window.fetch.bind(window);
  const DEMO_ONLY = "This is the demo, with sample projects. Download FliskOS to do this on your own.";
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const keyOf = (url) => {
    const query = ["project", "resource", "id"].filter((name) => url.searchParams.has(name)).map((name) => `${name}=${url.searchParams.get(name)}`);
    return url.pathname + (query.length ? `?${query.join("&")}` : "");
  };

  // The recording has a fixed date, so its threads are moved to look recent.
  const shift = Date.now() - demo.builtAt;
  const moved = (time) => (typeof time === "number" ? time + shift : time);
  const threads = demo.threads.map((thread) => ({
    ...thread,
    version: thread.version ?? 1,
    createdAt: moved(thread.createdAt),
    updatedAt: moved(thread.updatedAt),
    turns: thread.turns.map((turn) => ({ ...turn, startedAt: moved(turn.startedAt), endedAt: moved(turn.endedAt) })),
  }));

  const projects = () => demo.get["/api/projects"].projects;
  const projectById = (id) => projects().find((project) => project.id === id);
  const summary = ({ turns, ...thread }) => ({ ...thread, turns: turns.length });
  const full = (thread) => ({ ...thread });

  // ---------- Start, stop and restart ----------
  const JOB_MS = 4200;
  const STEPS = [[0, 12, "Building images"], [0.3, 46, "Starting containers"], [0.65, 84, "Waiting for health checks"]];
  const jobs = new Map();

  const targets = (job) => {
    const project = projectById(job.project);
    if (job.resources) return project.resources.filter((resource) => job.resources.includes(resource.name));
    if (job.stack) return project.resources.filter((resource) => resource.stack === job.stack);
    return project.resources;
  };
  const setStatus = (job, status) => {
    for (const resource of targets(job)) resource.status = status;
  };

  function startJob(body) {
    const job = { id: Math.random().toString(16).slice(2, 14), project: body.project, operation: body.operation, stack: body.stack, resources: body.resources, state: "running", startedAt: Date.now(), endedAt: null, message: "", elapsedMs: 0, progress: { percent: 2, step: STEPS[0][2] } };
    jobs.set(job.project, job);
    setStatus(job, body.operation === "stop" ? "stopping" : "starting");
    return job;
  }

  function advance(job) {
    if (job.state !== "running") return;
    job.elapsedMs = Date.now() - job.startedAt;
    const done = job.elapsedMs / JOB_MS;
    if (done < 1) {
      const step = STEPS.filter(([from]) => done >= from).at(-1);
      job.progress = job.operation === "stop" ? { percent: Math.round(done * 100), step: "Stopping containers" } : { percent: step[1], step: step[2] };
      return;
    }
    const project = projectById(job.project);
    setStatus(job, job.operation === "stop" ? "stopped" : "ready");
    project.tiltRunning = project.resources.some((resource) => resource.status === "ready");
    Object.assign(job, { state: "done", endedAt: Date.now(), message: job.operation === "stop" ? "Stopped." : "Started.", progress: { percent: 100, step: "Done" } });
  }

  function listJobs() {
    for (const job of jobs.values()) advance(job);
    for (const [project, job] of jobs) if (job.endedAt && Date.now() - job.endedAt > 6000) jobs.delete(project);
    return [...jobs.values()];
  }

  // ---------- Agents ----------
  const providers = () => demo.get["/api/agents"].providers;
  const touch = (thread) => {
    thread.version = (thread.version ?? 0) + 1;
    thread.updatedAt = Date.now();
  };

  function reply(thread, turn) {
    const project = projectById(thread.project);
    const ready = project.resources.filter((resource) => resource.status === "ready").length;
    const label = providers().find((provider) => provider.id === thread.provider)?.label ?? "The agent";
    const script = [
      () => turn.events.push({ kind: "status", text: "Demo run: no agent is actually working" }),
      () => turn.events.push({ kind: "tool", title: "Read README.md", status: "running" }),
      () => { turn.events.at(-1).status = "done"; turn.events.push({ kind: "tool", title: "$ flisk status --json", status: "running" }); },
      () => { turn.events.at(-1).status = "done"; turn.events.push({ kind: "text", text: `**${project.name} has ${ready} of ${project.resources.length} resources ready.** Press Start or Stop on the project and ask again, and this number changes.\n\nThis reply is scripted for the demo. With FliskOS installed, ${label} runs here in your own project folder, on the login you already have.` }); },
    ];
    let step = 0;
    const tick = () => {
      if (turn.state !== "running") return;
      if (step < script.length) {
        script[step++]();
        touch(thread);
        setTimeout(tick, 900);
        return;
      }
      Object.assign(turn, { state: "done", endedAt: Date.now() });
      thread.state = "done";
      touch(thread);
    };
    setTimeout(tick, 600);
  }

  function addTurn(thread, prompt, withStack) {
    const turn = { id: Math.random().toString(16).slice(2, 14), prompt, withStack: Boolean(withStack), state: "running", startedAt: Date.now(), endedAt: null, dropped: 0, error: null, events: [{ kind: "user", text: prompt }] };
    thread.turns.push(turn);
    thread.state = "running";
    touch(thread);
    reply(thread, turn);
  }

  function newThread(body) {
    const project = projectById(body.project);
    const provider = providers().find((entry) => entry.id === body.provider);
    const thread = { id: Math.random().toString(16).slice(2, 14), project: project.id, projectName: project.name, provider: provider.id, providerLabel: provider.label, mode: body.mode, title: body.prompt.trim().replace(/\s+/g, " ").slice(0, 60), createdAt: Date.now(), updatedAt: Date.now(), state: "running", turns: [], version: 0 };
    threads.unshift(thread);
    addTurn(thread, body.prompt, body.withStack);
    return thread;
  }

  // ---------- The API ----------
  function route(url, method, body) {
    const path = url.pathname;
    if (method === "GET") {
      if (path === "/api/jobs") return respond({ jobs: listJobs() });
      if (path === "/api/agents/threads") return respond({ threads: threads.map(summary) });
      if (path === "/api/agents/thread") {
        const thread = threads.find((entry) => entry.id === url.searchParams.get("id"));
        if (!thread) return respond({ error: "That thread is gone." }, 404);
        return url.searchParams.get("version") === String(thread.version) ? respond({ unchanged: true }) : respond({ thread: full(thread) });
      }
      if (path === "/api/projects") return respond(demo.get[path]);
      const recorded = demo.get[keyOf(url)];
      return recorded ? respond(recorded) : respond({ error: DEMO_ONLY }, 403);
    }
    if (path === "/api/state" && method === "PUT") {
      Object.assign(demo.get["/api/state"], body);
      return respond(demo.get["/api/state"]);
    }
    if (path === "/api/actions") {
      if (jobs.get(body.project)?.state === "running") return respond({ error: "An action is already running for this project." }, 409);
      return respond({ job: startJob(body) }, 202);
    }
    if (path === "/api/agents/threads") return respond({ thread: full(newThread(body)) });
    const thread = threads.find((entry) => entry.id === body.id);
    if (path === "/api/agents/thread/send" && thread) {
      addTurn(thread, body.prompt, false);
      return respond({ thread: full(thread) });
    }
    if (path === "/api/agents/thread/stop" && thread) {
      Object.assign(thread.turns.at(-1), { state: "stopped", endedAt: Date.now() });
      thread.state = "stopped";
      touch(thread);
      return respond({ ok: true });
    }
    if (path === "/api/agents/thread/delete" && thread) {
      threads.splice(threads.indexOf(thread), 1);
      return respond({ ok: true });
    }
    return respond({ error: DEMO_ONLY }, 403);
  }

  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, options);
    await wait(60);
    return route(url, options.method ?? "GET", options.body ? JSON.parse(options.body) : {});
  };

  // ---------- The page around the demo can open a screen in it ----------
  const clickText = (text) => {
    const found = [...document.querySelectorAll("nav *, aside *, button, a")].find((element) => element.children.length === 0 && element.textContent.trim() === text);
    found?.click();
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || !event.data?.fliskosDemo) return;
    const { fliskosDemo: target, provider } = event.data;
    if (target === "overview") document.querySelector("#overview-nav").click();
    else if (target === "apps") document.querySelector("#apps-nav").click();
    else if (target === "project") clickText("acme-shop");
    else if (target === "agent") {
      openAgentComposer({});
      agents.draft.provider = provider;
      renderAgents(true);
    }
  });
})();
