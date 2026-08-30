import { installQuestHost } from "./host-adapter"
import { readAllQuests } from "./index"
import { watchQuests } from "./watcher"
import { boardRows } from "./board"
import { formatQuestLine } from "./tui-model"
export function questOverview(projectRoot: string, filter = ""): string {
  const quests = readAllQuests(projectRoot)
  const errors = quests.filter((x) => !x.quest).map(({ path, errors }) => `Needs attention  ${path}: ${errors.join("; ")}`)
  const rows = boardRows(quests.flatMap((x) => x.quest ? [x.quest] : []), { filter }).map((row) => row.kind === "header" ? row.label : formatQuestLine(row.quest))
  return [...errors, ...rows].join("\n")
}
export function setupQuestTUI(context: any, projectRoot: string): () => void { const dispose = installQuestHost(context?.ui, () => questOverview(projectRoot)); const stop = watchQuests(projectRoot, () => { try { context?.ui?.toast?.show?.({ title: "Quests", message: "Quest list refreshed", variant: "info" }) } catch {} }); try { context?.keymap?.register?.("/quests", () => context?.ui?.router?.navigate?.({ type: "quests" })) } catch {}; return () => { dispose(); stop() } }
