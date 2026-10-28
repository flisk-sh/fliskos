// Stands in for `claude -p --output-format stream-json`: reads the prompt from stdin and answers with the same
// event shapes, echoing its argv and prompt so tests can check what FliskOS sent.
// Prompt words: WAIT keeps it running until it is killed, FAIL exits 1 with a login error, NOISE prints a non-JSON line.
const args = process.argv.slice(2);
const resumeAt = args.indexOf("--resume");
const session = resumeAt >= 0 ? args[resumeAt + 1] : "fake-session-1";
const emit = (event) => process.stdout.write(`${JSON.stringify({ session_id: session, ...event })}\n`);

let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
process.stdin.on("end", () => {
  if (prompt.includes("FAIL")) {
    process.stderr.write("Error: Not signed in. Run the login command first.\n");
    process.exit(1);
  }
  emit({ type: "system", subtype: "init", model: "fake-model", cwd: process.cwd() });
  if (prompt.includes("NOISE")) process.stdout.write("this line is not JSON\n");
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "1\tREADME" }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: `echo:${JSON.stringify({ args, prompt, cwd: process.cwd() })}` }] } });
  if (prompt.includes("WAIT")) {
    setInterval(() => {}, 1000);
    return;
  }
  emit({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.25, duration_ms: 1200, permission_denials: [] });
});
