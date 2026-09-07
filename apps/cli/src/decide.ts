import { createInterface } from "node:readline/promises";
import type { RequestDecisionInput } from "@exec/core";

/**
 * The terminal decision surface.
 *
 * This is a stand-in for the Telegram bridge (V0.1 in the plan): when a worker
 * calls `request_decision`, the tool call genuinely blocks until this resolves, so
 * running the CLI in a terminal you're watching is a real, working escalation
 * path today — not a stub.
 */
export async function askInTerminal(
  input: RequestDecisionInput,
): Promise<{ answer: string; answeredBy: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n" + "=".repeat(72));
  console.log(`DECISION NEEDED: ${input.title}`);
  console.log("=".repeat(72));
  console.log(input.context);
  console.log("");
  for (const opt of input.options) {
    console.log(`  [${opt.id}] ${opt.label}`);
    for (const p of opt.pros) console.log(`        + ${p}`);
    for (const c of opt.cons) console.log(`        - ${c}`);
  }
  console.log(`\nRecommendation: ${input.recommendation}  (risk: ${input.risk})`);
  console.log("=".repeat(72));

  const validIds = new Set(input.options.map((o) => o.id));
  let answer: string;
  for (;;) {
    const raw = (
      await rl.question(
        `Choose an option [${[...validIds].join("/")}] (enter accepts the recommendation): `,
      )
    ).trim();
    const candidate = raw === "" ? input.recommendation : raw;
    if (validIds.has(candidate)) {
      answer = candidate;
      break;
    }
    console.log(`"${raw}" is not one of the listed options.`);
  }

  rl.close();
  return { answer, answeredBy: "terminal-operator" };
}
