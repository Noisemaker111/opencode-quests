function sessionID(value: any): string | undefined {
  const id = value?.data?.id ?? value?.id ?? value?.data?.sessionID ?? value?.sessionID
  return typeof id === "string" && /^ses_[A-Za-z0-9_-]+$/.test(id) ? id : undefined
}

export function responseText(value: any): string {
  const data = value?.data ?? value
  const parts = data?.parts ?? data?.message?.parts ?? []
  const text = Array.isArray(parts) ? parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : ""
  return text || (typeof data?.text === "string" ? data.text : "")
}

/** One clean intake turn. Canonical state lives in Quests, not chat history. */
export async function talkToQuestGiver(context: any, root: string, text: string, quest?: { id: string }): Promise<string> {
  const api = context?.client?.session
  if (typeof api?.create !== "function" || typeof api?.prompt !== "function") throw new Error("Quest Giver session API unavailable")
  const location = context.location ?? context.data?.location?.default?.() ?? { directory: root }
  const created = await api.create({ title: "Quest Giver turn", agent: "quest-giver", location })
  const id = sessionID(created)
  if (!id) throw new Error("Quest Giver session creation returned no session ID")
  try {
    const prompt = quest ? `Quest ${quest.id}\n${text}` : text
    return responseText(await api.prompt({ sessionID: id, text: prompt }))
  } finally {
    try {
      if (typeof api.delete === "function") await api.delete({ sessionID: id })
      else if (typeof api.remove === "function") await api.remove({ sessionID: id })
    } catch { /* Intake already completed; cleanup is best effort. */ }
  }
}
