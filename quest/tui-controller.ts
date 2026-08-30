/**
 * Pure Quest list / detail / action logic for the TUI.
 *
 * The Quest chrome used to compute its rows, its detail fields and which
 * action buttons to show inline in JSX, so none of it could be tested without
 * a host. Nothing here touches the host, solid-js or the DOM: it takes Quests
 * in and returns strings, ids and descriptors. `tui-active/quests.tsx` is then
 * only wiring.
 */
import type { Quest } from "./types"
import { boardRows, type BoardRow } from "./board"
import { runQuestCommand } from "./commands"
import type { QuestStore } from "./store"
import { canonicalWorkerTitle } from "../orchestration/dispatch"

/** One row of the Quest list, as the chrome renders it today. */
export function questRowLabel(q: Quest): string {
  const remaining = q.deliverables.filter((d) => d.status !== "done").length
  return `${q.state} · ${q.title} · ${q.executingCount} executing · ${remaining} remaining`
}

/** One row of the in-session sidebar list, which is terser than the log row. */
export function questSidebarLine(q: Quest): string {
  const remaining = q.deliverables.filter((d) => d.status !== "done").length
  return `${q.state} · ${q.title}${remaining ? ` · ${remaining} left` : ""}`
}

/** The header fields the detail view shows above the actions. */
export function questDetailFields(q: Quest): string[] {
  return [
    q.title,
    `${q.state} · ${q.reason}`,
    `Next: ${q.nextAction}`,
    `Sessions: ${q.sessions.length} · Remaining: ${q.missingRequirements.join(", ") || "none"}`,
  ]
}

export function questClaimLabels(q: Quest): string[] {
  return q.claims.map((claim) => `${claim.state} · ${claim.sessionID ?? "unbound"} · ${claim.include.join(", ") || "no paths"}`)
}

/** Quests whose sessions include this session id. */
export function questsForSession(quests: Quest[], sessionID: string): Quest[] {
  return quests.filter((q) => q.sessions.some((s) => s.sessionID === sessionID || s.openCodeSessionId === sessionID || s.parentID === sessionID || s.parentSessionID === sessionID))
}

/** Picker rows include archived Quests so reopen and permanent delete stay reachable. */
export function questPickerRows(quests: Quest[]): BoardRow[] {
  return boardRows(quests, { includeArchived: true })
}

export type QuestActionID = "accept" | "start-session" | "complete" | "turn-in" | "archive" | "abandon" | "reopen" | "delete"

export type QuestAction = {
  id: QuestActionID
  /** Tracker verb passed to runQuestCommand. */
  command: string
  title: string
  /** Set when the UI must confirm before the verb runs. */
  confirm?: string
}

/**
 * Which verbs a Quest currently offers. Completion and turn-in only appear
 * once the Quest is actually finishable — offering "Turn in" on a Waiting
 * Quest just produces a policy error the user cannot act on.
 */
export function questActions(q: Quest): QuestAction[] {
  if (q.state === "Archived") return [
    { id: "reopen", command: "reopen", title: "Reopen" },
    { id: "delete", command: "delete", title: "Delete", confirm: "Permanently delete this Quest?" },
  ]
  const actions: QuestAction[] = [
    { id: "accept", command: "accept", title: "Accept" },
    { id: "start-session", command: "start-session", title: "Start session" },
  ]
  if (q.state === "Ready to complete" || q.state === "Complete") {
    actions.push({ id: "complete", command: "complete", title: "Complete" })
    actions.push({ id: "turn-in", command: "turn-in", title: "Turn in Quest", confirm: "Confirm turn in Quest" })
  }
  actions.push({ id: "archive", command: "archive", title: "Archive" })
  actions.push({ id: "abandon", command: "abandon", title: "Abandon", confirm: "Abandon this Quest?" })
  actions.push({ id: "delete", command: "delete", title: "Delete", confirm: "Permanently delete this Quest?" })
  return actions
}

export function questSessionLabel(session: Quest["sessions"][number]): string {
  const model = session.model?.split("/")
  const providerID = session.providerID ?? (model && model.length > 1 ? model.shift() : undefined)
  const modelID = session.modelID ?? (model && model.length ? model.join("/") : undefined)
  const title = providerID && modelID
    ? canonicalWorkerTitle({ providerID, modelID, task: session.task ?? session.taskDescription ?? session.taskID ?? "Task" })
    : session.task ?? session.taskDescription ?? session.taskID ?? "Unbound task"
  const exactSession = session.openCodeSessionId ?? session.openCodeSessionID ?? session.sessionID ?? "unbound"
  const heartbeat = session.lastHeartbeatAt ?? "none"
  const dependency = session.dependency ? ` · dependency=${session.dependency.status}:${session.dependency.sessionID} file=${session.dependency.file} reason=${session.dependency.reason}` : ""
  return `${title} · ${session.state} · ${session.runtime ?? session.harness ?? "native"}/${session.agentRole ?? session.role} · session=${exactSession} · heartbeat=${heartbeat}${dependency}`
}

export type QuestActionResult = { ok: true; quest: Quest } | { ok: false; error: string }

/** Bounded so a stack trace never becomes the whole dialog. */
export function questErrorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 180)
}

/** Run a tracker verb, reporting failure as text instead of throwing at the host. */
export function applyQuestAction(
  store: QuestStore,
  command: string,
  id: string,
  args: Record<string, unknown> = {},
): QuestActionResult {
  try {
    return { ok: true, quest: runQuestCommand(store, command, id, args) }
  } catch (error) {
    return { ok: false, error: questErrorText(error) }
  }
}
