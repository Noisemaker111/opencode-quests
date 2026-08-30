import { QuestStore } from "./store"
import { QuestTracker } from "./tracker"

/** Server-side adapter: every method is best effort so emergency Task dispatch survives Quest I/O failures. */
export function createQuestTracker(projectRoot: string): QuestTracker {
  return new QuestTracker(new QuestStore(projectRoot))
}
export function safeQuest<T>(action: () => T, fallback?: T): T | undefined { try { return action() } catch (error) { console.error(`[quest] degraded receipt: ${String(error).slice(0, 300)}`); return fallback } }
