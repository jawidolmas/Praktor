import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./worktree.js";
import {
  foldIntoIntegrationBranch,
  integrationBranchExists,
  integrationBranchName,
  integrationScratchDirName,
  resolveTaskBaseRef,
} from "./integration.js";

let repoPath: string;
let worktreesDir: string;
const objectiveId = "obj-12345678-abcd";

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "integration-repo-"));
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-q", "-m", "init"]);
  worktreesDir = mkdtempSync(join(tmpdir(), "integration-worktrees-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

/** Simulates what a completed task leaves behind: a branch off main with one
 *  committed file, created through a real worktree so it behaves exactly
 *  like `createWorktree`'s output — without importing engine.ts's
 *  daemon-level orchestration into a packages/worker test. */
function createTaskBranch(branch: string, filename: string, content: string): void {
  const path = join(worktreesDir, branch.replace(/\//g, "_"));
  git(repoPath, ["worktree", "add", "-b", branch, path, "main"]);
  writeFileSync(join(path, filename), content);
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", `add ${filename}`]);
  git(repoPath, ["worktree", "remove", path, "--force"]);
}

describe("integrationBranchName / integrationScratchDirName", () => {
  it("derives stable, distinct names from the objective id", () => {
    expect(integrationBranchName(objectiveId)).toBe("exec/obj-1234-integration");
    expect(integrationScratchDirName(objectiveId)).toBe(`${objectiveId}-integration-scratch`);
  });
});

describe("resolveTaskBaseRef", () => {
  it("uses the objective's own base ref for a task with no dependencies, regardless of any integration branch", () => {
    createTaskBranch("exec/t1-attempt-1", "A.md", "a\n");
    foldIntoIntegrationBranch({ repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t1-attempt-1", worktreesDir });

    const ref = resolveTaskBaseRef({ repoPath, objectiveId, objectiveBaseRef: "main", dependsOn: [] });
    expect(ref).toBe("main");
  });

  it("falls back to the objective's base ref for a dependent task when nothing has been integrated yet", () => {
    const ref = resolveTaskBaseRef({ repoPath, objectiveId, objectiveBaseRef: "main", dependsOn: ["T-001"] });
    expect(ref).toBe("main");
  });

  it("points a dependent task at the integration branch once something has been folded into it", () => {
    createTaskBranch("exec/t1-attempt-1", "A.md", "a\n");
    foldIntoIntegrationBranch({ repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t1-attempt-1", worktreesDir });

    const ref = resolveTaskBaseRef({ repoPath, objectiveId, objectiveBaseRef: "main", dependsOn: ["T-001"] });
    expect(ref).toBe(integrationBranchName(objectiveId));
  });
});

describe("foldIntoIntegrationBranch", () => {
  it("creates the integration branch on the first fold and leaves no scratch worktree behind", () => {
    createTaskBranch("exec/t1-attempt-1", "A.md", "from task 1\n");

    const result = foldIntoIntegrationBranch({
      repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t1-attempt-1", worktreesDir,
    });

    expect(result.ok).toBe(true);
    expect(integrationBranchExists(repoPath, objectiveId)).toBe(true);
    expect(existsSync(join(worktreesDir, integrationScratchDirName(objectiveId)))).toBe(false);

    const content = git(repoPath, ["show", `${integrationBranchName(objectiveId)}:A.md`]);
    expect(content).toBe("from task 1");
  });

  it("accumulates a second, independent task's branch on top of the first", () => {
    createTaskBranch("exec/t1-attempt-1", "A.md", "from task 1\n");
    createTaskBranch("exec/t2-attempt-1", "B.md", "from task 2\n");

    foldIntoIntegrationBranch({ repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t1-attempt-1", worktreesDir });
    const second = foldIntoIntegrationBranch({
      repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t2-attempt-1", worktreesDir,
    });

    expect(second.ok).toBe(true);
    // This is the actual fix: a dependent task checking out the integration
    // branch now sees BOTH prior tasks' files, not just one, and not neither.
    const branch = integrationBranchName(objectiveId);
    expect(git(repoPath, ["show", `${branch}:A.md`])).toBe("from task 1");
    expect(git(repoPath, ["show", `${branch}:B.md`])).toBe("from task 2");
    expect(existsSync(join(worktreesDir, integrationScratchDirName(objectiveId)))).toBe(false);
  });

  it("folds cleanly when the task branch edits a file that already existed in the base commit", () => {
    // The bug this guards against only showed up on a file that was already
    // committed at objectiveBaseRef (README.md, from the repo's own init
    // commit in beforeEach) — a task branch that only ever adds brand-new
    // files never exercises the scratch worktree's checkout of a
    // pre-existing file, which is exactly what a real "edit the README"
    // task does. Confirmed live: on a host with core.autocrlf=true (the
    // common Windows default), the scratch worktree checked README.md out
    // with CRLF while the merge ran forced to core.autocrlf=false, and git
    // saw the mismatch as a real local modification and refused to merge —
    // "Your local changes to the following files would be overwritten by
    // merge" — even though nothing had actually touched the file by hand.
    const editBranch = "exec/t-edit-readme-attempt-1";
    const path = join(worktreesDir, "edit-readme");
    git(repoPath, ["-c", "core.autocrlf=false", "worktree", "add", "-b", editBranch, path, "main"]);
    writeFileSync(join(path, "README.md"), "hello\n\nedited by a task\n");
    git(path, ["add", "-A"]);
    git(path, ["commit", "-q", "-m", "edit README"]);
    git(repoPath, ["worktree", "remove", path, "--force"]);

    const result = foldIntoIntegrationBranch({ repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: editBranch, worktreesDir });

    expect(result.ok).toBe(true);
    expect(git(repoPath, ["show", `${integrationBranchName(objectiveId)}:README.md`])).toBe("hello\n\nedited by a task");
  });

  it("reports a conflict without corrupting the branch, and still cleans up the scratch worktree", () => {
    createTaskBranch("exec/t1-attempt-1", "SAME.md", "task 1's version\n");
    createTaskBranch("exec/t2-attempt-1", "SAME.md", "task 2's conflicting version\n");

    foldIntoIntegrationBranch({ repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t1-attempt-1", worktreesDir });
    const second = foldIntoIntegrationBranch({
      repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t2-attempt-1", worktreesDir,
    });

    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/conflicts/i);
    // The branch still reflects the first (successful) fold — a conflicting
    // second fold doesn't roll that back or leave the branch mid-merge.
    const branch = integrationBranchName(objectiveId);
    expect(git(repoPath, ["show", `${branch}:SAME.md`])).toBe("task 1's version");
    expect(existsSync(join(worktreesDir, integrationScratchDirName(objectiveId)))).toBe(false);
  });

  it("gives a dependent task's own worktree the integrated files when checked out from the integration branch", () => {
    createTaskBranch("exec/t1-attempt-1", "A.md", "from task 1\n");
    createTaskBranch("exec/t2-attempt-1", "B.md", "from task 2\n");
    foldIntoIntegrationBranch({ repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t1-attempt-1", worktreesDir });
    foldIntoIntegrationBranch({ repoPath, objectiveId, objectiveBaseRef: "main", taskBranch: "exec/t2-attempt-1", worktreesDir });

    const dependentBaseRef = resolveTaskBaseRef({ repoPath, objectiveId, objectiveBaseRef: "main", dependsOn: ["T-001", "T-002"] });
    const dependentPath = join(worktreesDir, "dependent-task-worktree");
    // Same core.autocrlf=false override createWorktree itself uses — without
    // it this assertion is at the mercy of the host's global git config.
    git(repoPath, ["-c", "core.autocrlf=false", "worktree", "add", "-B", "exec/t3-attempt-1", dependentPath, dependentBaseRef]);

    expect(readFileSync(join(dependentPath, "A.md"), "utf8")).toBe("from task 1\n");
    expect(readFileSync(join(dependentPath, "B.md"), "utf8")).toBe("from task 2\n");
  });
});
