import type { Quest } from "./types"
import { latestSessionAttempts } from "./session-lineage"
import { stageMissing } from "./stages"

export function completionMissing(q: Quest, lookup?: (id: string) => Quest | undefined): string[] {
  const out: string[] = []
  const p = q.completionPolicy
  if (q.deliverables.some((d) => d.status !== "done")) out.push("deliverables")
  if (q.acceptanceCriteria.some((a) => !a.satisfied)) out.push("acceptance criteria")
  for (const stage of q.stages) out.push(...stageMissing(stage))
  if (!q.usageInstructions.some((line) => line.trim())) out.push("usage instructions")
  if (q.unresolvedWork.length) out.push("unresolved work")
  if (latestSessionAttempts(q.sessions).some((s) => s.state !== "completed")) out.push("missing or non-completed sessions")
  if (p.requireSessions && !q.sessions.length) out.push("session evidence")
  if (p.requireCommits && !q.evidence.commits.some((x) => x.verified)) out.push("verified commits")
  if (p.requireTests && !q.evidence.tests.some((x) => x.result === "passed")) out.push("passing tests")
  if (p.requireReview && q.evidence.review?.verdict !== "CLEAN") out.push("CLEAN review")
  if (p.requireArtifacts && !q.evidence.artifacts.some((x) => x.verified)) out.push("verified artifact")
  if (p.requirePublish && !q.evidence.publish.some((x) => x.result === "succeeded" || x.result === "credentials-limitation")) out.push("publish evidence")
  if (p.requireWorktreeEquality && q.evidence.commits.some((x) => !x.verified || !x.worktreeHead || x.worktreeHead !== x.hash)) out.push("commit/worktree equality")
  for (const id of q.relationships.dependencies) {
    const dependency = lookup?.(id)
    if (!dependency || !["Complete", "Archived"].includes(dependency.state)) out.push(`dependency ${id}`)
  }
  if (q.claims.some((x) => x.state === "active")) out.push("active file claims")
  return [...new Set(out)].sort()
}

export function gatesReady(q: Quest, lookup?: (id: string) => Quest | undefined): boolean { return completionMissing(q, lookup).length === 0 }
