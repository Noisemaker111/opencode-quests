import { questLane } from "./board"
import { requiredProofKinds } from "./stages"
import type { Quest, QuestStage } from "./types"

const ACTIVE_SESSION_STATES = new Set(["planned", "executing", "waiting", "blocked"])

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function clipped(values: string[], count: number, max: number): string[] {
  return values.slice(0, count).map((value) => clip(value, max))
}

function currentStage(q: Quest): QuestStage | undefined {
  const done = new Set(q.stages.filter((stage) => stage.status === "done").map((stage) => stage.id))
  return q.stages.find((stage) => stage.status !== "done" && stage.needs.every((id) => done.has(id)))
    ?? q.stages.find((stage) => stage.status !== "done")
}

export function compactQuestSummary(q: Quest) {
  const stage = currentStage(q)
  const stageIndex = stage ? q.stages.indexOf(stage) + 1 : q.stages.length
  return {
    id: q.id,
    title: clip(q.title, 120),
    state: q.state,
    lane: questLane(q),
    stage: q.stages.length ? `${stageIndex}/${q.stages.length}` : undefined,
    nextAction: clip(q.nextAction, 180),
    running: q.executingCount,
    updatedAt: q.updatedAt,
  }
}

/** Agent-facing detail is an executable slice, not a second copy of the ledger. */
export function compactQuestDetail(q: Quest) {
  const stage = currentStage(q)
  const latestSetback = stage ? q.setbacks.findLast((item) => item.stageID === stage.id) : q.setbacks.at(-1)
  const pending = q.acceptanceCriteria.filter((item) => !item.satisfied)
  const fallback = q.deliverables.filter((item) => item.status !== "done").slice(0, 8).map((item) => ({ id: item.id, title: clip(item.title, 180), status: item.status }))
  return {
    ...compactQuestSummary(q),
    objective: clip(q.objective, 500),
    scope: stage ? { repos: clipped(stage.claim.repos, 4, 160), include: clipped(stage.claim.include, 10, 140), exclude: clipped(stage.claim.exclude, 6, 140) }
      : { repos: clipped(q.scope.repos, 4, 160), include: clipped(q.scope.include, 10, 140), exclude: clipped(q.scope.exclude, 6, 140) },
    currentStage: stage ? {
      id: stage.id,
      title: clip(stage.title, 160),
      status: stage.status,
      attempt: stage.attempt,
      needs: stage.needs,
      todos: stage.todos.filter((todo) => todo.status !== "done").slice(0, 8).map((todo) => ({ id: todo.id, title: clip(todo.title, 140), status: todo.status })),
      proofRequired: requiredProofKinds(stage),
    } : undefined,
    pendingDeliverables: stage ? undefined : fallback,
    acceptance: pending.slice(0, 6).map((item) => ({ id: item.id, text: clip(item.text, 180) })),
    acceptanceRemaining: pending.length,
    payout: { provided: q.usageInstructions.length > 0, count: q.usageInstructions.length },
    abandoned: q.abandoned || undefined,
    latestSetback: latestSetback ? { stageID: latestSetback.stageID, attempt: latestSetback.attempt, reason: clip(latestSetback.reason, 300), rewindTo: latestSetback.rewindTo } : undefined,
    integrationOwner: q.integrationOwner,
    sessions: q.sessions.filter((session) => ACTIVE_SESSION_STATES.has(session.state)).slice(0, 12).map((session) => ({
      sessionID: session.openCodeSessionId ?? session.sessionID,
      role: session.role,
      state: session.state,
      model: session.model,
      task: session.task ? clip(session.task, 160) : undefined,
    })),
    review: q.evidence.review ? { verdict: q.evidence.review.verdict, at: q.evidence.review.at } : undefined,
  }
}
