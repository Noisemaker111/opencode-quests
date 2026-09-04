import { bounded, redact } from "./privacy"
import { normalizeState } from "./state-machine"
import type { Quest, QuestEvent, QuestSession, SessionState } from "./types"
import { dependentStageIDs } from "./stages"

const terminalRank: Record<string, number> = { planned: 0, waiting: 1, executing: 2, blocked: 3, completed: 4, cancelled: 5, stale: 6, missing: 7, failed: 8 }
function mergeSessionState(oldState: SessionState, next: SessionState): SessionState {
  // A resume is a distinct attempt/call. Within one attempt terminal evidence is monotonic.
  return terminalRank[next] >= terminalRank[oldState] ? next : oldState
}
function findSession(q: Quest, payload: any): QuestSession | undefined {
  if (payload.callID) return q.sessions.find((s) => s.callID === payload.callID)
  if (payload.sessionID) return q.sessions.find((s) => s.sessionID === payload.sessionID)
}

function sessionIdentity(payload: any) {
  return {
    parentID: redact(payload.parentID ?? "", 300) || undefined,
    agentRole: redact(payload.agentRole ?? payload.role ?? "worker", 100),
    providerID: redact(payload.providerID ?? "", 100) || undefined,
    modelID: redact(payload.modelID ?? "", 150) || undefined,
    runtime: payload.runtime === "claude-code" ? "claude-code" as const : payload.runtime === "native" ? "native" as const : undefined,
    openCodeSessionId: redact(payload.openCodeSessionId ?? "", 300) || undefined,
    runtimeSessionId: redact(payload.runtimeSessionId ?? "", 300) || undefined,
    runID: redact(payload.runID ?? "", 300) || undefined,
    task: redact(payload.task ?? "", 500) || undefined,
    scope: payload.scope && typeof payload.scope === "object" ? structuredClone(payload.scope) : undefined,
  }
}

export function reduceQuest(input: Quest, event: QuestEvent): Quest {
  const q = structuredClone(input)
  if (event.questID !== q.id || q.appliedEventIDs.includes(event.eventID)) return q
  if (event.lifecycleEpoch !== q.lifecycleEpoch && !["reopen", "archive"].includes(event.type)) return q
  const cursor = q.eventCursors[event.source] ?? -1
  if (event.sourceSequence <= cursor) return q
  const p: any = event.payload
  switch (event.type) {
    case "created": break
    case "patched": {
      const allowed = ["title","objective","priority","reason","nextAction","owner","integrationOwner","scope","relationships","deliverables","acceptanceCriteria","usageInstructions","stages","setbacks","claims","unresolvedWork","completionPolicy","extensions"]
      for (const key of allowed) if (key in p) (q as any)[key] = structuredClone(p[key])
      break
    }
    case "session-planned": {
      if (!q.sessions.some((s) => s.callID === p.callID)) q.sessions.push({ ...sessionIdentity(p), callID: p.callID, taskID: p.taskID, role: redact(p.role ?? p.agentRole ?? "worker", 100), model: redact(p.model ?? "", 150) || undefined, harness: redact(p.harness ?? "", 100) || undefined, branch: redact(p.branch ?? "", 300) || undefined, worktree: redact(p.worktree ?? "", 500) || undefined, state: "planned", evidence: [], deliverables: p.deliverables ?? [], attempt: p.attempt ?? 1, resumedFrom: p.resumedFrom, resumeRoot: p.resumeRoot ?? p.resumedFrom, updatedAt: event.at })
      break
    }
    case "session-claimed": {
      const existing = findSession(q, p)
      if (existing) { for (const [key, value] of Object.entries(sessionIdentity(p))) if (value !== undefined) (existing as any)[key] = value; existing.taskID = p.taskID ?? existing.taskID; existing.sessionID = p.sessionID ?? existing.sessionID; existing.model = redact(p.model ?? existing.model ?? "", 150) || undefined; existing.state = "executing"; existing.updatedAt = event.at }
      else q.sessions.push({ ...sessionIdentity(p), callID: p.callID, taskID: p.taskID, sessionID: p.sessionID, role: redact(p.role ?? p.agentRole ?? "worker", 100), model: redact(p.model ?? "", 150) || undefined, harness: redact(p.harness ?? "", 100) || undefined, branch: redact(p.branch ?? "", 300) || undefined, worktree: redact(p.worktree ?? "", 500) || undefined, state: "executing", evidence: [], deliverables: p.deliverables ?? [], attempt: p.attempt ?? 1, resumedFrom: p.resumedFrom, resumeRoot: p.resumeRoot, updatedAt: event.at })
      break
    }
    case "session-bound": {
      const s = findSession(q, p)
      if (s && (!s.sessionID || s.sessionID === p.sessionID)) { s.sessionID = p.sessionID; s.openCodeSessionId = p.openCodeSessionId ?? p.sessionID ?? s.openCodeSessionId; s.runtimeSessionId = p.runtimeSessionId ?? s.runtimeSessionId; if (s.state === "planned") s.state = "executing"; s.updatedAt = event.at }
      else if (s) { q.unresolvedWork.push(`conflicting exact bind for call ${s.callID}`) }
      break
    }
    case "session-state": {
      const s = findSession(q, p)
      if (!s) q.unresolvedWork.push(`missing exact session link for ${p.callID ?? p.sessionID ?? "unknown"}`)
      else {
        s.state = p.state === "waiting" ? "waiting" : mergeSessionState(s.state, p.state)
        // Identity learned after dispatch: the host names the provider/model that actually answered.
        if (typeof p.providerID === "string" && p.providerID) s.providerID = redact(p.providerID, 100)
        if (typeof p.modelID === "string" && p.modelID) s.modelID = redact(p.modelID, 150)
        if (typeof p.model === "string" && p.model) s.model = redact(p.model, 150)
        if (typeof p.agentRole === "string" && p.agentRole && !s.agentRole) s.agentRole = redact(p.agentRole, 100)
        if (typeof p.task === "string" && p.task && !s.task) s.task = redact(p.task, 500)
        if (p.evidence) s.evidence = bounded([...s.evidence, redact(p.evidence)]); if (p.heartbeatAt) s.lastHeartbeatAt = redact(p.heartbeatAt); if (p.leaseExpiresAt) s.leaseExpiresAt = redact(p.leaseExpiresAt); if (p.commandSummary) s.commandSummary = redact(p.commandSummary); if (p.result) s.result = redact(p.result); if (p.openCodeSessionId) { s.openCodeSessionId = redact(p.openCodeSessionId); s.sessionID = s.openCodeSessionId }; if (p.runtimeSessionId) s.runtimeSessionId = redact(p.runtimeSessionId); if (p.runID) s.runID = redact(p.runID); if (p.dependency) s.dependency = structuredClone(p.dependency); s.updatedAt = event.at }
      break
    }
    case "session-removed": {
      const session = findSession(q, p)
      if (session) q.sessions = q.sessions.filter((candidate) => candidate.callID !== session.callID)
      break
    }
    case "deliverable-state": {
      const d = q.deliverables.find((x) => x.id === p.id); if (d) { d.status = p.status; if (p.evidence) d.evidence = bounded([...(d.evidence ?? []), redact(p.evidence)]) }
      else q.unresolvedWork.push(`unknown deliverable ${p.id}`)
      break
    }
    case "stage-state": {
      const stage = q.stages.find((candidate) => candidate.id === p.stageID)
      const todo = stage?.todos.find((candidate) => candidate.id === p.todoID)
      if (!stage) q.unresolvedWork.push(`unknown stage ${p.stageID}`)
      else if (p.todoID && !todo) q.unresolvedWork.push(`unknown stage todo ${p.stageID}/${p.todoID}`)
      else if (todo) { todo.status = p.status; if (p.evidence) todo.evidence = bounded([...(todo.evidence ?? []), redact(p.evidence)]) }
      else stage.status = p.status
      break
    }
    case "proof-added": {
      const stage = q.stages.find((candidate) => candidate.id === p.stageID)
      if (!stage) { q.unresolvedWork.push(`unknown stage ${p.stageID}`); break }
      const proof = structuredClone(p.proof)
      stage.proofs = [...stage.proofs.filter((candidate) => candidate.id !== proof.id), proof]
      if (proof.kind === "judgment" && proof.verdict === "FAIL") {
        const rewindID = q.stages.some((candidate) => candidate.id === proof.rewindTo) ? proof.rewindTo : stage.id
        const reset = dependentStageIDs(q.stages, rewindID)
        q.setbacks.push({ stageID: stage.id, proofID: proof.id, verdict: "FAIL", reason: redact(proof.reason || "Judgment failed"), attempt: proof.attempt, at: proof.at, rewindTo: proof.rewindTo })
        for (const candidate of q.stages) if (reset.has(candidate.id)) {
          candidate.status = "pending"
          candidate.attempt = Math.max(candidate.attempt + 1, proof.attempt + 1)
          for (const todo of candidate.todos) todo.status = "pending"
        }
        q.reason = `Stage ${stage.id} failed judgment: ${redact(proof.reason || "No reason supplied", 300)}`
        q.nextAction = `Retry ${rewindID}; attempt ${q.stages.find((candidate) => candidate.id === rewindID)?.attempt ?? proof.attempt + 1} includes the setback reason`
      }
      break
    }
    case "evidence-added": {
      if (p.kind === "review") q.evidence.review = p.value
      else if (["commits","tests","builds","artifacts","publish"].includes(p.kind)) (q.evidence as any)[p.kind] = bounded([...(q.evidence as any)[p.kind], p.value])
      break
    }
    case "verify": q.state = "Verifying"; q.reason = "Completion evidence is being checked"; q.nextAction = "Finish verification gates"; break
    case "complete": q.state = "Complete"; q.reason = "Explicitly completed after atomic policy recheck"; q.nextAction = "Archive when no longer active"; break
    case "archive": q.state = "Archived"; q.reason = p.reason ?? "Archived"; q.nextAction = "Reopen to resume work"; break
    case "reopen": q.lifecycleEpoch++; q.abandoned = false; q.state = "Waiting"; q.reason = p.reason ?? "Reopened for additional work"; q.nextAction = p.nextAction ?? "Assign an exact execution session"; break
    case "abandon": q.abandoned = true; q.state = "Archived"; q.reason = p.reason ?? "Abandoned"; q.nextAction = "Reopen only if work should resume"; break
    case "delete": q.state = "Archived"; q.reason = p.reason ?? "Deleted"; q.nextAction = "Deleted records cannot be reopened"; break
    case "supersede": q.relationships.supersededBy = p.by; q.state = "Archived"; q.reason = `Superseded by ${p.by}`; q.nextAction = `Continue in ${p.by}`; break
    case "duplicate": q.relationships.duplicateOf = p.of; q.state = "Archived"; q.reason = `Duplicate of ${p.of}`; q.nextAction = `Continue in ${p.of}`; break
    case "split": q.relationships.subquests = [...new Set([...q.relationships.subquests, ...(p.children ?? [])])]; break
    case "merge": q.relationships.mergedFrom = [...new Set([...q.relationships.mergedFrom, ...(p.from ?? [])])]; break
    case "migration-applied": q.migration = p.migration; break
  }
  if (p.completionKey) {
    const prior = Array.isArray(q.extensions.completionKeys) ? q.extensions.completionKeys.map(String) : []
    q.extensions.completionKeys = bounded([...new Set([...prior, redact(p.completionKey, 500)])], 2000)
    q.notificationCursor = redact(p.completionKey, 500)
  }
  q.eventCursors[event.source] = event.sourceSequence
  q.appliedEventIDs = bounded([...q.appliedEventIDs, event.eventID], 2000)
  q.history = bounded([...q.history, { eventID: event.eventID, at: event.at, type: event.type, lifecycleEpoch: q.lifecycleEpoch, summary: redact(p.summary ?? event.type, 200) }], 1000)
  q.revision++; q.updatedAt = event.at
  return normalizeState(q)
}
