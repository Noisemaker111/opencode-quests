import { completionMissing } from "./completion"
import { latestSessionAttempts } from "./session-lineage"
import type { Quest, QuestState } from "./types"

export function deriveState(q: Quest, lookup?: (id: string) => Quest | undefined): { state: QuestState; reason: string; nextAction: string; missing: string[] } {
  if (q.state === "Archived") return { state: "Archived", reason: q.reason || "Archived", nextAction: q.nextAction || "Reopen to resume work", missing: q.missingRequirements }
  if (q.state === "Complete") return { state: "Complete", reason: q.reason || "Explicitly completed", nextAction: q.nextAction || "Archive when no longer active", missing: [] }
  const currentSessions = latestSessionAttempts(q.sessions)
  const executing = currentSessions.filter((x) => x.state === "executing").length
  const failed = currentSessions.some((x) => ["failed", "cancelled", "missing", "stale"].includes(x.state))
  const blocked = currentSessions.some((x) => x.state === "blocked")
  const conflict = q.unresolvedWork.some((x) => /conflict|malformed|missing evidence/i.test(x))
  const missing = completionMissing(q, lookup)
  if (failed || blocked || conflict || q.evidence.review?.verdict === "BLOCK" || q.evidence.review?.verdict === "CONCERNS") {
    return { state: "Needs attention", reason: q.reason || "Work is blocked, failed, stale, conflicting, or missing evidence", nextAction: q.nextAction || "Resolve the first attention item", missing }
  }
  if (executing > 0) return { state: "Working", reason: q.reason || `${executing} linked session${executing === 1 ? " is" : "s are"} executing`, nextAction: q.nextAction || "Wait for linked execution evidence", missing }
  if (q.state === "Verifying") return { state: "Verifying", reason: q.reason || "Completion evidence is being checked", nextAction: q.nextAction || "Finish verification gates", missing }
  if (!missing.length && q.evidence.review?.verdict === "CLEAN") return { state: "Ready to complete", reason: "All completion gates are verified", nextAction: "Explicitly complete this Quest", missing }
  return { state: "Waiting", reason: q.reason || "No linked sessions are executing", nextAction: q.nextAction || "Start or resume an exact linked session", missing }
}

export function normalizeState(q: Quest, lookup?: (id: string) => Quest | undefined): Quest {
  q.executingCount = latestSessionAttempts(q.sessions).filter((x) => x.state === "executing").length
  const derived = deriveState(q, lookup)
  q.state = derived.state; q.reason = derived.reason; q.nextAction = derived.nextAction; q.missingRequirements = derived.missing
  return q
}
