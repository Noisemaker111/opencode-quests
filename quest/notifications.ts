import type { Quest, QuestState } from "./types"
export type QuestNotification = { id: string; questID: string; state: QuestState; title: string; message: string; at: string }
export function transitionNotification(before: Quest | undefined, after: Quest): QuestNotification | undefined {
  if (!before || before.state === after.state || !["Working", "Needs attention", "Ready to complete", "Complete"].includes(after.state)) return
  return { id: `${after.id}:${after.lifecycleEpoch}:${after.state}`, questID: after.id, state: after.state, title: `Quest ${after.state}`, message: `${after.title}: ${after.reason}`, at: after.updatedAt }
}
