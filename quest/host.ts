import type { Quest } from "./types"
import { renderFrame, type TuiRoute } from "./tui-model"
import { createQuestAgentAPI } from "./agent-api"
import { runQuestCommand } from "./commands"
export function registerQuestHost(host: any, getQuests: () => Quest[]): () => void {
  let route: TuiRoute = { type: "overview" }
  const render = () => renderFrame(getQuests(), route, Number(host?.width ?? 80))
  const safe = (fn: () => unknown) => { try { return fn() } catch { return undefined } }
  const api = createQuestAgentAPI(process.cwd())
  const registrations: Array<() => unknown> = [
    () => host?.slot?.("home-right", () => render()),
    () => host?.command?.("/quests", () => { route = { type: "overview" }; return render() }),
    () => host?.palette?.({ id: "quests", title: "Quests", run: () => render() }),
    () => host?.command?.("quest.view", (id: string) => { route = { type: "detail", questID: id }; return render() }),
    () => host?.command?.("quest.accept", (id: string) => runQuestCommand(api.store, "accept", id)),
    () => host?.command?.("quest.execute", (id: string) => runQuestCommand(api.store, "execute", id)),
    () => host?.command?.("quest.complete", (id: string) => runQuestCommand(api.store, "complete", id)),
    () => host?.command?.("quest.turn-in", (id: string) => runQuestCommand(api.store, "turn-in", id)),
    () => host?.command?.("quest.status", (id: string) => api.status(id)),
    () => host?.command?.("quest.mappings", () => api.mappings()),
    () => host?.command?.("quest.history", (id: string) => api.history(id)),
    () => host?.command?.("quest.resume", (id: string) => { const session = api.get(id)?.sessions.find((s) => s.state === "blocked" || s.state === "missing"); if (!session?.sessionID) throw new Error("no exact blocked or missing-result session is available to resume"); return api.progress(id, session.callID, `Resume exact session ${session.sessionID}; replacement forbidden`, "executing") }),
    () => host?.command?.("quest.cancel", (id: string) => { const session = api.get(id)?.sessions.find((s) => s.state === "executing" || s.state === "blocked"); if (!session) throw new Error("no exact controlled session is available to cancel"); return api.progress(id, session.callID, `Cancel exact session ${session.sessionID ?? "unbound"} after explicit confirmation`, "cancelled") }),
    () => host?.command?.("quest.open-session", (id: string) => api.get(id)?.sessions),
  ]
  const disposers = registrations.map(safe).filter((x): x is () => void => typeof x === "function")
  return () => disposers.reverse().forEach((dispose) => safe(dispose))
}
