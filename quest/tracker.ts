import { QuestStore } from "./store"
import { requestFingerprint, redact } from "./privacy"
import type { Quest, QuestSession } from "./types"
import { readAllQuests } from "./index"
import { workerIdentityFromEvent } from "../orchestration/dispatch"
import type { CompletionEvidence } from "../orchestration/orchestration-ledger"

export type QuestDispatch = { questID: string; callID: string; taskID?: string; role: string; deliverables: string[]; model?: string; harness?: string; branch?: string; worktree?: string; agentRole?: string; providerID?: string; modelID?: string; runtime?: "native" | "claude-code"; runID?: string; task?: string; parentID?: string; scope?: Record<string, unknown> }

const terminalSession = (state: string) => ["completed", "failed", "cancelled", "missing", "stale"].includes(state)
const ACTIVE_SESSION = new Set(["planned", "executing", "waiting", "blocked"])
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/

/** Host execution lifecycle events that end a worker turn. */
const HOST_TERMINAL: Record<string, "completed" | "failed" | "cancelled"> = {
  "session.execution.succeeded": "completed",
  "session.execution.failed": "failed",
  "session.execution.cancelled": "cancelled",
}

function taskInput(event: unknown): Record<string, unknown> {
  const ev = (event ?? {}) as Record<string, unknown>
  const input = ev.input ?? ev.args
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
}

function taskCallID(event: unknown): string {
  const ev = (event ?? {}) as Record<string, unknown>
  return String(ev.questCallID ?? ev.callID ?? ev.id ?? ev.messageID ?? "")
}

/**
 * The host's execute.after hook passes one object whose `result` carries the
 * tool output. Older shapes passed the output as a second argument or as
 * `event.output`. All three are searched so a session is never left unbound.
 */
function taskResult(event: unknown, output?: unknown): unknown {
  const ev = (event ?? {}) as Record<string, unknown>
  return output ?? ev.result ?? ev.output ?? {}
}

function taskSessionID(output: unknown, event: unknown): string | undefined {
  const values: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === "string") { values.push(value); return }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(taskResult(event, output))
  const exact = values.find((value) => SESSION_ID.test(value))
  if (exact) return exact
  for (const value of values) {
    const found = value.match(/(?:Session:\s*|sessionID="?)(ses_[A-Za-z0-9_-]+)/)?.[1]
    if (found) return found
  }
}

function toolError(event: unknown, output?: unknown): string | undefined {
  const ev = (event ?? {}) as Record<string, unknown>
  if (ev.status === "error" || ev.error) {
    const error = ev.error as { message?: unknown } | string | undefined
    return typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "Quest dispatch returned an error"
  }
  let found: string | undefined
  const visit = (value: unknown) => {
    if (found || !value || typeof value !== "object") return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const row = value as Record<string, unknown>
    if (row.isError === true || row.error) {
      found = typeof row.error === "string" ? row.error : "Quest dispatch returned an error"
      return
    }
    Object.values(row).forEach(visit)
  }
  visit(taskResult(event, output))
  return found
}

function eventData(event: unknown): { type?: string; data: Record<string, unknown> } {
  const ev = (event ?? {}) as { type?: unknown; data?: unknown; properties?: unknown }
  const data = (ev.data ?? ev.properties ?? {}) as Record<string, unknown>
  return { type: typeof ev.type === "string" ? ev.type : undefined, data }
}

export type SessionRef = { questID: string; session: QuestSession }

export class QuestTracker {
  readonly enabled = process.env.OPENCODE_QUEST_MODE !== "off"
  private index = new Map<string, SessionRef>()
  private indexedAt = 0
  constructor(readonly store: QuestStore) {}
  admit(input: { title: string; objective: string; request: unknown; kind?: Quest["kind"]; priority?: Quest["priority"]; scope?: Quest["scope"]; deliverables?: Quest["deliverables"]; acceptanceCriteria?: Quest["acceptanceCriteria"]; owner?: string; integrationOwner?: string; createdAt?: string }): Quest {
    return this.store.admit({ ...input, requestFingerprint: requestFingerprint(input.request) })
  }
  beforeDispatch(input: { questID?: string; callID: string; taskID?: string; description?: string; role?: string; deliverables?: string[]; model?: string; harness?: string; branch?: string; worktree?: string; fingerprint?: string; agentRole?: string; providerID?: string; modelID?: string; runtime?: "native" | "claude-code"; runID?: string; task?: string; parentID?: string; scope?: Record<string, unknown> }): QuestDispatch | undefined {
    if (!this.enabled) return
    const questID = input.questID
    if (!questID) throw new Error("Quest dispatch requires a Quest binding; create or select a Quest before spawning work")
    const q = this.store.read(questID); if (!q) throw new Error(`Quest dispatch references unknown Quest ${questID}`)
    this.store.apply(questID, "session-planned", { ...input, callID: input.callID, taskID: input.taskID, role: redact(input.role ?? "worker", 100), deliverables: (input.deliverables ?? []).slice(0, 50), model: redact(input.model ?? "", 150), harness: redact(input.harness ?? "", 100), branch: input.branch, worktree: input.worktree })
    this.indexedAt = 0
    return { ...input, questID, role: input.role ?? input.agentRole ?? "worker", deliverables: input.deliverables ?? [] }
  }
  bind(questID: string, callID: string, sessionID: string) {
    if (!this.enabled) return
    this.indexedAt = 0
    return this.store.apply(questID, "session-bound", { callID, sessionID })
  }
  terminal(questID: string, callID: string, state: "completed" | "failed" | "cancelled", evidence?: string) { if (this.enabled) return this.store.apply(questID, "session-state", { callID, state, evidence }) }
  /** Every dispatched unit belongs to a Quest; role is derived from lineage. */
  onTaskBefore(event: unknown): QuestDispatch | undefined {
    const ev = (event ?? {}) as Record<string, unknown>
    const input = taskInput(event)
    if (typeof input.questID !== "string") throw new Error("Quest dispatch requires questID")
    const identity = workerIdentityFromEvent(event)
    const quest = this.store.read(input.questID)
    if (!quest) throw new Error(`Quest dispatch references unknown Quest ${input.questID}`)
    const parentID = String(ev.sessionID ?? identity?.parentID ?? "")
    const continuationID = typeof input.sessionID === "string" ? input.sessionID : undefined
    if (continuationID) {
      const target = quest.sessions.find((session) => session.sessionID === continuationID || session.openCodeSessionId === continuationID)
      if (!target) throw new Error(`Quest dispatch session ${continuationID} is not bound to Quest ${input.questID}`)
      const allowedParent = parentID === quest.owner || parentID === quest.integrationOwner || parentID === target.sessionID || parentID === target.parentID
      if (!allowedParent) throw new Error(`Quest dispatch continuation ${continuationID} violates Quest lineage`)
      ev.questCallID = target.callID
      if (identity) identity.agentRole = "worker"
      this.store.apply(input.questID, "session-state", { callID: target.callID, state: "executing", evidence: "continued through Quest dispatch" }, "quest:dispatch-continuation")
      return { questID: input.questID, callID: target.callID, taskID: target.taskID, role: target.role, deliverables: target.deliverables, model: target.model, agentRole: "worker", providerID: target.providerID, modelID: target.modelID, runtime: target.runtime, runID: identity?.runID, task: identity?.task, parentID }
    }
    const parentIsWorker = quest.sessions.some((session) => (session.sessionID === parentID || session.openCodeSessionId === parentID) && session.role === "worker" && !terminalSession(session.state))
    if (parentIsWorker) throw new Error(`Quest ${input.questID} workers cannot spawn; the Quest giver dispatches work`)
    if (identity) identity.agentRole = "worker"
    if (!quest.integrationOwner && parentID) this.store.apply(input.questID, "patched", { integrationOwner: parentID }, "quest:giver-bind")
    return this.beforeDispatch({
      questID: input.questID,
      callID: taskCallID(event),
      taskID: String(input.taskID ?? ev.id ?? ev.callID ?? ""),
      role: "worker",
      deliverables: undefined,
      model: typeof input.model === "string" ? input.model : undefined,
      harness: typeof input.harness === "string" ? input.harness : undefined,
      branch: typeof input.branch === "string" ? input.branch : undefined,
      worktree: typeof input.worktree === "string" ? input.worktree : undefined,
      agentRole: identity?.agentRole,
      providerID: identity?.providerID,
      modelID: identity?.modelID,
      runtime: identity?.runtime,
      runID: identity?.runID,
      task: identity?.task ?? (typeof input.task === "string" ? input.task : undefined),
      parentID: identity?.parentID ?? parentID,
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
    this.store.apply(completion.questID, "session-state", { callID: completion.callID, state, evidence: completion.summary, result: completion.summary, openCodeSessionId: completion.openCodeSessionId, runtimeSessionId: completion.runtimeSessionId, runID: completion.runID, providerID: completion.providerID, modelID: completion.modelID, completionKey: completion.idempotencyKey }, "orchestration:completion")
    return "recorded"
  }
  /** Bind the OpenCode session returned by native subagent dispatch. Success is not turn-in. */
  onTaskAfter(event: unknown, output?: unknown) {
    const input = taskInput(event)
    const questID = typeof input.questID === "string" ? input.questID : undefined
    if (!questID) throw new Error("Quest dispatch completion is missing its Quest binding")
    const callID = taskCallID(event)
    const sessionID = taskSessionID(output, event)
    if (sessionID) this.bind(questID, callID, sessionID)
    const error = toolError(event, output)
    if (error) this.terminal(questID, callID, "failed", error)
    else if (this.enabled) this.store.apply(questID, "session-state", { callID, state: "executing", evidence: "subagent session started from canonical Quest" })
  }

  /** Active Quest sessions by exact host session id, rebuilt at most every few seconds. */
  sessionIndex(maxAgeMs = 5_000): Map<string, SessionRef> {
    if (Date.now() - this.indexedAt < maxAgeMs) return this.index
    const next = new Map<string, SessionRef>()
    for (const { quest } of readAllQuests(this.store.projectRoot)) {
      if (!quest || quest.state === "Archived") continue
      for (const session of quest.sessions) {
        for (const id of [session.openCodeSessionId, session.sessionID]) if (id && SESSION_ID.test(id) && !next.has(id)) next.set(id, { questID: quest.id, session })
      }
    }
    this.index = next
    this.indexedAt = Date.now()
    return next
  }

  /**
   * A planned or executing session that never received a host session id
   * cannot finish: nothing will ever report on it. After a grace period it is
   * marked missing so the Quest stops showing RUNNING forever.
   */
  reconcileUnbound(maxAgeMs = 30 * 60_000, now = Date.now()): number {
    if (!this.enabled) return 0
    let settled = 0
    for (const { quest } of readAllQuests(this.store.projectRoot)) {
      if (!quest || quest.state === "Archived") continue
      for (const session of quest.sessions) {
        if (!["planned", "executing"].includes(session.state) || session.sessionID || session.openCodeSessionId) continue
        if (now - Date.parse(session.updatedAt) < maxAgeMs) continue
        try {
          this.store.apply(quest.id, "session-state", { callID: session.callID, state: "missing", evidence: "Never bound to a host session; marked missing by reconciliation" }, "quest:reconcile")
          settled++
        } catch (error) { console.error(`[quests] reconcile ${quest.id}/${session.callID} failed:`, error) }
      }
    }
    if (settled) this.indexedAt = 0
    return settled
  }

  /**
   * Host events are the truth about a worker: the assistant message names the
   * provider/model that actually answered, and the execution lifecycle says
   * when the turn ended. Neither passes through the subagent tool result.
   */
  onHostEvent(event: unknown): "identified" | "settled" | undefined {
    if (!this.enabled) return
    const { type, data } = eventData(event)
    if (!type) return
    if (type === "message.updated") {
      const info = (data.info ?? {}) as Record<string, unknown>
      if (info.role !== "assistant" || typeof info.sessionID !== "string" || typeof info.modelID !== "string") return
      const ref = this.sessionIndex().get(info.sessionID)
      if (!ref) return
      const providerID = typeof info.providerID === "string" ? info.providerID : undefined
      const modelID = info.modelID
      if (ref.session.providerID === providerID && ref.session.modelID === modelID) return
      const model = providerID ? `${providerID}/${modelID}` : modelID
      this.store.apply(ref.questID, "session-state", { callID: ref.session.callID, state: ref.session.state, providerID, modelID, model, agentRole: typeof info.agent === "string" ? info.agent : undefined }, "host:message")
      this.indexedAt = 0
      return "identified"
    }
    const terminal = HOST_TERMINAL[type]
    if (terminal && typeof data.sessionID === "string") {
      const ref = this.sessionIndex().get(data.sessionID)
      if (!ref || !ACTIVE_SESSION.has(ref.session.state)) return
      if (ref.session.state === "blocked" && ref.session.dependency && ref.session.dependency.status !== "resumed") return
      this.store.apply(ref.questID, "session-state", { callID: ref.session.callID, state: terminal, evidence: `Host reported execution ${type.split(".").pop()}` }, "host:execution")
      this.indexedAt = 0
      return "settled"
    }
  }
}
