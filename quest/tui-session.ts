import type { QuestStore } from "./store"
import { questErrorText } from "./tui-controller"
import type { Quest } from "./types"

export type StartQuestSessionResult = { ok: true; sessionID: string } | { ok: false; error: string }

function createdSessionID(value: any): string | undefined {
  const id = value?.data?.id ?? value?.data?.sessionID ?? value?.id ?? value?.sessionID
  return typeof id === "string" && id ? id : undefined
}

function createdSessionModel(value: any): string | undefined {
  const row = value?.data ?? value
  const provider = row?.providerID ?? row?.model?.providerID
  const model = row?.modelID ?? row?.model?.modelID ?? row?.model?.id
  return typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : undefined
}

/** Create, bind and prompt a real host session. Every partial failure removes both sides. */
export async function startQuestSession(context: any, store: QuestStore, q: Quest): Promise<StartQuestSessionResult> {
  const session = context?.client?.session
  if (typeof session?.create !== "function" || typeof session?.prompt !== "function") return { ok: false, error: "Session API unavailable" }
  let sessionID: string | undefined
  let callID: string | undefined
  let bound = false
  try {
    const location = context.location ?? context.data?.location?.default?.()
    const created = await session.create({ title: q.title.slice(0, 80), location })
    sessionID = createdSessionID(created)
    if (!sessionID) throw new Error("Session creation returned no session ID")
    callID = `session:${sessionID}`
    const parentID = context.sessionID ?? context.sessionId ?? context.data?.session?.current?.()?.id
    store.apply(q.id, "session-claimed", { callID, sessionID, openCodeSessionId: sessionID, parentID, role: "worker", model: createdSessionModel(created) })
    bound = true
    await session.prompt({ sessionID, text: `Work on Quest ${q.id}: ${q.title}\n\n${q.objective}` })
    context.ui.router.navigate({ type: "session", sessionID })
    return { ok: true, sessionID }
  } catch (error) {
    if (bound && callID) {
      try { store.apply(q.id, "session-removed", { callID }) } catch {}
    }
    if (sessionID) {
      try {
        if (typeof session.delete === "function") await session.delete({ sessionID })
        else if (typeof session.remove === "function") await session.remove({ sessionID })
      } catch {}
    }
    return { ok: false, error: questErrorText(error) }
  }
}
