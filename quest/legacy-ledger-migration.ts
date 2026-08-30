import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { readAllQuests } from "./index"
import { QuestStore } from "./store"
import type { Quest } from "./types"

export const LEGACY_QUEST_MIGRATION_VERSION = 1
export const LEGACY_QUEST_REPORT_SCHEMA = "opencode.legacy-quest-migration/v1" as const

export type LegacyClassification = "kept" | "ambiguous" | "legacy-message-junk" | "task-launch-junk" | "task-notification-junk"
export type LegacyQuestDecision = {
  questID: string
  source: string
  backup: string
  classification: LegacyClassification
  confidence: "high" | "ambiguous" | "substantive"
  reason: string
  sourceHash: string
  sessionIDs: string[]
  linkDigests: string[]
  parseErrors?: string[]
}
export type LegacyProjectCounts = {
  scanned: number
  parsed: number
  invalid: number
  kept: number
  ambiguous: number
  highConfidenceJunk: number
  legacyMessageJunk: number
  taskLaunchJunk: number
  taskNotificationJunk: number
  changed: number
  alreadyMigrated: number
}
export type LegacyProjectReport = {
  projectRoot: string
  ledger: string
  backupRoot: string
  backupManifest: string
  counts: LegacyProjectCounts
  decisions: LegacyQuestDecision[]
}
export type LegacyMigrationReport = {
  schema: typeof LEGACY_QUEST_REPORT_SCHEMA
  version: typeof LEGACY_QUEST_MIGRATION_VERSION
  mode: "preview" | "apply"
  projects: LegacyProjectReport[]
}

const DB_FILE = join(homedir(), ".local", "share", "opencode", "opencode.db")
const HIGH_CONFIDENCE = new Set<LegacyClassification>(["legacy-message-junk", "task-launch-junk", "task-notification-junk"])

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function distinctMatches(text: string, pattern: RegExp): string[] {
  return [...new Set(text.match(pattern) ?? [])].sort()
}

function traceDigests(text: string): Pick<LegacyQuestDecision, "sessionIDs" | "linkDigests"> {
  return {
    sessionIDs: distinctMatches(text, /(?:ses_|cc_)[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27,}/gi),
    linkDigests: distinctMatches(text, /https?:\/\/[^\s<>()"']+/gi).map(sha256).sort(),
  }
}

function durableEvidenceCount(q: Quest): number {
  return q.evidence.commits.length + q.evidence.tests.length + q.evidence.builds.length + q.evidence.artifacts.length + q.evidence.publish.length + (q.evidence.review ? 1 : 0)
}

function hasExplicitGoalMetadata(q: Quest): boolean {
  return durableEvidenceCount(q) > 0 || q.deliverables.length > 0 || q.acceptanceCriteria.length > 0 || q.claims.length > 0 || q.kind === "migration" || q.migration.records.length > 0
}

type DecisionTrace = Pick<LegacyQuestDecision, "source" | "backup">
type LegacyMessageOrigin = { sessionID: string; text: string; createdAt: number }

export function classifyLegacyQuest(q: Quest, sourceHash = "", trace: DecisionTrace = { source: "", backup: "" }, origin?: LegacyMessageOrigin): LegacyQuestDecision {
  const migrated = q.extensions.legacyQuestMigration as Partial<LegacyQuestDecision> & { version?: unknown } | undefined
  if (migrated?.version === LEGACY_QUEST_MIGRATION_VERSION && HIGH_CONFIDENCE.has(migrated.classification as LegacyClassification)) {
    return {
      questID: q.id,
      ...trace,
      classification: migrated.classification as LegacyClassification,
      confidence: "high",
      reason: String(migrated.reason ?? "legacy migration tombstone"),
      sourceHash: String(migrated.sourceHash ?? sourceHash),
      sessionIDs: Array.isArray(migrated.sessionIDs) ? [...new Set(migrated.sessionIDs.map(String))].sort() : [],
      linkDigests: Array.isArray(migrated.linkDigests) ? [...new Set(migrated.linkDigests.map(String))].sort() : [],
    }
  }

  const text = q.objective.trim()
  const traces = traceDigests(`${q.objective}\n${JSON.stringify(q.sessions)}\n${JSON.stringify(q.evidence)}\n${JSON.stringify(q.extensions)}`)
  const decision = (classification: LegacyClassification, confidence: LegacyQuestDecision["confidence"], reason: string): LegacyQuestDecision => ({ questID: q.id, ...trace, classification, confidence, reason, sourceHash, ...traces })

  if (/^<(?:task|subagent)\b/i.test(text) || /^<conversation-checkpoint>/i.test(text)) {
    return decision("task-notification-junk", "high", "raw internal completion/checkpoint envelope")
  }
  if (/^(?:You are a subagent spawned by another session\.|Continue the SAME\b|Instructions from:)/i.test(text)) {
    return decision("task-launch-junk", "high", "raw worker/context launch envelope")
  }
  if (hasExplicitGoalMetadata(q)) return decision("kept", "substantive", "explicit goal or durable execution/evidence")

  const generatedWorkerLaunch = !!q.requestFingerprint && q.title.trim() === text && q.sessions.length > 0 &&
    q.sessions.every((session) => session.role === "worker")
  if (generatedWorkerLaunch) return decision("task-launch-junk", "high", "legacy auto-admitted worker launch")
  if (/^User requested that active blocking work be moved to the background\./i.test(text) ||
      /^(?:The server restarted while you were working|The previous response was interrupted)\./i.test(text) ||
      /^(?:hello|hi|hey|who are you)[.!?\s]*$/i.test(text)) {
    return decision("legacy-message-junk", "high", "non-goal conversational/system message")
  }
  if (q.sessions.length) return decision("kept", "substantive", "record owns durable execution sessions")
  if (origin) {
    const result = decision("legacy-message-junk", "high", "legacy auto-admitted SQLite user message")
    result.sessionIDs = [...new Set([...result.sessionIDs, origin.sessionID])].sort()
    return result
  }
  return decision("ambiguous", "ambiguous", "unbound user-authored record; preserved for review")
}

function legacyMessageOrigins(databaseFile: string): LegacyMessageOrigin[] {
  if (!existsSync(databaseFile)) return []
  const db = new Database(databaseFile, { readonly: true })
  try {
    const tables = new Set((db.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
    if (!tables.has("session_message")) return []
    return (db.query("select session_id as sessionID, time_created as createdAt, data from session_message where type = 'user'").all() as Array<{ sessionID: string; createdAt: number; data: string }>).flatMap((row) => {
      try {
        const data = JSON.parse(row.data)
        return typeof data?.text === "string" ? [{ sessionID: row.sessionID, text: data.text.trim(), createdAt: row.createdAt }] : []
      } catch { return [] }
    })
  } catch { return [] }
  finally { db.close() }
}

export function discoverKnownQuestRoots(databaseFile = DB_FILE, additionalRoots: string[] = []): string[] {
  const roots = new Set(additionalRoots.map((root) => resolve(root)))
  if (existsSync(databaseFile)) {
    const db = new Database(databaseFile, { readonly: true })
    try {
      const tables = new Set((db.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
      const queries = [
        tables.has("project") ? "select worktree as directory from project" : "",
        tables.has("project_directory") ? "select directory from project_directory" : "",
        tables.has("worktree") ? "select directory from worktree" : "",
        tables.has("session_v2") ? "select distinct directory from session_v2" : "",
        tables.has("session") ? "select distinct directory from session" : "",
      ].filter(Boolean)
      for (const query of queries) {
        try {
          for (const row of db.query(query).all() as Array<{ directory?: unknown }>) {
            if (typeof row.directory === "string" && row.directory) roots.add(resolve(row.directory))
          }
        } catch {
          // Older databases can have one of these tables without the modern column.
        }
      }
    } finally { db.close() }
  }
  return [...roots].filter((root) => existsSync(join(root, ".opencode", "quests"))).sort()
}

type BackupFile = { source: string; backup: string; sha256: string }

function backupLedger(projectRoot: string, entries: ReturnType<typeof readAllQuests>): { backupRoot: string; manifest: string; files: BackupFile[] } {
  const backupRoot = join(projectRoot, ".opencode", ".quest-runtime", `legacy-migration-v${LEGACY_QUEST_MIGRATION_VERSION}`, "backups")
  mkdirSync(backupRoot, { recursive: true })
  const files = entries.map((entry): BackupFile => {
    const bytes = readFileSync(entry.path)
    const marker = entry.quest?.extensions.legacyQuestMigration as { version?: unknown; sourceHash?: unknown } | undefined
    const migratedHash = marker?.version === LEGACY_QUEST_MIGRATION_VERSION && typeof marker.sourceHash === "string" ? marker.sourceHash : undefined
    const hash = migratedHash ?? sha256(bytes)
    const backup = join(backupRoot, `${basename(entry.path, ".md")}.${hash.slice(0, 16)}.md`)
    if (migratedHash && !existsSync(backup)) throw new Error(`Original migration backup is missing: ${backup}`)
    if (!migratedHash && !existsSync(backup)) copyFileSync(entry.path, backup)
    return { source: relative(projectRoot, entry.path).replace(/\\/g, "/"), backup: relative(projectRoot, backup).replace(/\\/g, "/"), sha256: hash }
  })
  const manifest = join(backupRoot, "manifest.json")
  let priorFiles: BackupFile[] = []
  if (existsSync(manifest)) {
    try {
      const prior = JSON.parse(readFileSync(manifest, "utf8"))
      if (Array.isArray(prior?.files)) priorFiles = prior.files
    } catch {}
  }
  const merged = new Map([...priorFiles, ...files].map((file) => [`${file.source}\0${file.sha256}`, file]))
  const manifestText = JSON.stringify({ schema: "opencode.legacy-quest-backup/v1", version: LEGACY_QUEST_MIGRATION_VERSION, projectRoot, files: [...merged.values()].sort((a, b) => a.source.localeCompare(b.source) || a.sha256.localeCompare(b.sha256)) }, null, 2) + "\n"
  if (!existsSync(manifest) || readFileSync(manifest, "utf8") !== manifestText) writeAtomic(manifest, manifestText)
  return { backupRoot, manifest, files }
}

function invalidDecision(entry: ReturnType<typeof readAllQuests>[number], backup: BackupFile): LegacyQuestDecision {
  const raw = readFileSync(entry.path, "utf8")
  return {
    questID: basename(entry.path).split("--", 1)[0],
    source: backup.source,
    backup: backup.backup,
    classification: "ambiguous",
    confidence: "ambiguous",
    reason: "Quest record could not be parsed; preserved for review",
    sourceHash: backup.sha256,
    ...traceDigests(raw),
    parseErrors: entry.errors.map(String),
  }
}

export function migrateLegacyQuestRoots(projectRoots: string[], apply = false, databaseFile = DB_FILE): LegacyMigrationReport {
  const originsByText = new Map<string, LegacyMessageOrigin[]>()
  for (const origin of legacyMessageOrigins(databaseFile)) originsByText.set(origin.text, [...(originsByText.get(origin.text) ?? []), origin])
  const projects = [...new Set(projectRoots.map((root) => resolve(root)))].sort().map((projectRoot): LegacyProjectReport => {
    const entries = readAllQuests(projectRoot)
    const backup = backupLedger(projectRoot, entries)
    const decisions = entries.map((entry, index) => {
      const file = backup.files[index]
      const trace = { source: file.source, backup: file.backup }
      if (!entry.quest) return invalidDecision(entry, file)
      const createdAt = Date.parse(entry.quest.createdAt)
      const matches = (originsByText.get(entry.quest.objective.trim()) ?? []).filter((origin) => Number.isFinite(createdAt) && Math.abs(origin.createdAt - createdAt) <= 1_000)
      return classifyLegacyQuest(entry.quest, file.sha256, trace, matches.length === 1 ? matches[0] : undefined)
    })
    let changed = 0
    let alreadyMigrated = 0
    if (apply) {
      const store = new QuestStore(projectRoot)
      for (const decision of decisions) {
        if (!HIGH_CONFIDENCE.has(decision.classification)) continue
        let current = store.read(decision.questID)
        if (!current) continue
        const prior = current.extensions.legacyQuestMigration as { version?: unknown } | undefined
        let recordChanged = false
        if (prior?.version !== LEGACY_QUEST_MIGRATION_VERSION) {
          current = store.apply(current.id, "patched", { extensions: { ...current.extensions, legacyQuestMigration: { version: LEGACY_QUEST_MIGRATION_VERSION, classification: decision.classification, confidence: decision.confidence, reason: decision.reason, sourceHash: decision.sourceHash, sessionIDs: decision.sessionIDs, linkDigests: decision.linkDigests, tombstone: true } } }, "legacy-quest-migration:v1")
          recordChanged = true
        }
        if (current.state !== "Archived") {
          store.apply(current.id, "archive", { reason: `Legacy migration: ${decision.reason}` }, "legacy-quest-migration:v1")
          recordChanged = true
        }
        if (recordChanged) changed++
        else alreadyMigrated++
      }
    }
    const classificationCount = (classification: LegacyClassification) => decisions.filter((decision) => decision.classification === classification).length
    const highConfidenceJunk = decisions.filter((decision) => HIGH_CONFIDENCE.has(decision.classification)).length
    return {
      projectRoot,
      ledger: join(projectRoot, ".opencode", "quests"),
      backupRoot: backup.backupRoot,
      backupManifest: backup.manifest,
      counts: {
        scanned: entries.length,
        parsed: entries.filter((entry) => !!entry.quest).length,
        invalid: entries.filter((entry) => !entry.quest).length,
        kept: classificationCount("kept"),
        ambiguous: classificationCount("ambiguous"),
        highConfidenceJunk,
        legacyMessageJunk: classificationCount("legacy-message-junk"),
        taskLaunchJunk: classificationCount("task-launch-junk"),
        taskNotificationJunk: classificationCount("task-notification-junk"),
        changed,
        alreadyMigrated,
      },
      decisions,
    }
  })
  return { schema: LEGACY_QUEST_REPORT_SCHEMA, version: LEGACY_QUEST_MIGRATION_VERSION, mode: apply ? "apply" : "preview", projects }
}

export function writeLegacyMigrationReport(report: LegacyMigrationReport, path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeAtomic(path, JSON.stringify(report, null, 2) + "\n")
}

function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, "utf8")
  renameSync(temp, path)
}
