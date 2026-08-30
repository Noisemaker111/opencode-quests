import type { Quest } from "./types"
import { nonArchivedQuests } from "./index"
import { LANE_LABEL, boardRows, questLane } from "./board"
export type TuiRoute = { type: "overview"; filter?: string } | { type: "detail"; questID: string }
export type Frame = { width: number; lines: string[] }
export type QuestAction = "Accept" | "Execute" | "Complete" | "Turn in" | "Resume" | "Open session" | "Cancel"
/** Active means not archived; completion/work evidence never removes a Quest. */
export function activeQuestCount(quests: Quest[]): number { return nonArchivedQuests(quests).length }
export function questIndicator(quests: Quest[]): string { return `${activeQuestCount(quests)} Quests` }
export function formatQuestLine(q: Quest): string {
  const turnIn = q.state === "Ready to complete" || q.state === "Complete" ? " · Ready for you to turn in" : ""
  return `${q.state} ${q.title}${turnIn} (${q.executingCount} running, ${q.deliverables.filter((d) => d.status !== "done").length} left)`
}
export function renderFrame(quests: Quest[], route: TuiRoute, width: number): Frame {
  const lines = route.type === "detail"
    ? detail(quests.find((q) => q.id === route.questID), width)
    : [questIndicator(quests), ...boardRows(quests, { filter: route.filter }).map((row) => row.kind === "header" ? row.label : formatQuestLine(row.quest))]
  return { width, lines: lines.map((x) => x.slice(0, width)) }
}
export function detail(q: Quest | undefined, width: number): string[] {
  if (!q) return ["Quest not found"]
  const workers = q.sessions.flatMap((s) => [`Worker: ${s.role} · ${s.state}`, `  model=${s.model ?? "?"} call=${s.callID} task=${s.taskID ?? "?"} session=${s.openCodeSessionId ?? s.sessionID ?? "unbound"}`, `  claim=${s.worktree ?? "none"} parent=${s.parentID ?? s.parentSessionID ?? "none"} heartbeat=${s.lastHeartbeatAt ?? "none"} lease=${s.leaseExpiresAt ?? "none"}`, `  dependency=${s.dependency ? `${s.dependency.status}:${s.dependency.sessionID}:${s.dependency.file}:${s.dependency.reason}` : "none"}`, `  command=${s.commandSummary ?? "not recorded"} progress=${s.evidence.at(-1) ?? "none"} result=${s.result ?? "none"}`])
  const claims = q.claims.map((claim) => `Claim: ${claim.state} · ${claim.sessionID ?? "unbound"} · ${claim.include.join(", ") || "none"}`)
  return [
    `Quest: ${q.title}`,
    `Lane: ${LANE_LABEL[questLane(q)]}`,
    `State: ${q.state}`,
    `Owner: ${q.owner ?? "unassigned"} · integration=${q.integrationOwner ?? "unassigned"}`,
    `Reason: ${q.reason}`,
    `Next: ${q.nextAction}`,
    `Actions: [Accept] [Execute] [Complete] [Turn in]`,
    `Sessions: ${q.sessions.length} (${q.executingCount} executing)`,
    ...workers,
    ...claims,
    `Requirements: ${q.missingRequirements.join(", ") || "none"}`,
    `Evidence: history=${q.history.length} commits=${q.evidence.commits.length} tests=${q.evidence.tests.length} artifacts=${q.evidence.artifacts.length}`,
    q.state === "Ready to complete" || q.state === "Complete" ? "Turn in: explicit user action required" : "",
  ].filter(Boolean).map((x) => x.slice(0, width))
}
