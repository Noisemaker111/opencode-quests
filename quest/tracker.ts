import { QuestStore } from "./store"
import { requestFingerprint, redact } from "./privacy"
import type { Quest } from "./types"
import { workerIdentityFromEvent } from "../orchestration/dispatch"
import type { CompletionEvidence } from "../orchestration/orchestration-ledger"

export type QuestDispatch = { questID: string; callID: string; taskID?: string; role: string; deliverables: string[]; model?: string; harness?: string; branch?: string; worktree?: string; agentRole?: string; providerID?: string; modelID?: string; runtime?: "native" | "claude-code"; runID?: string; task?: string; parentID?: string; scope?: Record<string, unknown> }

const terminalSession = (state: string) => ["completed", "failed", "cancelled", "missing", "stale"].includes(state)

function taskInput(event: unknown): Record<string, unknown> {
  const ev = (event ?? {}) as Record<string, unknown>
  const input = ev.input ?? ev.args
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
}

function taskCallID(event: unknown): string {
  const ev = (event ?? {}) as Record<string, unknown>
  return String(ev.questCallID ?? ev.callID ?? ev.id ?? ev.messageID ?? "")
}

function taskSessionID(output: unknown, event: unknown): string | undefined {
  const ev = (event ?? {}) as Record<string, unknown>
  const values: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === "string") { values.push(value); return }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(output ?? ev.output)
  const exact = values.find((value) => /^ses_[A-Za-z0-9_-]+$/.test(value))
  if (exact) return exact
  for (const value of values) {
    const found = value.match(/(?:Session:\s*)?(ses_[A-Za-z0-9_-]+)/)?.[1]
    if (found) return found
  }
}

function toolError(output: unknown): string | undefined {
  let found: string | undefined
  const visit = (value: unknown) => {
    if (found || !value || typeof value !== "object") return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const row = value as Record<string, unknown>
    if (row.isError === true || row.error) {
      found = typeof row.error === "string" ? row.error : "mcp_agent returned an error"
      return
    }
    Object.values(row).forEach(visit)
  }
  visit(output)
  return found
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
    if (!questID) throw new Error("mcp_agent requires a Quest binding; create or select a Quest before spawning work")
    const q = this.store.read(questID); if (!q) throw new Error(`mcp_agent references unknown Quest ${questID}`)
    const integrationDispatch = input.role === "integration-owner" || input.agentRole === "orchestrator"
    if (integrationDispatch && q.sessions.some((session) => (session.role === "integration-owner" || session.agentRole === "orchestrator") && !terminalSession(session.state))) {
      throw new Error(`Quest ${questID} already has an active orchestrator`)
    }
    this.store.apply(questID, "session-planned", { ...input, callID: input.callID, taskID: input.taskID, role: redact(input.role ?? input.agentRole ?? "worker", 100), deliverables: (input.deliverables ?? []).slice(0, 50), model: redact(input.model ?? "", 150), harness: redact(input.harness ?? "", 100), branch: input.branch, worktree: input.worktree })
    return { ...input, questID, role: input.role ?? input.agentRole ?? "worker", deliverables: input.deliverables ?? [] }
  }
  bind(questID: string, callID: string, sessionID: string) { if (this.enabled) return this.store.apply(questID, "session-bound", { callID, sessionID }) }
  terminal(questID: string, callID: string, state: "completed" | "failed" | "cancelled", evidence?: string) { if (this.enabled) return this.store.apply(questID, "session-state", { callID, state, evidence }) }
  /** Every MCP-spawned unit belongs to a Quest; role is derived from lineage. */
  onTaskBefore(event: unknown): QuestDispatch | undefined {
    const ev = (event ?? {}) as Record<string, unknown>
    const input = taskInput(event)
    if (typeof input.questID !== "string") throw new Error("mcp_agent requires questID")
    const identity = workerIdentityFromEvent(event)
    const quest = this.store.read(input.questID)
    if (!quest) throw new Error(`mcp_agent references unknown Quest ${input.questID}`)
    const parentID = String(ev.sessionID ?? identity?.parentID ?? "")
    const continuationID = typeof input.sessionID === "string" ? input.sessionID : undefined
    if (continuationID) {
      const target = quest.sessions.find((session) => session.sessionID === continuationID || session.openCodeSessionId === continuationID)
      if (!target) throw new Error(`mcp_agent session ${continuationID} is not bound to Quest ${input.questID}`)
      const targetIsOwner = target.role === "integration-owner" || target.agentRole === "orchestrator"
      const allowedParent = targetIsOwner
        ? parentID === quest.owner || parentID === target.sessionID
        : parentID === quest.integrationOwner
      if (!allowedParent) throw new Error(`mcp_agent continuation ${continuationID} violates Quest lineage`)
      ev.questCallID = target.callID
      if (identity) identity.agentRole = targetIsOwner ? "orchestrator" : "worker"
      this.store.apply(input.questID, "session-state", { callID: target.callID, state: "executing", evidence: "continued through mcp_agent" }, "quest:mcp-continuation")
      return { questID: input.questID, callID: target.callID, taskID: target.taskID, role: target.role, deliverables: target.deliverables, model: target.model, agentRole: target.agentRole, providerID: target.providerID, modelID: target.modelID, runtime: target.runtime, runID: identity?.runID, task: identity?.task, parentID }
    }
    const activeOwner = quest.sessions.find((session) => (session.role === "integration-owner" || session.agentRole === "orchestrator") && !terminalSession(session.state))
    const ownerID = quest.integrationOwner ?? activeOwner?.sessionID
    let role: "integration-owner" | "worker"
    if (!ownerID && !activeOwner) role = "integration-owner"
    else if (parentID && ownerID === parentID) role = "worker"
    else throw new Error(`Quest ${input.questID} already has a durable orchestrator; continue ${ownerID ?? activeOwner?.callID} instead`)
    if (identity) identity.agentRole = role === "integration-owner" ? "orchestrator" : "worker"
    return this.beforeDispatch({
      questID: input.questID,
      callID: taskCallID(event),
      taskID: String(input.taskID ?? ev.id ?? ev.callID ?? ""),
      role,
      deliverables: role === "integration-owner" ? quest.deliverables.map((item) => item.id) : undefined,
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
    this.store.apply(completion.questID, "session-state", { callID: completion.callID, state, evidence: completion.summary, result: completion.summary, openCodeSessionId: completion.openCodeSessionId, runtimeSessionId: completion.runtimeSessionId, runID: completion.runID, completionKey: completion.idempotencyKey }, "orchestration:completion")
    return "recorded"
  }
  /** Bind the OpenCode session returned by mcp_agent. Success is not turn-in. */
  onTaskAfter(event: unknown, output?: unknown) {
    const input = taskInput(event)
    const questID = typeof input.questID === "string" ? input.questID : undefined
    if (!questID) throw new Error("mcp_agent completion is missing its Quest binding")
    const ev = (event ?? {}) as Record<string, unknown>
    const result = output ?? ev.output ?? {}
    const callID = taskCallID(event)
    const sessionID = taskSessionID(output, event)
    if (sessionID) {
      this.bind(questID, callID, sessionID)
      const quest = this.store.read(questID)
      const linked = quest?.sessions.find((session) => session.callID === callID)
      if (linked?.role === "integration-owner" || linked?.agentRole === "orchestrator") this.store.apply(questID, "patched", { integrationOwner: sessionID }, "quest:orchestrator-bind")
    }
    const error = toolError(result)
    if (error) this.terminal(questID, callID, "failed", error)
    else if (this.enabled) this.store.apply(questID, "session-state", { callID, state: "executing", evidence: "mcp_agent session started through the OpenCode server" })
  }
}
