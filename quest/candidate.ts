import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
export type CandidateResult = { ok: boolean; failures: string[]; entrypoints: string[] }
export function validateQuestCandidate(root: string): CandidateResult {
  const failures: string[] = [], entrypoints: string[] = []
  const manifest = join(root, "plugin-set.json")
  try { const value = JSON.parse(readFileSync(manifest, "utf8")); for (const path of value.entrypoints ?? []) { const full = join(root, path); entrypoints.push(path); if (!existsSync(full)) failures.push(`missing entrypoint: ${path}`); else if (/bun:test/.test(readFileSync(full, "utf8"))) failures.push(`test import in entrypoint: ${path}`) } } catch (e) { failures.push(`invalid plugin-set.json: ${String(e).slice(0, 200)}`) }
  return { ok: failures.length === 0, failures, entrypoints }
}
export function selectLastKnownGood(active: string, candidate: string): string { return validateQuestCandidate(candidate).ok ? candidate : active }
