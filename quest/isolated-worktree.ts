import { hiddenExecFileSync } from "../scripts/windows-process"
import { ensureDeclaredWorktree, type DeclaredWorktree } from "./worktree"

/** Orchestrator-only: create a real isolated checkout for a variation fork. */
export function addIsolatedWorktree(repo: string, worktree: string, branch: string): void {
  hiddenExecFileSync("git", ["-C", repo, "worktree", "add", "-B", branch, worktree, "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/** Shared tree (omitted / repo===worktree) never creates. Isolated missing paths call git. */
export function ensureIsolatedWorktree(spec: DeclaredWorktree): void {
  const target = spec.worktree?.trim()
  ensureDeclaredWorktree(spec, () => {
    if (target) addIsolatedWorktree(spec.repo, target, spec.branch)
  })
}
