import { readAllQuests } from "./index"
import { QuestStore } from "./store"
import { requestFingerprint } from "./privacy"
import { inferQuestKind } from "./schema"
import { questLane, summarizeBoard } from "./board"
import { runQuestCommand } from "./commands"
import { acquireLock } from "./locking"
import { claimMatches } from "./claims"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { appendLedger } from "../orchestration/orchestration-ledger"
import type { Quest } from "./types"

export type QuestQuery = { search?: string; state?: string; sessionID?: string; taskID?: string; lane?: string }

/** Canonical agent-facing orchestration authority. All mutations journal through QuestStore. */
export function createQuestAgentAPI(projectRoot = process.cwd(), sessionApi?: { synthetic?: Function }, ledgerFile?: string) {
  const store = new QuestStore(projectRoot)
  const list = (query: QuestQuery = {}) => readAllQuests(projectRoot).flatMap(({ quest }) => quest ? [quest] : []).filter((q) => {
    const text = `${q.id} ${q.title} ${q.objective} ${q.reason} ${q.nextAction}`.toLowerCase()
    return (!query.search || text.includes(query.search.toLowerCase())) && (!query.state || q.state === query.state) && (!query.sessionID || q.sessions.some((s) => s.sessionID === query.sessionID || s.openCodeSessionId === query.sessionID || s.runtimeSessionId === query.sessionID)) && (!query.taskID || q.sessions.some((s) => s.taskID === query.taskID)) && (!query.lane || questLane(q) === query.lane)
  })
  const get = (id: string) => store.read(id)
  const admit = (input: Omit<Partial<Quest>, "id"> & Pick<Quest, "title" | "objective"> & { requestFingerprint?: string }) =>
    store.admit({ ...input, kind: input.kind ?? inferQuestKind(input.title, input.objective), requestFingerprint: input.requestFingerprint ?? requestFingerprint({ title: input.title, objective: input.objective }) })
  const create = (input: Partial<Quest> & Pick<Quest, "title" | "objective"> & { id?: string }) =>
    input.id ? store.create(input as Partial<Quest> & Pick<Quest, "id" | "title" | "objective">) : admit(input)
  const update = (id: string, patch: Record<string, unknown>) => store.apply(id, "patched", patch)
  const claim = (id: string, input: { callID: string; taskID: string; sessionID?: string; parentID?: string; role: string; model?: string; scope?: Record<string, unknown>; deliverables?: string[]; resumeRoot?: string }) => {
    const current = store.read(id)
    if (!current) throw new Error(`Quest not found: ${id}`)
    return store.apply(id, "session-claimed", input)
  }
  const assign = (id: string, input: Parameters<typeof claim>[1]) => claim(id, input)
  const unassign = (id: string, callID: string) => store.apply(id, "session-state", { callID, state: "waiting", evidence: "assignment released explicitly" })
  const accept = (id: string, args: Record<string, unknown> = {}) => runQuestCommand(store, "accept", id, args)
  const execute = (id: string, args: Record<string, unknown> = {}) => runQuestCommand(store, "execute", id, args)
  const startSession = (id: string, args: Record<string, unknown>) => runQuestCommand(store, "start-session", id, args)
  const complete = (id: string) => runQuestCommand(store, "complete", id)
  const turnIn = (id: string, reason?: string) => runQuestCommand(store, "turn-in", id, { reason })
  const abandon = (id: string, reason?: string) => runQuestCommand(store, "abandon", id, { reason })
  const archive = (id: string, reason?: string) => runQuestCommand(store, "archive", id, { reason })
  const reopen = (id: string, reason?: string) => runQuestCommand(store, "reopen", id, { reason })
  const deleteQuest = (id: string, confirmed = false) => store.delete(id, confirmed)
  const view = (id: string) => runQuestCommand(store, "view", id)
  const status = (id: string) => get(id)
  const history = (id: string) => get(id)?.history ?? []
  const evidence = (id: string, kind: "commits" | "tests" | "builds" | "artifacts" | "publish" | "review", value: unknown) => {
    if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
      try { value = JSON.parse(value) } catch { /* Preserve human-readable evidence when it is not JSON. */ }
    }
    return store.apply(id, "evidence-added", { kind, value })
  }
  const progress = (id: string, callID: string, value: string, state: "executing" | "waiting" | "blocked" | "completed" | "failed" | "cancelled" = "executing", commandSummary?: string) => store.apply(id, "session-state", { callID, state, evidence: value, heartbeatAt: new Date().toISOString(), commandSummary })
  const heartbeat = (id: string, callID: string, leaseMs = 60_000) => store.apply(id, "session-state", { callID, state: "executing", heartbeatAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() })
  const park = (id: string, input: { callID: string; blockerSessionID: string; file: string; reason: string }) => {
    const current = store.read(id)
    const session = current?.sessions.find((candidate) => candidate.callID === input.callID)
    if (!current || !session) throw new Error(`Quest session not found: ${id}/${input.callID}`)
    const sessionID = session.openCodeSessionId ?? session.sessionID
    if (!sessionID || !(session.parentID ?? session.parentSessionID) || !session.model || !session.scope) throw new Error("Parking requires the exact sessionID, parentID, model, and scope to be persisted")
    const blockerOwnsFile = list().some((quest) => quest.claims.some((claim) => claim.state === "active" && claim.sessionID === input.blockerSessionID && claimMatches(claim, resolve(claim.repo, input.file))))
    if (!blockerOwnsFile) throw new Error(`No active claim for ${input.blockerSessionID} owns ${input.file}`)
    const resumeKey = `${id}:${input.callID}:${input.blockerSessionID}:${input.file}`
    if (session.dependency?.resumeKey === resumeKey && session.dependency.status !== "failed") return current
    const dependency = { sessionID: input.blockerSessionID, file: input.file, reason: input.reason, status: "blocked" as const, resumeKey, resumeCount: session.dependency?.resumeCount ?? 0 }
    store.apply(id, "session-state", { callID: input.callID, state: "blocked", dependency, heartbeatAt: new Date().toISOString(), evidence: `Blocked by ${input.blockerSessionID} owning ${input.file}: ${input.reason}` }, "quest:dependency")
    return store.apply(id, "patched", { reason: `Session ${sessionID} is blocked by ${input.blockerSessionID}`, nextAction: `Wait for handoff of ${input.file}, then resume ${sessionID}` }, "quest:dependency")
  }
  const handoff = async (input: { sessionID: string; reason?: string }) => {
    for (const quest of list()) {
      const claims = quest.claims.map((claim) => claim.sessionID === input.sessionID && claim.state === "active" ? { ...claim, state: "released" as const } : claim)
      if (claims.some((claim, index) => claim !== quest.claims[index])) store.apply(quest.id, "patched", { claims }, "quest:handoff")
    }
    const resumed: Quest[] = []
    for (const quest of list()) for (const candidate of quest.sessions) {
      if (candidate.state !== "blocked" || candidate.dependency?.sessionID !== input.sessionID || candidate.dependency.status === "resumed") continue
      const lock = acquireLock(store.runtime, `resume-${quest.id}-${candidate.callID}`)
      let session = candidate
      let resumeCallID = ""
      let resumeParentID = ""
      let resumeMessageID = ""
      try {
        const fresh = store.read(quest.id)?.sessions.find((entry) => entry.callID === candidate.callID)
        if (!fresh || fresh.state !== "blocked" || fresh.dependency?.sessionID !== input.sessionID || fresh.dependency.status === "resumed") continue
        session = fresh
        const token = createHash("sha256").update(fresh.dependency.resumeKey).digest("hex").slice(0, 24)
        resumeMessageID = `msg_${token}`
        const allSessions = store.read(quest.id)?.sessions ?? []
        const priorAttempts = allSessions.filter((entry) => entry.resumedFrom === fresh.callID)
        const inFlight = fresh.dependency.status === "resuming" ? priorAttempts.findLast((entry) => !["completed", "failed", "cancelled", "missing", "stale"].includes(entry.state)) : undefined
        if (inFlight && fresh.dependency.resumeLeaseExpiresAt && Date.parse(fresh.dependency.resumeLeaseExpiresAt) > Date.now()) continue
        resumeCallID = inFlight?.callID ?? `resume-${token}${priorAttempts.length ? `-${priorAttempts.length + 1}` : ""}`
        const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
        const dependency = { ...fresh.dependency, status: "resuming" as const, resumeLeaseExpiresAt: leaseExpiresAt }
        store.apply(quest.id, "session-state", { callID: fresh.callID, state: "blocked", dependency, evidence: `Dependency handoff received from ${input.sessionID}` }, "quest:handoff")
        const exactSessionID = fresh.openCodeSessionId ?? fresh.sessionID!
        resumeParentID = fresh.parentID ?? fresh.parentSessionID!
        if (!inFlight) {
          appendLedger({ kind: "spawn", parentID: resumeParentID, callID: resumeCallID, childID: exactSessionID, agent: fresh.agentRole, agentRole: fresh.agentRole, providerID: fresh.providerID, modelID: fresh.modelID, runtime: fresh.runtime ?? "native", runID: resumeCallID, task: fresh.task, questID: quest.id, role: fresh.role, deliverables: fresh.deliverables }, ledgerFile)
          appendLedger({ kind: "bound", parentID: resumeParentID, callID: resumeCallID, childID: exactSessionID, runtime: fresh.runtime ?? "native", openCodeSessionId: fresh.runtime === "claude-code" ? undefined : exactSessionID, runtimeSessionId: fresh.runtime === "claude-code" ? exactSessionID : undefined, runID: resumeCallID }, ledgerFile)
          store.apply(quest.id, "session-claimed", { callID: resumeCallID, taskID: fresh.taskID, sessionID: exactSessionID, openCodeSessionId: fresh.openCodeSessionId, runtimeSessionId: fresh.runtimeSessionId, parentID: fresh.parentID ?? fresh.parentSessionID, role: fresh.role, model: fresh.model, scope: fresh.scope, harness: fresh.harness, agentRole: fresh.agentRole, providerID: fresh.providerID, modelID: fresh.modelID, runtime: fresh.runtime, runID: resumeCallID, task: fresh.task, deliverables: fresh.deliverables, resumedFrom: fresh.callID, resumeRoot: fresh.resumeRoot ?? fresh.callID, attempt: fresh.attempt + priorAttempts.length + 1 }, "quest:handoff")
        }
      } finally { lock.release() }
      const exactSessionID = session.openCodeSessionId ?? session.sessionID
      try {
        if (!exactSessionID || typeof sessionApi?.synthetic !== "function") throw new Error("session.synthetic unavailable for exact-session resume")
        await sessionApi.synthetic({
          sessionID: exactSessionID,
          messageID: resumeMessageID,
          text: `Dependency released by ${input.sessionID}: ${session.dependency!.file}. Resume the same scoped task now. ${input.reason ?? "Continue from the parked state."}`,
          metadata: { kind: "quest.dependency-resume", idempotencyKey: resumeMessageID, questID: quest.id, callID: resumeCallID, resumedFrom: session.callID, model: session.model, scope: session.scope, dependency: session.dependency },
        })
        const dependency = { ...session.dependency!, status: "resumed" as const, resumedAt: new Date().toISOString(), resumeCount: session.dependency!.resumeCount + 1, resumeLeaseExpiresAt: undefined }
        store.apply(quest.id, "session-state", { callID: session.callID, state: "waiting", dependency, evidence: `Continued as ${resumeCallID} in exact session ${exactSessionID}` }, "quest:handoff")
        store.apply(quest.id, "session-state", { callID: resumeCallID, state: "executing", heartbeatAt: new Date().toISOString(), evidence: `Automatically resumed exact session ${exactSessionID}` }, "quest:handoff")
        resumed.push(store.apply(quest.id, "patched", { reason: `Dependency ${input.sessionID} handed off`, nextAction: `Continue integration in ${exactSessionID}` }, "quest:handoff"))
      } catch (error) {
        const dependency = { ...session.dependency!, status: "failed" as const, resumeLeaseExpiresAt: undefined }
        if (resumeCallID && resumeParentID && exactSessionID) appendLedger({ kind: "terminal", parentID: resumeParentID, callID: resumeCallID, childID: exactSessionID, state: "failed" }, ledgerFile)
        if (resumeCallID) try { store.apply(quest.id, "session-state", { callID: resumeCallID, state: "failed", evidence: `Automatic continuation delivery failed: ${String(error)}` }, "quest:handoff") } catch {}
        store.apply(quest.id, "session-state", { callID: session.callID, state: "blocked", dependency, evidence: `Automatic resume failed: ${String(error)}` }, "quest:handoff")
      }
    }
    return resumed
  }
  const mappings = () => {
    const quests = list()
    return {
      sessions: quests.flatMap((q) => q.sessions.map((s) => ({ questID: q.id, callID: s.callID, taskID: s.taskID, sessionID: s.openCodeSessionId ?? s.sessionID, model: s.model, scope: s.scope, state: s.state, heartbeat: s.lastHeartbeatAt, dependency: s.dependency, nextAction: q.nextAction }))),
      activeClaims: quests.flatMap((q) => q.claims.filter((claim) => claim.state === "active").map((claim) => ({ questID: q.id, ...claim }))),
    }
  }
  const board = (query: QuestQuery = {}) => summarizeBoard(list(query), query.lane)
  return { store, list, search: list, get, view, create, admit, prepend: admit, update, claim, assign, unassign, accept, execute, startSession, complete, turnIn, abandon, archive, reopen, delete: deleteQuest, status, history, evidence, progress, heartbeat, park, handoff, mappings, board }
}
