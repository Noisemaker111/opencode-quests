import { nativeSessionNavigation, type WorkerIdentity } from "../orchestration/dispatch"
import type { QuestSession } from "./types"

function identityFromSession(session: QuestSession): WorkerIdentity | undefined {
  const model = session.model?.split("/")
  const providerID = session.providerID ?? (model && model.length > 1 ? model.shift() : undefined)
  const modelID = session.modelID ?? (model && model.length ? model.join("/") : undefined)
  const runtime = session.runtime ?? (session.harness ? "claude-code" : "native")
  const parentID = session.parentID ?? session.parentSessionID
  const runID = session.runID ?? session.callID
  const task = session.task ?? session.taskDescription ?? session.taskID ?? "Task"
  if (!providerID || !modelID || !parentID) return
  return {
    agentRole: runtime === "claude-code" ? "claude-code" : session.agentRole === "explore" ? "explore" : "build",
    providerID,
    modelID,
    runtime,
    openCodeSessionId: session.openCodeSessionId ?? session.openCodeSessionID ?? (runtime === "native" ? session.sessionID : undefined),
    runtimeSessionId: session.runtimeSessionId ?? session.harnessSessionID,
    parentID,
    runID,
    task,
  }
}

export async function navigateQuestSession(context: any, session: QuestSession): Promise<boolean> {
  const identity = identityFromSession(session)
  if (!identity) return false
  const get = context?.client?.session?.get
  if (typeof get !== "function") return false
  let result: any
  try { result = await get({ sessionID: identity.openCodeSessionId }) } catch { return false }
  const row = result?.data ?? result
  const route = nativeSessionNavigation(identity, { id: row?.id, parentID: row?.parentID ?? row?.parent_id })
  if (!route || typeof context?.ui?.router?.navigate !== "function") return false
  context.ui.router.navigate(route)
  return true
}
