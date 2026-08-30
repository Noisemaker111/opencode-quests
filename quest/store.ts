import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { acquireLock } from "./locking"
import { appendEvent, readEvents } from "./journal"
import { makeEvent } from "./events"
import { parseQuestMarkdown, serializeQuestMarkdown } from "./cst"
import { listQuestFiles } from "./index"
import { newQuest } from "./schema"
import { reduceQuest } from "./reducer"
import { completionMissing } from "./completion"
import type { Quest, QuestEvent } from "./types"

const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
function questID(): string {
  let value = Math.floor(Date.now() / 1000), time = ""
  for (let i = 0; i < 10; i++) { time = ULID_ALPHABET[value % 32] + time; value = Math.floor(value / 32) }
  let random = ""
  for (const byte of randomBytes(16)) random += ULID_ALPHABET[byte % 32]
  return `${time}${random}`.slice(0, 26)
}

export class QuestStore {
  readonly root: string
  readonly runtime: string
  constructor(public readonly projectRoot: string) {
    this.root = join(projectRoot, ".opencode", "quests")
    this.runtime = join(projectRoot, ".opencode", ".quest-runtime")
  }
  private path(id: string, slug = "quest") { return join(this.root, `${id}--${slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "quest"}.md`) }
  create(input: Partial<Quest> & Pick<Quest, "id" | "title" | "objective">): Quest {
    mkdirSync(this.root, { recursive: true })
    const lock = acquireLock(this.runtime, "admission")
    try { return this.createUnlocked(input) } finally { lock.release() }
  }
  private createUnlocked(input: Partial<Quest> & Pick<Quest, "id" | "title" | "objective">): Quest {
    const existing = this.find(input.id)
    if (existing) {
      const current = this.read(input.id)
      if (current && current.requestFingerprint === input.requestFingerprint) return current
      throw new Error(`Quest already exists with a different request: ${input.id}`)
    }
    const q = newQuest(input), path = this.path(q.id, q.title)
    const event = makeEvent(q.id, "created", {}, { lifecycleEpoch: q.lifecycleEpoch, expectedRevision: 0 })
    appendEvent(this.runtime, event); writeAtomic(path, serializeQuestMarkdown(q, "")); return q
  }
  /** Admit one user request exactly once; active duplicates return their original Quest. */
  admit(input: Omit<Partial<Quest>, "id"> & Pick<Quest, "title" | "objective" | "requestFingerprint">): Quest {
    mkdirSync(this.root, { recursive: true })
    const lock = acquireLock(this.runtime, "admission")
    try {
      const duplicate = listQuestFiles(this.projectRoot).map((path) => {
        const parsed = parseQuestMarkdown(readFileSync(path, "utf8")); return parsed.quest
      }).find((q): q is Quest => !!q && q.requestFingerprint === input.requestFingerprint && q.state !== "Archived")
      if (duplicate) return duplicate
      return this.createUnlocked({ ...input, id: questID() })
    } finally { lock.release() }
  }
  read(id: string): Quest | undefined {
    const file = this.find(id); if (!file) return
    const parsed = parseQuestMarkdown(readFileSync(file, "utf8")); if (parsed.readonly || !parsed.quest) return parsed.quest
    return readEvents(this.runtime, id).reduce(reduceQuest, parsed.quest)
  }
  apply(id: string, type: QuestEvent["type"], payload: Record<string, unknown>, source = `process:${process.pid}`): Quest {
    const file = this.find(id); if (!file) throw new Error(`Quest not found: ${id}`)
    const lock = acquireLock(this.runtime, id)
    try {
      const raw = readFileSync(file, "utf8"), parsed = parseQuestMarkdown(raw); if (!parsed.quest || parsed.readonly) throw new Error(`Quest is read-only: ${parsed.errors.join("; ")}`)
      const current = readEvents(this.runtime, id).reduce(reduceQuest, parsed.quest)
      if (type === "complete") {
        const missing = completionMissing(current, (dependencyID) => this.read(dependencyID))
        if (missing.length) throw new Error(`completion policy failed: ${missing.join(", ")}`)
      }
      // Detect a human edit before journaling. An event must never be appended
      // for a snapshot that cannot safely be written back.
      const freshBefore = parseQuestMarkdown(readFileSync(file, "utf8")); if (freshBefore.humanHash !== parsed.humanHash) throw new Error("concurrent human content conflict; reload and retry")
      const event = makeEvent(id, type, payload, { source, lifecycleEpoch: current.lifecycleEpoch, expectedRevision: current.revision })
      appendEvent(this.runtime, event); const next = reduceQuest(current, event)
      const fresh = parseQuestMarkdown(readFileSync(file, "utf8")); if (fresh.humanHash !== parsed.humanHash) throw new Error("concurrent human content conflict; reload and retry")
      writeAtomic(file, serializeQuestMarkdown(next, fresh.body, fresh)); return next
    } finally { lock.release() }
  }
  delete(id: string, confirmed = false): Quest {
    if (!confirmed) throw new Error("Quest deletion requires confirmed=true")
    const file = this.find(id); if (!file) throw new Error(`Quest not found: ${id}`)
    const lock = acquireLock(this.runtime, id)
    try {
      const parsed = parseQuestMarkdown(readFileSync(file, "utf8")); if (!parsed.quest || parsed.readonly) throw new Error(`Quest is read-only: ${parsed.errors.join("; ")}`)
      const current = readEvents(this.runtime, id).reduce(reduceQuest, parsed.quest)
      const event = makeEvent(id, "delete", { reason: "Explicitly deleted by user" }, { lifecycleEpoch: current.lifecycleEpoch, expectedRevision: current.revision })
      appendEvent(this.runtime, event)
      const deleted = reduceQuest(current, event)
      writeAtomic(file, serializeQuestMarkdown(deleted, parsed.body, parsed))
      const destination = join(this.runtime, "deleted", `${id}.md`)
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(file, destination)
      return deleted
    } finally { lock.release() }
  }
  find(id: string): string | undefined { return listQuestFiles(this.projectRoot).find((p) => p.includes(`${id}--`)) }
}
function writeAtomic(path: string, content: string) { const tmp = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(tmp, content, "utf8"); renameSync(tmp, path) }
