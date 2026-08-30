import { existsSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

export type DeclaredWorktree = { repo: string; branch: string; worktree?: string }

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

function resolvedWorktree(spec: DeclaredWorktree): string | undefined {
  return spec.worktree?.trim() || spec.repo || undefined
}

export function isIsolatedWorktree(spec: DeclaredWorktree): boolean {
  const declared = spec.worktree?.trim()
  return Boolean(declared && spec.repo && !samePath(declared, spec.repo))
}

export function validateDeclaredWorktree(spec: DeclaredWorktree): string[] {
  const errors: string[] = []
  if (!spec.repo || !isAbsolute(spec.repo)) errors.push("repo must be an absolute path")
  if (!spec.branch?.trim()) errors.push("branch is required")
  const declared = spec.worktree?.trim()
  if (declared && !isAbsolute(declared)) errors.push("worktree must be an absolute path")
  const cwd = resolvedWorktree(spec)
  if (declared && spec.repo && !samePath(declared, spec.repo) && !existsSync(declared)) errors.push("worktree is not a directory")
  if (cwd && existsSync(cwd) && !statSync(cwd).isDirectory()) errors.push("worktree is not a directory")
  return errors
}

/** Shared tree is valid: omitted worktree means repo and create is not called.
 *  Isolated paths (worktree !== repo) may call create when the directory is missing. */
export function ensureDeclaredWorktree(spec: DeclaredWorktree, create?: () => void): void {
  const resolved = { ...spec, worktree: resolvedWorktree(spec) }
  const before = validateDeclaredWorktree(resolved)
    .filter((error) => error !== "worktree is not a directory")
  if (before.length) throw new Error(`invalid declared worktree: ${before.join("; ")}`)
  const isolated = isIsolatedWorktree(spec)
  if (isolated && resolved.worktree && !existsSync(resolved.worktree) && create) create()
  const after = validateDeclaredWorktree({ ...spec, worktree: resolvedWorktree(spec) })
  const path = resolvedWorktree(spec)
  if (after.length || !path || !existsSync(path)) throw new Error(`worktree creation failed: ${after.join("; ") || "path does not exist"}`)
}
