import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { backupSource, previewMigration } from "./migration"
import { QuestStore } from "./store"
import { digest } from "./privacy"
export type MigrationResult = { source: string; backup: string; sourceHash: string; questIDs: string[]; notice: string }
function stableID(source: string, line: number, raw: string): string { return `01${digest(`${source}\0${line}\0${raw}`).slice(0, 24)}` }
/** Migrate legacy records durably, then remove the obsolete source ledger. */
export function applyMigration(projectRoot: string, backupRoot = join(projectRoot, ".opencode", ".quest-runtime", "migration-backups")): MigrationResult[] {
  const store = new QuestStore(projectRoot), results: MigrationResult[] = []
  const checkpoint = join(backupRoot, "migration-checkpoint.json"); mkdirSync(backupRoot, { recursive: true })
  let completed = new Set<string>()
  if (existsSync(checkpoint)) {
    try {
      const value = JSON.parse(readFileSync(checkpoint, "utf8"))
      if (!Array.isArray(value?.completed) || value.completed.some((source: unknown) => typeof source !== "string")) throw new Error("invalid checkpoint")
      completed = new Set(value.completed)
    } catch {
      // Reconcile from source and deterministic Quest IDs rather than trusting a
      // damaged checkpoint. Existing Quest records make retry idempotent.
      completed = new Set()
    }
  }
  for (const preview of previewMigration(projectRoot)) {
    if (completed.has(preview.source)) continue
    const backup = backupSource(preview.source, backupRoot), questIDs: string[] = []
     const seenRows = new Set<string>()
     for (const row of preview.records) {
       if (seenRows.has(row.raw)) continue
       seenRows.add(row.raw)
      const id = stableID(preview.source, row.line, row.raw), existing = store.read(id)
      if (!existing) { const q = store.create({ id, title: row.raw.slice(0, 120), objective: row.raw, kind: "legacy", reason: row.disposition === "waiting" ? "Migrated from TODO" : "Legacy evidence requires verification", nextAction: row.disposition === "waiting" ? "Assign an exact execution session" : "Verify legacy evidence or attest explicitly", migration: { source: preview.source, appliedAt: new Date().toISOString(), records: [row] } }); questIDs.push(q.id) } else questIDs.push(existing.id)
    }
     const notice = `${preview.source} migrated and removed after durable Quest creation. backup=${backup.path} sha256=${backup.sha256}\n`, noticePath = join(projectRoot, ".opencode", "quests", "MIGRATION-NOTICES.md"); mkdirSync(join(projectRoot, ".opencode", "quests"), { recursive: true }); const prior = existsSync(noticePath) ? readFileSync(noticePath, "utf8") : "# Migration notices\n\n"; if (!prior.includes(notice)) writeAtomic(noticePath, prior + notice)
    // Commit the source reconciliation only after every quest and notice are durable.
     rmSync(preview.source)
     const next = join(backupRoot, `migration-checkpoint.${process.pid}.tmp`); writeFileSync(next, JSON.stringify({ version: 1, completed: [...completed, preview.source] })); renameSync(next, checkpoint); completed.add(preview.source)
    results.push({ source: preview.source, backup: backup.path, sourceHash: backup.sha256, questIDs, notice })
  }
  return results
}
function writeAtomic(path: string, content: string) { const tmp = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(tmp, content, "utf8"); renameSync(tmp, path) }
