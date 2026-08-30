import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { digest } from "./privacy"
import type { MigrationRecord, Quest } from "./types"

export type MigrationPreview = { source: string; records: MigrationRecord[]; quests: Array<Pick<Quest, "title" | "objective" | "state">> }
function records(path: string, disposition: string): MigrationRecord[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, "utf8"), out: MigrationRecord[] = [], lines = raw.split(/\r?\n/)
  let offset = 0
  lines.forEach((line, i) => { const start = offset; offset += Buffer.byteLength(line, "utf8") + (raw.slice(offset + Buffer.byteLength(line, "utf8"), offset + Buffer.byteLength(line, "utf8") + 2) === "\r\n" ? 2 : 1); if (!line.trim() || /^\s*#/.test(line)) return; out.push({ sourcePath: path, line: i + 1, start, end: offset, raw: line, sha256: digest(line), disposition }) })
  return out
}
export function previewMigration(projectRoot: string): MigrationPreview[] {
  const candidates = [join(projectRoot, ".opencode", "TODO.md"), join(projectRoot, ".opencode", "DONE.md"), join(projectRoot, ".opencode", "TEAMWORK.md"), join(projectRoot, "TODO.md"), join(projectRoot, "DONE.md"), join(projectRoot, "TEAMWORK.md")]
  return [...new Set(candidates)].filter(existsSync).map((source) => { const name = source.toUpperCase(); const disposition = name.includes("TODO") ? "waiting" : name.includes("DONE") ? "needs-attention" : "legacy-unverified"; const rs = records(source, disposition); return { source, records: rs, quests: rs.map((r) => ({ title: r.raw.replace(/^\s*-\s*(?:\[.\]\s*)?/, "").slice(0, 120), objective: r.raw, state: disposition === "waiting" ? "Waiting" : "Needs attention" as const })) } })
}
export function backupSource(source: string, backupRoot: string): { path: string; sha256: string } { mkdirSync(backupRoot, { recursive: true }); const bytes = readFileSync(source), path = join(backupRoot, `${source.replace(/[:\\/]/g, "_")}.bak`); writeFileSync(path, bytes); return { path, sha256: createHash("sha256").update(bytes).digest("hex") } }
export const SEED_MANIFEST = ["plugin recovery", "Claude Harness discoverability", "papercut UI", "no-focus spawning", "subscription usage prediction", "multi-request orchestration hardening"] as const
