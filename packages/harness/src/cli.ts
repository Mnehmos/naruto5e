import readline from "node:readline";
import { DMBrain } from "./dm.js";

/**
 * A tiny REPL DM. Pipe player lines in; the brain conforms them to intents,
 * submits through the controller's engine client, and narrates the IR.
 *   NARUTO_ENGINE_URL=http://localhost:8970 npm run --workspace @naruto5e/harness start -- <roomId>
 */
async function main(): Promise<void> {
  const engineUrl = process.env.NARUTO_ENGINE_URL ?? "http://localhost:8970";
  const roomId = process.argv[2] ?? "demo";
  const dm = new DMBrain(engineUrl);
  // eslint-disable-next-line no-console
  console.log(`naruto5e DM harness · room "${roomId}" · engine ${engineUrl}`);
  console.log(process.env.ANTHROPIC_API_KEY ? "(LLM mode)" : "(deterministic fallback — set ANTHROPIC_API_KEY for the Claude DM brain)");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "player> " });
  rl.prompt();
  rl.on("line", async (line) => {
    if (!line.trim()) return rl.prompt();
    try {
      const turn = await dm.respond(roomId, line);
      for (const n of turn.narration) console.log("  " + n);
      for (const r of turn.rejections) console.log(`  ✗ ${r.rule}: ${r.explain}${r.suggestions[0] ? `\n    → ${r.suggestions[0]}` : ""}`);
    } catch (e) {
      console.log("  (error) " + (e as Error).message);
    }
    rl.prompt();
  });
}

main();
