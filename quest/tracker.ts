import { QuestStore } from "./store"
import { requestFingerprint, redact } from "./privacy"
import type { Quest } from "./types"
import { workerIdentityFromEvent } from "../orchestration/dispatch"
import type { CompletionEvidence } from "../orchestration/orchestration-ledger"

export type QuestDispatch = { questID: string; callID: string; taskID?: string; role: string; deliverables: string[]; model?: string; harness?: string; branch?: string; worktree?: string; agentRole?: string; providerID?: string; modelID?: string; runtime?: "native" | "claude-code"; runID?: string; task?: string; parentID?: string; scope?: Record<string, unknown> }

function taskInput(event: unknown): Record<string, unknown> {
  const ev = (event ?? {}) as Record<string, unknown>
  const input = ev.input ?? ev.args
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
}

function taskCallID(event: unknown): string {
  const ev = (event ?? {}) as Record<string, unknown>
  return String(ev.callID ?? ev.id ?? ev.messageID ?? "")
}

function taskSessionID(output: unknown, event: unknown): string | undefined {
  if (workerIdentityFromEvent(event)?.runtime === "claude-code") return
  const ev = (event ?? {}) as Record<string, unknown>
  const result = (output ?? ev.output ?? {}) as Record<string, any>
  const sessionID = result?.metadata?.openCodeSessionId ?? result?.metadata?.sessionId ?? result?.sessionId ?? result?.data?.sessionID
  return typeof sessionID === "string" && /^ses_[A-Za-z0-9_-]+$/.test(sessionID) ? sessionID : undefined
}

export class QuestTracker {
  readonly enabled = process.env.OPENCODE_QUEST_MODE !== "off"
  constructor(readonly store: QuestStore) {}
  admit(input: { title: string; objective: string; request: unknown; kind?: Quest["kind"]; priority?: Quest["priority"]; scope?: Quest["scope"]; deliverables?: Quest["deliverables"]; acceptanceCriteria?: Quest["acceptanceCriteria"]; owner?: string; integrationOwner?: string; createdAt?: string }): Quest {
    return this.store.admit({ ...input, requestFingerprint: requestFingerprint(input.request) })
  }
  beforeDispatch(input: { questID?: string; callID: string; taskID?: string; description?: string; role?: string; deliverables?: string[]; model?: string; harness?: string; branch?: string; worktree?: string; fingerprint?: string; agentRole?: string; providerID?: string; modelID?: string; runtime?: "native" | "claude-code"; runID?: string; task?: string; parentID?: string; scope?: Record<string, unknown> }): QuestDispatch | undefined {
    if (!this.enabled) return
    const questID = input.questID
    if (!questID) return // infrastructure never invents a binding from similarity
    const q = this.store.read(questID); if (!q) return
    this.store.apply(questID, "session-planned", { ...input, callID: input.callID, taskID: input.taskID, role: redact(input.role ?? input.agentRole ?? "worker", 100), deliverables: (input.deliverables ?? []).slice(0, 50), model: redact(input.model ?? "", 150), harness: redact(input.harness ?? "", 100), branch: input.branch, worktree: input.worktree })
    return { ...input, questID, role: input.role ?? input.agentRole ?? "worker", deliverables: input.deliverables ?? [] }
  }
  bind(questID: string, callID: string, sessionID: string) { if (this.enabled) return this.store.apply(questID, "session-bound", { callID, sessionID }) }
  terminal(questID: string, callID: string, state: "completed" | "failed" | "cancelled", evidence?: string) { if (this.enabled) return this.store.apply(questID, "session-state", { callID, state, evidence }) }
  /** Bind only an explicitly identified Quest. Unbound Tasks are not work-ledger entries. */
  onTaskBefore(event: unknown): QuestDispatch | undefined {
    const ev = (event ?? {}) as Record<string, unknown>
    const input = taskInput(event)
    if (typeof input.questID !== "string") return
    const identity = workerIdentityFromEvent(event)
    return this.beforeDispatch({
      questID: input.questID,
      callID: taskCallID(event),
      taskID: String(input.taskID ?? ev.id ?? ev.callID ?? ""),
      role: typeof input.role === "string" ? input.role : undefined,
      deliverables: Array.isArray(input.deliverables) ? input.deliverables.map(String) : undefined,
      model: typeof input.model === "string" ? input.model : undefined,
      harness: typeof input.harness === "string" ? input.harness : undefined,
      branch: typeof input.branch === "string" ? input.branch : undefined,
      worktree: typeof input.worktree === "string" ? input.worktree : undefined,
      agentRole: identity?.agentRole,
      providerID: identity?.providerID,
      modelID: identity?.modelID,
      runtime: identity?.runtime,
      runID: identity?.runID,
      task: identity?.task,
      parentID: identity?.parentID,
      scope: input.scope && typeof input.scope === "object" ? input.scope as Record<string, unknown> : undefined,
    })
  }
  onCompletion(completion: CompletionEvidence, parkedDeliverySuppressed = false): "recorded" | "duplicate" | "parked" | undefined {
    if (!completion.questID || !this.enabled) return
    const quest = this.store.read(completion.questID)
    if (!quest) return
    const session = quest.sessions.find((candidate) => candidate.callID === completion.callID)
    const keys = Array.isArray(quest.extensions.completionKeys) ? quest.extensions.completionKeys.map(String) : []
    if (keys.includes(completion.idempotencyKey)) return session && ["completed", "failed", "cancelled", "missing", "stale"].includes(session.state) ? "duplicate" : undefined
    if (session?.state === "blocked" && session.dependency && session.dependency.status !== "resumed") {
      if (!parkedDeliverySuppressed) return "parked"
      this.store.apply(completion.questID, "session-state", { callID: completion.callID, state: "blocked", evidence: `Terminal ${completion.state} suppressed while dependency ${session.dependency.sessionID} owns ${session.dependency.file}`, completionKey: completion.idempotencyKey }, "orchestration:completion")
      return "parked"
    }
    const state = completion.state === "completed" ? "completed" : completion.state === "cancelled" ? "cancelled" : completion.state === "missing-result" || completion.state === "stopped" ? "missing" : "failed"
    this.store.apply(completion.questID, "session-state", { callID: completion.callID, state, evidence: completion.summary, result: completion.summary, openCodeSessionId: completion.openCodeSessionId, runtimeSessionId: completion.runtimeSessionId, runID: completion.runID, completionKey: completion.idempotencyKey }, "orchestration:completion")
    return "recorded"
  }
  /** Bind the worker session. Success is not turn-in; only errors mark the call failed. */
  onTaskAfter(event: unknown, output?: unknown) {
    const input = taskInput(event)
    const questID = typeof input.questID === "string" ? input.questID : undefined
    if (!questID) return
    const ev = (event ?? {}) as Record<string, unknown>
    const result = (output ?? ev.output ?? {}) as { error?: unknown }
    const callID = taskCallID(event)
    const sessionID = taskSessionID(output, event)
    if (sessionID) this.bind(questID, callID, sessionID)
    if (result?.error) this.terminal(questID, callID, "failed", "Task result recorded by canonical Quest hook")
    else if (this.enabled) this.store.apply(questID, "session-state", { callID, state: "executing", evidence: "Task result recorded by canonical Quest hook" })
  }
}
