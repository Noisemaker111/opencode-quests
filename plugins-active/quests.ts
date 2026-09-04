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
 *  - binding: an explicitly identified Quest subagent session is attached to its Quest
 *  - gateway: native subagent/task schema is questID + cwd + task; role/runtime are derived
 *  - host events: the model that actually answered and the end of each worker turn
 *  - tools: the `quest` authority
 */
import { define } from "@opencode-ai/plugin/v2/promise"
import { QuestStore } from "../quest/store"
import { QuestTracker } from "../quest/tracker"
import { createQuestAgentAPI } from "../quest/agent-api"
import { compactQuestDetail, compactQuestSummary } from "../quest/context"
import { prepareNativeSubagent, QUEST_SUBAGENT_DESCRIPTION, QUEST_SUBAGENT_INPUT } from "../quest/spawn"
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
  return /^(task|subagent)$/i.test(String(ev.tool ?? ev.name ?? ""))
}

/**
 * Rewrite native subagent/task so callers pass only questID, cwd, and a short
 * task. The original execute still receives derived agent/prompt fields.
 */
export async function installSubagentGateway(ctx: { tool?: { transform?: Function } }) {
  const transform = ctx?.tool?.transform
  if (typeof transform !== "function") return
  await transform((draft: { get: (id: string) => any; update: (id: string, update: (tool: any) => void) => void }) => {
    for (const id of ["subagent", "task"]) {
      if (!draft.get(id)) continue
      draft.update(id, (tool: any) => {
        const original = tool.execute
        if (typeof original !== "function") return
        tool.description = QUEST_SUBAGENT_DESCRIPTION
        tool.input = QUEST_SUBAGENT_INPUT
        tool.execute = async (input: Record<string, unknown>, context: unknown) => original(prepareNativeSubagent(input ?? {}), context)
      })
    }
  })
}

/**
 * Bind a Quest-dispatched OpenCode session to the Quest it belongs to.
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

const HOST_EVENTS = Symbol.for("opencode-config.quests.host-events")

/**
 * Subscribe to the host event stream once per server process. The stream is
 * consumed in the background and must never be awaited from setup(): it only
 * ends when the host shuts down. State lives on globalThis so a plugin reload
 * reuses the running subscription instead of stacking a second one.
 */
export function installQuestEvents(ctx: { event?: { subscribe?: Function } }, quests: QuestTracker) {
  const state = globalThis as { [HOST_EVENTS]?: { installed: boolean; controller: AbortController } }
  if (state[HOST_EVENTS]?.installed) return
  const subscribe = ctx?.event?.subscribe
  if (typeof subscribe !== "function") {
    console.warn("[quests] ctx.event.subscribe unavailable; worker models and turn ends come from the ledger only")
    return
  }
  const controller = new AbortController()
  state[HOST_EVENTS] = { installed: true, controller }
  const handle = (event: unknown) => { try { quests.onHostEvent(event) } catch (error) { console.error("[quests] host event error:", error) } }
  queueMicrotask(async () => {
    try {
      const stream = await subscribe({ signal: controller.signal })
      if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        for await (const event of stream) handle(event)
      } else if (stream && typeof stream.next === "function") {
        for (;;) { const res = await stream.next(); if (res.done) break; handle(res.value) }
      } else {
        console.error("[quests] unsupported host event stream shape")
      }
    } catch (error) {
      console.error("[quests] host event subscription failed:", error)
    } finally {
      if (state[HOST_EVENTS]?.controller === controller) state[HOST_EVENTS] = { installed: false, controller }
    }
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
  "create", "admit", "update", "plan", "step", "claim", "assign", "unassign", "status",
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
    description: [
      "Canonical durable Quest authority.",
      "Every Quest carries steps: create with input.steps (3-8 checkable titles) or add them with action=plan (input.steps).",
      "Report work with action=step (input.stepID or 1-based position, state=working|done|blocked, value=evidence); the board shows done/total.",
      "Never create a Quest from a tool result, subagent notification or checkpoint.",
      "Workers must read mappings before edits. Supports exact-session dependency parking/handoff plus lifecycle controls.",
    ].join(" "),
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
        case "plan": return detail(api.plan(input.id, input.input?.steps ?? input.input?.stages ?? input.patch?.steps, input.input?.mode), input.verbose)
        case "step": return detail(api.step(input.id, input.input?.stepID ?? input.input?.stageID ?? input.input?.step, input.state ?? input.input?.state ?? "done", input.value ?? input.input?.value), input.verbose)
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
        case "evidence": return detail(api.evidence(input.id, input.kind, input.value ?? input.input), input.verbose)
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

export async function installQuestTools(ctx: { tool?: { transform?: Function } }, api = createQuestAgentAPI(process.cwd())) {
  const transform = ctx?.tool?.transform
  if (typeof transform !== "function") return
  await transform((draft: { add: (tool: unknown) => void }) => {
    draft.add(questTool(api))
  })
}

export default define({
  id: "quests",
  async setup(ctx) {
    const quests = new QuestTracker(new QuestStore(process.cwd()))
    const api = createQuestAgentAPI(process.cwd(), ctx.session)
    for (const [name, install] of [
      ["subagent-gateway", () => installSubagentGateway(ctx)],
      ["binding", () => installQuestBinding(ctx, quests)],
      ["host-events", () => installQuestEvents(ctx, quests)],
      ["reconcile-unbound", () => { const settled = quests.reconcileUnbound(); if (settled) console.info(`[quests] marked ${settled} never-bound session(s) missing`) }],
      ["completion-evidence", () => installQuestCompletionEvidence(quests, api)],
      ["tools", () => installQuestTools(ctx, api)],
    ] as const) {
      try { await install() } catch (error) {
        console.error(`[quests] ${name} disabled:`, error)
      }
    }
  },
})
