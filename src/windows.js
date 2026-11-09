// What finding and starting a program takes on Windows. Everywhere else these functions change nothing.
import { readFileSync } from "node:fs";
import { basename, join, win32 } from "node:path";

// npm also writes an extensionless sh script next to its .cmd launcher, and Windows cannot run that one.
export function executableNames(name, platform = process.platform) {
  return platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
}

export function programName(path) {
  return basename(path).replace(/\.(exe|cmd|bat)$/i, "");
}

export function windowsSearchDirs(env = process.env, platform = process.platform) {
  if (platform !== "win32") return [];
  return [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "flisk", "bin"),
    env.APPDATA && join(env.APPDATA, "npm"),
  ].filter(Boolean);
}

// The program an npm .cmd launcher runs, as a full path, or null when this is some other batch file.
export function shimTarget(text, shimPath) {
  const match = /"%~?dp0%?\\?([^"\r\n]+\.(?:exe|js|cjs|mjs))"[^"\r\n]*%\*/i.exec(text);
  return match ? win32.join(win32.dirname(shimPath), match[1]) : null;
}

// How cmd.exe needs one argument written: quoted for the program, then every special character escaped for cmd.exe.
// cmd.exe ends a command at a line break, so line breaks become spaces.
export function cmdQuote(value) {
  const quoted = `"${String(value).replace(/\r?\n/g, " ").replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return escapeForCmd(quoted);
}

const escapeForCmd = (text) => text.replace(/[()\][%!^"`<>&|;, *?]/g, "^$&");

// Node refuses to start a .cmd or .bat file directly. An npm launcher is unwrapped and its real program started, so
// arguments such as a prompt never pass through cmd.exe. Only a batch file of another kind goes through cmd.exe.
export function windowsLaunch(command, args, { env = process.env, platform = process.platform, read = (path) => readFileSync(path, "utf8"), runtime = process.execPath } = {}) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args, options: {} };
  let target = null;
  try {
    target = shimTarget(read(command), command);
  } catch {}
  if (target) {
    return /\.exe$/i.test(target) ? { command: target, args, options: {} } : { command: runtime, args: [target, ...args], options: {} };
  }
  const line = [escapeForCmd(command), ...args.map(cmdQuote)].join(" ");
  return { command: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
}
