import { homedir } from "node:os"
import { compactQuestDispatch } from "./context"
import { QuestStore } from "./store"
import type { Quest } from "./types"
import { aliasModel, splitProviderModel } from "../orchestration/dispatch"

export const QUEST_SUBAGENT_DESCRIPTION = [
  "Start Quest work as a normal worker subagent.",
  "Pass only questID, cwd, and a short task; add model only when Jk names one or the step needs it.",
  "model accepts claude (Claude Code Opus), sonnet, haiku, grok, codex, or an explicit provider/model.",
  "The Quest giver dispatches implementers; do not select an agent.",
  "Do not paste Quest fields or routing policy into the task.",
].join(" ")

export const QUEST_SUBAGENT_INPUT = {
  type: "object" as const,
  properties: {
    questID: { type: "string", description: "Canonical Quest ID. The worker prompt is derived from this Quest." },
    task: { type: "string", description: "Short task for the worker. Do not paste Quest fields." },
    cwd: { type: "string", description: "Working directory for the subagent (defaults to parent cwd)" },
    sessionID: { type: "string", description: "Existing Quest-bound session to continue" },
    model: { type: "string", description: "Optional: claude | sonnet | haiku | grok | codex, or provider/model. Omit for the default worker." },
  },
  required: ["questID", "task"],
  additionalProperties: false,
}

/** Hidden worker agents in opencode.jsonc, each pinned to one provider/model. */
export const WORKER_AGENTS: Record<string, string> = {
  "claude-code/opus": "claude",
  "claude-code/claude": "claude",
  "claude-code/sonnet": "claude-sonnet",
  "claude-code/haiku": "claude-haiku",
  "cliproxyapi/grok-4.6": "grok",
  "codex/default": "codex",
}

export type NativeSubagentInput = {
  agent: string
  description: string
  prompt: string
  sessionID?: string
  background: true
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * The host subagent tool has no model field: a worker's model is its agent's
 * model. A model hint therefore selects the hidden agent pinned to it, and an
 * unpinned provider/model falls back to the default `build` worker.
 */
export function agentForModel(model: unknown): string {
  const raw = text(model)
  if (!raw) return "build"
  const selected = splitProviderModel(raw) ?? aliasModel(raw)
  if (!selected) throw new Error(`Quest dispatch model must be claude, sonnet, haiku, grok, codex, or provider/model (got ${raw})`)
  return WORKER_AGENTS[`${selected.providerID}/${selected.modelID}`] ?? "build"
}

export function questLookupRoots(cwd?: string): string[] {
  return [...new Set([text(cwd), process.cwd(), homedir()].filter(Boolean))]
}

export function readCanonicalQuest(questID: string, cwd?: string): Quest {
  for (const root of questLookupRoots(cwd)) {
    const quest = new QuestStore(root).read(questID)
    if (quest) return quest
  }
  throw new Error(`Quest dispatch references unknown Quest ${questID}`)
}

/** Every dispatched unit is an implementer. The Quest giver is the only coordinator. */
export function derivedSpawnAgent(quest: Quest, input: Record<string, unknown>): string {
  const continuationID = text(input.sessionID)
  if (continuationID) {
    const target = quest.sessions.find((session) => session.sessionID === continuationID || session.openCodeSessionId === continuationID)
    if (!target) throw new Error(`Quest dispatch session ${continuationID} is not bound to Quest ${quest.id}`)
  }
  return agentForModel(input.model)
}

/** Rewrite caller fields into native subagent input. Canonical Quest supplies prompt context. */
export function toNativeSubagentInput(input: Record<string, unknown>, quest: Quest): NativeSubagentInput {
  const task = text(input.task) || text(input.prompt) || text(input.description)
  if (!task) throw new Error("Quest dispatch requires task")
  const sessionID = text(input.sessionID) || undefined
  return {
    agent: derivedSpawnAgent(quest, input),
    description: task.slice(0, 80),
    prompt: compactQuestDispatch(quest, task),
    sessionID,
    background: true,
  }
}

export function prepareNativeSubagent(input: Record<string, unknown>): NativeSubagentInput {
  const questID = text(input.questID)
  if (!questID) throw new Error("Quest dispatch requires questID")
  return toNativeSubagentInput(input, readCanonicalQuest(questID, text(input.cwd) || undefined))
}
