// The Flisk apps launcher: the other Flisk tools, each with links and commands pointed at the selected project.
// Nothing here runs on its own: links open in the browser, commands are copied, and agent prompts go to the composer.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const FLISK_APPS = [
  { id: "pages", name: "Pages", url: "https://pages.flisk.si", blurb: "Your agent builds a page. One command makes it a public link." },
  { id: "citable", name: "Citable", url: "https://citable.flisk.si", blurb: "Can AI answers cite your site? A score out of 100 and the fixes." },
  { id: "helpdock", name: "Helpdock", url: "https://helpdock.flisk.sh", blurb: "A repo's docs as a help center and an MCP server for your agent." },
  { id: "cmd", name: "Command Comparer", url: "https://cmd.flisk.sh", blurb: "Flisk commands next to Compose, Tilt, Terraform and more." },
  { id: "roadmap", name: "DevEx Roadmap", url: "https://roadmap.flisk.si", blurb: "Community map of local DevEx tools, with a source for every dot." },
  { id: "demo", name: "Demos", url: "https://demo.flisk.sh", blurb: "Reply @grok bubbles on X and get a running local stack." },
];

// "owner/repo" for a GitHub remote URL in any of the usual forms, or null.
export function githubRepo(url) {
  if (typeof url !== "string") return null;
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// The origin remote of a git checkout, read from its config file (a worktree's .git file points at the real one).
export function originUrl(root) {
  try {
    let gitDir = join(root, ".git");
    if (!existsSync(gitDir)) return null;
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim();
      if (!pointer) return null;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
      const common = join(gitDir, "commondir");
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
    }
    const config = readFileSync(join(gitDir, "config"), "utf8");
    const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
    return /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// The apps with actions for one project. `resources` comes from the project's last status read.
export function appsForProject(project, resources = []) {
  const repo = project ? githubRepo(originUrl(project.root)) : null;
  const frontends = resources.filter((resource) => resource?.type === "frontend" && typeof resource.url === "string" && /^https?:\/\//.test(resource.url)).slice(0, 4);
  const name = project?.name ?? "this project";
  const actions = {
    pages: project ? [
      { kind: "agent", label: "Make a page with an agent", prompt: `Build a one-page explainer of the ${name} stack (its services, how they connect and how to run it with Flisk) as ./flisk-page/index.html, with no external scripts. Do not publish it; I will run \`npx -y @flisk-sh/pages publish ./flisk-page --wait\` myself.` },
      { kind: "copy", label: "Copy publish command", value: "npx -y @flisk-sh/pages publish ./flisk-page --wait" },
    ] : [],
    citable: frontends.map((resource) => ({ kind: "copy", label: `Check ${resource.name}`, value: `npx @flisk-sh/citable ${resource.url}` })),
    helpdock: repo ? [
      { kind: "link", label: `Docs for ${repo}`, href: `https://helpdock.flisk.sh/${repo}` },
      { kind: "copy", label: "Copy MCP URL", value: `https://helpdock.flisk.sh/${repo}/mcp` },
    ] : [],
    cmd: [],
    roadmap: [],
    demo: [],
  };
  const notes = {
    citable: frontends.length ? "Citable checks local previews from your machine." : "Start a frontend to check it locally.",
    helpdock: repo ? null : "Push this project to GitHub to get its help center.",
  };
  return FLISK_APPS.map((app) => ({ ...app, actions: actions[app.id] ?? [], note: project ? notes[app.id] ?? null : null }));
}
