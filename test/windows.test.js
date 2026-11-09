import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { maskPaths, probeCli, runTdk } from "../src/app.js";
import { cmdQuote, executableNames, programName, shimTarget, windowsLaunch } from "../src/windows.js";

// What `npm install -g` writes, trimmed to the lines that matter.
const NPM_JS_SHIM = `@ECHO off\r\nSET "_prog=%dp0%\\node.exe"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@flisk-sh\\flisk\\bin\\flisk.js" %*\r\n`;
const NPM_EXE_SHIM = `@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\codex.exe"   %*\r\n`;
const shimPath = "C:\\Users\\me\\AppData\\Roaming\\npm\\flisk.cmd";
const win = { platform: "win32", env: { ComSpec: "C:\\Windows\\cmd.exe" }, runtime: "C:\\node.exe" };

describe("finding programs", () => {
  it("looks for real Windows programs, never npm's extensionless sh script", () => {
    assert.deepEqual(executableNames("flisk", "win32"), ["flisk.exe", "flisk.cmd", "flisk.bat"]);
  });

  it("changes nothing elsewhere", () => {
    assert.deepEqual(executableNames("flisk", "darwin"), ["flisk"]);
  });

  it("names a program without its extension", () => {
    assert.equal(programName("/bin/flisk"), "flisk");
    assert.equal(programName("flisk.exe"), "flisk");
    assert.equal(programName("flisk.CMD"), "flisk");
  });
});

describe("hiding the account name", () => {
  it("masks a Windows path, in plain text and inside JSON", () => {
    assert.equal(maskPaths("C:\\Users\\alex\\code"), "C:\\Users\\****\\code");
    assert.equal(maskPaths(JSON.stringify({ path: "C:\\Users\\alex\\code" })), JSON.stringify({ path: "C:\\Users\\****\\code" }));
  });
});

describe("starting programs on Windows", () => {
  it("reads the script an npm launcher runs", () => {
    assert.equal(shimTarget(NPM_JS_SHIM, shimPath), "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@flisk-sh\\flisk\\bin\\flisk.js");
  });

  it("starts an npm launcher's script directly, keeping the prompt away from cmd.exe", () => {
    const prompt = "line one\nfix \"this\" & del /q C:\\*";
    const launch = windowsLaunch(shimPath, ["-p", prompt], { ...win, read: () => NPM_JS_SHIM });
    assert.equal(launch.command, "C:\\node.exe");
    assert.deepEqual(launch.args.slice(1), ["-p", prompt]);
    assert.deepEqual(launch.options, {});
  });

  it("starts the .exe an npm launcher wraps", () => {
    const launch = windowsLaunch("C:\\npm\\codex.cmd", ["exec"], { ...win, read: () => NPM_EXE_SHIM });
    assert.equal(launch.command, "C:\\npm\\node_modules\\@openai\\codex\\codex.exe");
    assert.deepEqual(launch.args, ["exec"]);
  });

  it("starts an .exe as it is", () => {
    assert.deepEqual(windowsLaunch("C:\\flisk.exe", ["up"], win), { command: "C:\\flisk.exe", args: ["up"], options: {} });
  });

  it("sends any other batch file through cmd.exe with every special character escaped", () => {
    const launch = windowsLaunch("C:\\tools\\agent.bat", ["a & del x"], { ...win, read: () => "@echo off\r\nrem custom\r\n" });
    assert.equal(launch.command, "C:\\Windows\\cmd.exe");
    assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(launch.options.windowsVerbatimArguments, true);
    assert.ok(launch.args[3].includes("^&"));
    assert.ok(!/[^^]&/.test(launch.args[3]));
  });

  it("does not let a line break end the command", () => {
    assert.ok(!/[\r\n]/.test(cmdQuote("one\r\ntwo")));
  });

  it("leaves other platforms alone", () => {
    assert.deepEqual(windowsLaunch("/bin/agent.cmd", ["x"], { platform: "linux" }), { command: "/bin/agent.cmd", args: ["x"], options: {} });
  });
});

describe("on a real Windows machine", { skip: process.platform !== "win32" }, () => {
  it("passes awkward arguments intact through an npm launcher", () => {
    const dir = mkdtempSync(join(tmpdir(), "fliskos-win-"));
    try {
      writeFileSync(join(dir, "echo.js"), "console.log(JSON.stringify(process.argv.slice(2)));");
      const shim = join(dir, "echo.cmd");
      writeFileSync(shim, `@ECHO off\r\n"%~dp0\\echo.js" %*\r\n`);
      const expected = ["two words", 'quo"te', "a & b", "100%", "line\nbreak"];
      const launch = windowsLaunch(shim, expected);
      assert.deepEqual(JSON.parse(execFileSync(launch.command, launch.args, { encoding: "utf8" })), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognises the installed Flisk CLI", { skip: !process.env.FLISKOS_REAL_CLI }, async () => {
    const capability = await probeCli((project, args, options) => runTdk(project, args, options));
    assert.equal(capability.state, "supported", capability.message ?? "");
    assert.equal(capability.lifecycle, true);
  });
});
