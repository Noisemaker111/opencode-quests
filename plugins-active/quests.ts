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
 *  - binding: an explicitly identified mcp_agent session is attached to its Quest
 *  - tools: the `quest` authority, plus the deprecated running_tasks shim
 */
import { define } from "@opencode-ai/plugin/v2/promise"
import { QuestStore } from "../quest/store"
import { QuestTracker } from "../quest/tracker"
import { createQuestAgentAPI } from "../quest/agent-api"
import { compactQuestDetail, compactQuestSummary } from "../quest/context"
import type { Quest } from "../quest/types"
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
  return /^mcp_agent$/i.test(String(ev.tool ?? ev.name ?? ""))
}

/**
 * Bind an mcp_agent-created OpenCode session to the Quest it belongs to.
 *
 * This rides the same execute hooks the orchestration ledger uses — both care
 * about a model worker starting and finishing — but the two answer different
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
  "stage", "proof", "park", "handoff", "heartbeat", "abandon", "archive", "reopen", "delete",
] as const

/** The canonical Quest authority, exposed as one tool with a verb. */
export function questTool(api = createQuestAgentAPI(process.cwd())) {
  const json = (value: unknown) => ({ content: JSON.stringify(value ?? null) })
  const isQuest = (value: unknown): value is Quest => Boolean(value && typeof value === "object" && "schema" in value && "id" in value)
  const detail = (value: unknown, verbose?: boolean) => json(verbose || !isQuest(value) ? value : compactQuestDetail(value))
  const summaries = (query: any = {}) => {
    const offset = Math.max(0, Number.isSafeInteger(query.offset) ? query.offset : 0)
    const limit = Math.max(1, Math.min(Number.isSafeInteger(query.limit) ? query.limit : 25, 100))
    const rows = api.list(query).filter((quest) => query.includeArchived === true || quest.state !== "Archived")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    const items = rows.slice(offset, offset + limit).map(compactQuestSummary)
    const nextOffset = offset + items.length < rows.length ? offset + items.length : undefined
    return { items, truncated: nextOffset !== undefined, nextOffset }
  }
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
        kind: { type: "string" }, reason: { type: "string" }, state: { type: "string" }, confirmed: { type: "boolean" }, verbose: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (input: any) => {
      switch (input?.action) {
        case "list": case "search": return json(input.verbose ? api.list(input.query ?? input) : summaries(input.query ?? input))
        case "board": return json(api.board(input.query ?? input))
        case "get": case "status": return detail(api.get(input.id), input.verbose)
        case "view": return detail(api.view(input.id), input.verbose)
        case "create": case "admit": return detail(api.create(input.input), input.verbose)
        case "update": return detail(api.update(input.id, input.patch ?? {}), input.verbose)
        case "accept": return detail(api.accept(input.id, input.input ?? {}), input.verbose)
        case "execute": return detail(api.execute(input.id, input.input ?? {}), input.verbose)
        case "start-session": return detail(api.startSession(input.id, input.input ?? {}), input.verbose)
        case "complete": return detail(api.complete(input.id), input.verbose)
        case "turn-in": return detail(api.turnIn(input.id, input.reason), input.verbose)
        case "abandon": return detail(api.abandon(input.id, input.reason), input.verbose)
        case "archive": return detail(api.archive(input.id, input.reason), input.verbose)
        case "reopen": return detail(api.reopen(input.id, input.reason), input.verbose)
        case "delete": return json(api.delete(input.id, input.confirmed === true))
        case "claim": case "assign": return detail(api.claim(input.id, input.input), input.verbose)
        case "unassign": return detail(api.unassign(input.id, input.callID), input.verbose)
        case "history": { const history = api.history(input.id); return json(input.verbose ? history : history.slice(-10)) }
        case "evidence": return detail(api.evidence(input.id, input.kind, input.value), input.verbose)
        case "progress": return detail(api.progress(input.id, input.callID, input.value, input.state), input.verbose)
        case "heartbeat": return detail(api.heartbeat(input.id, input.callID), input.verbose)
        case "stage": return detail(api.stage(input.id, input.input?.stageID, input.state, input.input?.todoID, input.value), input.verbose)
        case "proof": return detail(api.proof(input.id, input.input?.stageID, input.input?.proof ?? input.input ?? {}), input.verbose)
        case "park": return detail(api.park(input.id, input.input), input.verbose)
        case "handoff": return json(await api.handoff(input.input ?? { sessionID: input.id, reason: input.reason }))
        case "mappings": return json(api.mappings(input.query ?? { questID: input.id, verbose: input.verbose }))
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
