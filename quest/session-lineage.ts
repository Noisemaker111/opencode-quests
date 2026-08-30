import type { QuestSession } from "./types"

/** Historical attempts stay visible, but only the newest attempt in a resume lineage is live work. */
export function latestSessionAttempts(sessions: QuestSession[]): QuestSession[] {
  const latest = new Map<string, QuestSession>()
  for (const session of sessions) {
    const root = session.resumeRoot ?? session.resumedFrom ?? session.callID
    const prior = latest.get(root)
    if (!prior || session.attempt > prior.attempt || (session.attempt === prior.attempt && session.updatedAt > prior.updatedAt)) latest.set(root, session)
  }
  return [...latest.values()]
}
