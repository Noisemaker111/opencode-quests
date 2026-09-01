import type { Quest } from "./types"

export const QUEST_LANES = ["attention", "assigned", "unassigned", "verifying", "ready", "archived"] as const
export type QuestLane = typeof QUEST_LANES[number]

export const LANE_LABEL: Record<QuestLane, string> = {
  attention: "Needs attention",
  assigned: "Assigned",
  unassigned: "Unassigned",
  verifying: "Verifying",
  ready: "Ready to turn in",
  archived: "Archived",
}

/** Active board order: blockers, in-progress, incoming to-do, verification, user turn-in. */
export const ACTIVE_LANE_ORDER: QuestLane[] = ["attention", "assigned", "unassigned", "verifying", "ready"]

export function isAssigned(q: Quest): boolean {
  return Boolean(q.owner || q.integrationOwner || q.sessions.some((s) => ["planned", "executing", "waiting", "blocked"].includes(s.state)))
}

/** Unassigned Waiting quests are the to-do lane. Assigned/executing quests are active work. */
export function questLane(q: Quest): QuestLane {
  if (q.state === "Archived") return "archived"
  if (q.state === "Ready to complete" || q.state === "Complete") return "ready"
  if (q.state === "Needs attention") return "attention"
  if (q.state === "Verifying") return "verifying"
  if (q.state === "Working" || isAssigned(q)) return "assigned"
  return "unassigned"
}

/** Incoming requests are prepended: newest createdAt, then newest ULID, first. */
export function sortNewestFirst(quests: Quest[]): Quest[] {
  return [...quests].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

export function questBoard(quests: Quest[]): Record<QuestLane, Quest[]> {
  const lanes: Record<QuestLane, Quest[]> = { attention: [], assigned: [], unassigned: [], verifying: [], ready: [], archived: [] }
  for (const q of sortNewestFirst(quests)) lanes[questLane(q)].push(q)
  return lanes
}

export type BoardRow =
  | { kind: "header"; lane: QuestLane; label: string }
  | { kind: "quest"; lane: QuestLane; quest: Quest }

export function boardRows(quests: Quest[], options: { filter?: string; includeArchived?: boolean } = {}): BoardRow[] {
  const lanes = questBoard(quests)
  const order = options.includeArchived ? [...ACTIVE_LANE_ORDER, "archived" as const] : ACTIVE_LANE_ORDER
  const rows: BoardRow[] = []
  const filter = options.filter?.toLowerCase()
  for (const lane of order) {
    const items = lanes[lane].filter((q) => !filter || `${q.title} ${q.state} ${q.reason}`.toLowerCase().includes(filter))
    if (!items.length) continue
    rows.push({ kind: "header", lane, label: LANE_LABEL[lane] })
    for (const quest of items) rows.push({ kind: "quest", lane, quest })
  }
  return rows
}

export function summarizeQuest(q: Quest) {
  const stage = q.stages.findIndex((item) => item.status !== "done")
  return {
    id: q.id,
    title: q.title.slice(0, 100),
    state: q.state,
    lane: questLane(q),
    stage: q.stages.length ? `${stage < 0 ? q.stages.length : stage + 1}/${q.stages.length}` : undefined,
    nextAction: q.nextAction.slice(0, 140),
    running: q.executingCount || undefined,
  }
}

export function summarizeBoard(quests: Quest[], lane?: string, includeArchived = false, limit = 12) {
  const lanes = questBoard(quests)
  if (lane && lane in lanes) {
    const rows = lanes[lane as QuestLane]
    return { lane, quests: rows.slice(0, limit).map(summarizeQuest), truncated: Math.max(0, rows.length - limit) }
  }
  const visible = includeArchived ? QUEST_LANES : QUEST_LANES.filter((key) => key !== "archived")
  let remaining = limit
  let lanesLeft = visible.length
  const board = Object.fromEntries(visible.map((key) => {
    const rows = lanes[key].slice(0, Math.ceil(remaining / lanesLeft))
    remaining -= rows.length
    lanesLeft--
    return [key, rows.map(summarizeQuest)]
  }))
  const visibleCount = visible.reduce((total, key) => total + lanes[key].length, 0)
  return {
    counts: Object.fromEntries(QUEST_LANES.map((key) => [key, lanes[key].length])),
    board,
    truncated: Math.max(0, visibleCount - limit),
  }
}
