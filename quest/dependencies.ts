import type { Quest } from "./types"

export function dependencyCycles(quests: Quest[]): string[][] {
  const byID = new Map(quests.map((q) => [q.id, q])), visiting = new Set<string>(), visited = new Set<string>(), cycles: string[][] = []
  function visit(id: string, path: string[]) {
    if (visiting.has(id)) { cycles.push([...path.slice(path.indexOf(id)), id]); return }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dep of byID.get(id)?.relationships.dependencies ?? []) visit(dep, [...path, id])
    visiting.delete(id); visited.add(id)
  }
  for (const q of quests) visit(q.id, [])
  return cycles
}
export function assertNoDependencyCycles(quests: Quest[]): void { const cycles = dependencyCycles(quests); if (cycles.length) throw new Error(`dependency cycle: ${cycles[0].join(" -> ")}`) }
