import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseQuestMarkdown } from "./cst"
import type { Quest } from "./types"
export { boardRows, questBoard, questLane, sortNewestFirst } from "./board"

export function listQuestFiles(projectRoot: string): string[] {
  try { return readdirSync(join(projectRoot, ".opencode", "quests")).filter((x) => /^[0-9a-hjkmnp-tv-z]{26}--.+\.md$/.test(x)).sort().map((x) => join(projectRoot, ".opencode", "quests", x)) } catch { return [] }
}
export function readAllQuests(projectRoot: string): Array<{ quest?: Quest; path: string; errors: string[] }> {
  return listQuestFiles(projectRoot).map((path) => { const p = parseQuestMarkdown(readFileSync(path, "utf8")); return { quest: p.errors.length ? undefined : p.quest, path, errors: p.errors } })
}
export function nonArchivedQuests(quests: Quest[]): Quest[] { return quests.filter((q) => q.state !== "Archived") }
export function generateQuestIndex(projectRoot: string): string {
  const rows = readAllQuests(projectRoot).map(({ quest: q, path, errors }) => q
    ? `| ${q.state === "Ready to complete" || q.state === "Complete" ? `${q.state} (ready for user turn-in)` : q.state} | [${q.title}](quests/${path.split(/[\\/]/).pop()}) | ${q.executingCount} | ${q.deliverables.filter((d) => d.status !== "done").length} | ${q.updatedAt} |`
    : `| Needs attention | ${path.split(/[\\/]/).pop()} | 0 | ? | ${errors.join("; ")} |`).sort()
  return ["# Quest Log", "", "<!-- generated: do not edit; Quest Markdown files are authoritative -->", "", "| State | Quest | Executing | Remaining | Updated |", "|---|---|---:|---:|---|", ...rows, ""].join("\n")
}
