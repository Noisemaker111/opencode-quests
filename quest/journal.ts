import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { validEvent } from "./events"
import type { QuestEvent } from "./types"

export function journalPath(runtimeRoot: string, questID: string): string { return join(runtimeRoot, "journals", `${questID}.jsonl`) }
export function appendEvent(runtimeRoot: string, event: QuestEvent): void {
  const path = journalPath(runtimeRoot, event.questID); mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8")
  const fd = openSync(path, "r+"); try { fsyncSync(fd) } finally { closeSync(fd) }
}
export function readEvents(runtimeRoot: string, questID: string): QuestEvent[] {
  const path = journalPath(runtimeRoot, questID); if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => { try { const e = JSON.parse(line); return validEvent(e) ? [e] : [] } catch { return [] } })
}
