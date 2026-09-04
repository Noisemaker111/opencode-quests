/**
 * Steps are the unit Jk reads on the board: "2/5" is done steps over total
 * steps. A step is a Quest stage; this file owns how steps are planned from a
 * request, how their ids are minted, and how progress is counted, so the TUI,
 * the agent tool and the dispatch prompt all agree on the same numbers.
 */
import { planFromRequest } from "./request-plan"
import type { Quest, QuestStage, QuestStageStatus } from "./types"

export type StepInput =
  | string
  | { id?: string; title: string; todos?: string[]; needs?: string[]; include?: string[]; status?: QuestStageStatus }

const MAX_STEPS = 30
const MAX_TITLE = 160
const STATUSES = new Set<QuestStageStatus>(["pending", "working", "blocked", "done"])

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

export function stepID(title: string, index: number, taken = new Set<string>()): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").filter(Boolean).slice(0, 4).join("-") || `step-${index + 1}`
  let id = base, n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

/** Build stages from a plain step list. Ids are stable slugs so reports can name them. */
export function stagesFromSteps(steps: StepInput[], quest?: Pick<Quest, "scope">): QuestStage[] {
  const taken = new Set<string>()
  const stages: QuestStage[] = []
  for (const [index, raw] of steps.slice(0, MAX_STEPS).entries()) {
    const step = typeof raw === "string" ? { title: raw } : raw
    const title = clip(String(step?.title ?? ""), MAX_TITLE)
    if (!title) continue
    const id = typeof step.id === "string" && step.id.trim() && !taken.has(step.id.trim()) ? (taken.add(step.id.trim()), step.id.trim()) : stepID(title, index, taken)
    const todos = (Array.isArray(step.todos) ? step.todos : []).slice(0, 12).map((todo, i) => ({ id: `${id}-${i + 1}`, title: clip(String(todo), MAX_TITLE), status: "pending" as const })).filter((todo) => todo.title)
    stages.push({
      id, title, status: STATUSES.has(step.status as QuestStageStatus) ? (step.status as QuestStageStatus) : "pending",
      needs: Array.isArray(step.needs) ? step.needs.map(String).slice(0, 8) : [],
      todos,
      claim: { repos: quest?.scope.repos ?? [], include: Array.isArray(step.include) ? step.include.map(String).slice(0, 20) : [], exclude: [] },
      proofs: [], attempt: 1,
    })
  }
  return stages
}

/** Steps a request states itself. Prose with no actionable sentences yields none. */
export function stepsFromObjective(objective: string): StepInput[] {
  return planFromRequest(objective).deliverables.map((item) => ({ id: item.id, title: item.title }))
}

/** Resolve a step by id, by 1-based position, or by a unique title prefix. */
export function findStep(q: Pick<Quest, "stages">, ref: string | number): QuestStage | undefined {
  const key = String(ref ?? "").trim()
  if (!key) return
  const byID = q.stages.find((stage) => stage.id === key)
  if (byID) return byID
  if (/^\d+$/.test(key)) return q.stages[Number(key) - 1]
  const lower = key.toLowerCase()
  const byTitle = q.stages.filter((stage) => stage.title.toLowerCase().startsWith(lower))
  return byTitle.length === 1 ? byTitle[0] : undefined
}

export type Progress = { done: number; total: number; ratio: number }

/** Board progress: steps first, then legacy deliverables, then acceptance. */
export function questProgress(q: Pick<Quest, "stages" | "deliverables" | "acceptanceCriteria">): Progress {
  const count = (done: number, total: number): Progress => ({ done, total, ratio: total ? done / total : 0 })
  if (q.stages.length) return count(q.stages.filter((stage) => stage.status === "done").length, q.stages.length)
  if (q.deliverables.length) return count(q.deliverables.filter((item) => item.status === "done").length, q.deliverables.length)
  return count(q.acceptanceCriteria.filter((item) => item.satisfied).length, q.acceptanceCriteria.length)
}

/** ○ ◔ ◑ ◕ ● — the small progress circle on the board. */
export function progressGlyph(p: Progress): string {
  if (!p.total || p.done <= 0) return "○"
  if (p.ratio >= 1) return "●"
  if (p.ratio >= 0.75) return "◕"
  if (p.ratio >= 0.5) return "◑"
  return "◔"
}

const TRANSCRIPT = /^\s*(?:<(?:subagent|task|conversation-checkpoint|summary|system-reminder)\b|You are a subagent\b|\[?(?:system|assistant|user)\]?\s*:)/i

/**
 * A pasted tool result, a subagent notification or a conversation checkpoint
 * is not a Quest. The old admission hook created hundreds of these; refuse
 * them at the door so the board only ever shows work Jk asked for.
 */
export function looksLikeTranscript(text: string): boolean {
  const value = String(text ?? "")
  return TRANSCRIPT.test(value) || /<subagent sessionID=|<task id=|<conversation-checkpoint>/i.test(value) || value.length > 400
}
