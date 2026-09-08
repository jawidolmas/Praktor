import type { Policy } from "@exec/core";

/**
 * Starter policy set.
 *
 * These encode the standing rules a person would otherwise have to restate in every
 * prompt. They are seeded once into the database and edited there afterwards.
 */
export const SEED_POLICIES: Omit<Policy, "id" | "key" | "createdAt">[] = [
  {
    title: "No force-push, and no direct push to a protected branch",
    rationale:
      "Rewriting shared history or bypassing review is not recoverable by a retry. " +
      "Found live: the original single-pattern version required \"push\" to sit " +
      "immediately after \"git\", which silently let git -C <path> push origin main " +
      "through — a worker's own idiomatic phrasing, not an edge case. Matched as an " +
      "array (every pattern must be present, anywhere) so it survives that.",
    matcher: {
      tool: "Bash",
      commandPattern: [
        "\\bpush\\b",
        "(?:--force(?:-with-lease)?\\b|\\borigin\\b[^;&|\\n]{0,20}?[:\\s](?:main|master|prod|production)\\b)",
      ],
    },
    severity: "HARD",
    action: "deny",
    scope: "global",
    enabled: true,
  },
  {
    title: "Production deploys must go through staging",
    rationale: "Standing rule: nothing reaches production unverified.",
    matcher: {
      tool: "Bash",
      commandPattern:
        "(deploy|release)\\b.*(prod|production)|kubectl\\s+.*--context[= ]\\S*prod",
    },
    severity: "HARD",
    action: "deny",
    scope: "global",
    enabled: true,
  },
  {
    title: "Destructive database statements require a decision",
    rationale:
      "DROP and unbounded DELETE are irreversible; a person decides, not a worker.",
    matcher: {
      tool: "Bash",
      commandPattern:
        "(drop\\s+(table|database|schema)|truncate\\s+table|delete\\s+from\\s+\\w+\\s*;)",
    },
    severity: "HARD",
    action: "ask",
    scope: "global",
    enabled: true,
  },
  {
    title: "Never commit a secrets file",
    rationale: "Credential exposure is an L3 incident, not a code review comment.",
    matcher: { pathPattern: "(^|/)\\.env(\\.|$)|(^|/)(id_rsa|\\.pem)$" },
    severity: "HARD",
    action: "deny",
    scope: "global",
    enabled: true,
  },
  {
    title: "Do not edit the supervisor's own state",
    rationale:
      "A worker must not be able to rewrite the event log, policies or decisions that govern it.",
    matcher: { pathPattern: "(^|/)\\.exec/" },
    severity: "HARD",
    action: "deny",
    scope: "global",
    enabled: true,
  },
  {
    title: "Installing new dependencies is worth noting",
    rationale: "Supply-chain changes should show up in the report, not pass silently.",
    matcher: {
      tool: "Bash",
      commandPattern: "(npm|pnpm|yarn)\\s+(i|add|install)\\s+\\S",
    },
    severity: "SOFT",
    action: "warn",
    scope: "global",
    enabled: true,
  },
];
