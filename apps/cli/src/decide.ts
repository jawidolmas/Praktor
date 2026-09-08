import { createInterface } from "node:readline/promises";
import type { RequestDecisionInput } from "@exec/core";

/**
 * The terminal decision surface — one of several now. The daemon (not this
 * process) actually blocks the worker's tool call, polling the database for
 * an answer, so this is just the fastest path when you happen to still be
 * watching: `exec-agent decide` and the dashboard answer the same row from
 * anywhere else. This is a stand-in for the Telegram bridge (V0.1 in the
 * plan) as the "you happen to be right here" case specifically.
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
