/**
 * The quests server plugin: explicit durable work, tracked to completion.
 *
 * Quest state and verbs live in quest/ — this file is the wiring that attaches
 * them to the host, and it is the only plugin allowed to reach into quest/.
 *
 * It was previously spread across two other plugins: admission and the `quest`
 * tool lived in favorite-router, and the Task binding lived in orchestration.
 * Neither could ship without dragging quests along, and quests could not ship
 * at all. What it owns now:
 *  - binding: an explicitly identified spawned Task is attached to its Quest
 *  - tools: the `quest` authority, plus the deprecated running_tasks shim
 */
import { define } from "@opencode-ai/plugin/v2/promise"
import { QuestStore } from "../quest/store"
import { QuestTracker } from "../quest/tracker"
import { createQuestAgentAPI } from "../quest/agent-api"
import { registerCompletionEvidenceHandler, suppressCompletionDelivery } from "../orchestration/orchestration-ledger"

/** Attach a hook without letting one bad registration disable the rest. */
async function safeToolHook(hook: Function, name: string, fn: Function, essential = false) {
  try {
    await hook(name, async (...args: unknown[]) => {
      try { return await fn(...args) } catch (error) {
        if (essential) throw error
        console.error(`[quests] ${name} hook error:`, error)
      }
    })
  } catch (error) {
    console.error(`[quests] could not register ${name}:`, error)
    if (essential) throw error
  }
}

const isSpawn = (event: unknown) => {
  const ev = (event ?? {}) as Record<string, unknown>
  return /^(task|subagent)$/i.test(String(ev.tool ?? ev.name ?? ""))
}

/**
 * Bind a spawned Task to the Quest it belongs to.
 *
 * This rides the same execute hooks the orchestration ledger uses — both care
 * about a Task starting and finishing — but the two answer different
 * questions, so they live in different plugins.
 */
export async function installQuestBinding(
  ctx: { tool?: { hook?: Function } },
  quests = new QuestTracker(new QuestStore(process.cwd())),
) {
  const hook = ctx?.tool?.hook
  if (typeof hook !== "function") return
  await safeToolHook(hook, "execute.before", (event: unknown) => {
    if (isSpawn(event)) quests.onTaskBefore(event)
  }, true)
  await safeToolHook(hook, "execute.after", (event: unknown, output?: unknown) => {
    if (isSpawn(event)) quests.onTaskAfter(event, output)
  })
}

export function installQuestCompletionEvidence(quests: QuestTracker, api = createQuestAgentAPI(process.cwd())) {
  return registerCompletionEvidenceHandler((completion) => {
    const disposition = quests.onCompletion(completion)
    if (disposition === "parked" && suppressCompletionDelivery(completion)) quests.onCompletion(completion, true)
    const blockerSessionID = completion.openCodeSessionId ?? completion.runtimeSessionId
    if (blockerSessionID && (disposition === "recorded" || disposition === "duplicate")) void api.handoff({ sessionID: blockerSessionID, reason: "Blocking worker reached terminal handoff" }).catch((error) => console.error("[quests] automatic dependency handoff failed:", error))
  })
}

const QUEST_ACTIONS = [
  "view", "accept", "execute", "complete", "turn-in", "list", "search", "get",
  "create", "admit", "update", "claim", "assign", "unassign", "status",
  "history", "evidence", "progress", "mappings", "board", "start-session",
  "park", "handoff", "heartbeat", "abandon", "archive", "reopen", "delete",
] as const

/** The canonical Quest authority, exposed as one tool with a verb. */
export function questTool(api = createQuestAgentAPI(process.cwd())) {
  const json = (value: unknown) => ({ content: JSON.stringify(value ?? null, null, 2) })
  return {
    name: "quest",
    description:
      "Canonical durable Quest authority. Workers must read mappings before edits. Supports exact-session dependency parking/handoff plus lifecycle controls.",
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...QUEST_ACTIONS] },
        id: { type: "string" }, query: { type: "object" }, input: { type: "object" },
        patch: { type: "object" }, callID: { type: "string" }, value: { type: "string" },
        kind: { type: "string" }, reason: { type: "string" }, state: { type: "string" }, confirmed: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      switch (input?.action) {
        case "list": case "search": return json(api.list(input.query ?? input))
        case "board": return json(api.board(input.query ?? input))
        case "get": case "status": return json(api.get(input.id))
        case "view": return json(api.view(input.id))
        case "create": case "admit": return json(api.create(input.input))
        case "update": return json(api.update(input.id, input.patch ?? {}))
        case "accept": return json(api.accept(input.id, input.input ?? {}))
        case "execute": return json(api.execute(input.id, input.input ?? {}))
        case "start-session": return json(api.startSession(input.id, input.input ?? {}))
        case "complete": return json(api.complete(input.id))
        case "turn-in": return json(api.turnIn(input.id, input.reason))
        case "abandon": return json(api.abandon(input.id, input.reason))
        case "archive": return json(api.archive(input.id, input.reason))
        case "reopen": return json(api.reopen(input.id, input.reason))
        case "delete": return json(api.delete(input.id, input.confirmed === true))
        case "claim": case "assign": return json(api.claim(input.id, input.input))
        case "unassign": return json(api.unassign(input.id, input.callID))
        case "history": return json(api.history(input.id))
        case "evidence": return json(api.evidence(input.id, input.kind, input.value))
        case "progress": return json(api.progress(input.id, input.callID, input.value, input.state))
        case "heartbeat": return json(api.heartbeat(input.id, input.callID))
        case "park": return json(api.park(input.id, input.input))
        case "handoff": return json(await api.handoff(input.input ?? { sessionID: input.id, reason: input.reason }))
        case "mappings": return json(api.mappings())
        default: return { content: `Unsupported Quest action: ${String(input?.action)}` }
      }
    },
  }
}

/** Kept so older sessions calling running_tasks get an answer, not an error. */
export function runningTasksShim(api = createQuestAgentAPI(process.cwd())) {
  return {
    name: "running_tasks",
    description:
      "Deprecated compatibility shim. Reads canonical Quest assignments only, performs no writes, and never refreshes activity. Use quest(action=mappings|list|status).",
    input: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async () => ({
      content: `DEPRECATED: canonical Quest authority; no activity refresh or writes.\n${JSON.stringify(api.mappings(), null, 2)}`,
    }),
  }
}

export async function installQuestTools(ctx: { tool?: { transform?: Function } }, api = createQuestAgentAPI(process.cwd())) {
  const transform = ctx?.tool?.transform
  if (typeof transform !== "function") return
  await transform((draft: { add: (tool: unknown) => void }) => {
    draft.add(questTool(api))
    draft.add(runningTasksShim(api))
  })
}

export default define({
  id: "quests",
  async setup(ctx) {
    const quests = new QuestTracker(new QuestStore(process.cwd()))
    const api = createQuestAgentAPI(process.cwd(), ctx.session)
    for (const [name, install] of [
      ["binding", () => installQuestBinding(ctx, quests)],
      ["completion-evidence", () => installQuestCompletionEvidence(quests, api)],
      ["tools", () => installQuestTools(ctx, api)],
    ] as const) {
      try { await install() } catch (error) {
        console.error(`[quests] ${name} disabled:`, error)
      }
    }
  },
})
