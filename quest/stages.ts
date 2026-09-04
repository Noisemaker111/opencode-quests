import type { Quest, QuestProof, QuestStage } from "./types"

const VISIBLE_PATH = /(^|\/)(tui-active|ui|views?|components?|screens?|styles?|assets?)(\/|$)|\.(?:tsx|jsx|css|scss|png|svg)$/i

export function requiredProofKinds(stage: Pick<QuestStage, "claim">): QuestProof["kind"][] {
  const visible = stage.claim.include.some((path) => VISIBLE_PATH.test(path.replaceAll("\\", "/")))
  return visible ? ["command", "run", "judgment"] : ["command"]
}

export function proofPassed(proof: QuestProof): boolean {
  if (proof.kind === "judgment") return proof.verdict === "PASS" && Boolean(proof.reason?.trim())
  if (proof.kind === "run") return proof.result === "passed" && proof.verified === true && Boolean(proof.artifact?.trim())
  return proof.result === "passed" && Boolean(proof.command?.trim())
}

export function stageMissing(stage: QuestStage): string[] {
  const missing: string[] = []
  if ((stage.todos ?? []).some((todo) => todo.status !== "done")) missing.push(`stage ${stage.id} todos`)
  if (stage.status !== "done") missing.push(`stage ${stage.id}`)
  for (const kind of requiredProofKinds({ claim: stage.claim ?? { repos: [], include: [], exclude: [] } })) {
    if (!(stage.proofs ?? []).some((proof) => proof.kind === kind && proof.attempt === stage.attempt && proofPassed(proof))) missing.push(`stage ${stage.id} ${kind} proof`)
  }
  return missing
}

export function dependentStageIDs(stages: QuestStage[], rootID: string): Set<string> {
  const reset = new Set([rootID])
  let changed = true
  while (changed) {
    changed = false
    for (const stage of stages) if (!reset.has(stage.id) && stage.needs.some((id) => reset.has(id))) { reset.add(stage.id); changed = true }
  }
  return reset
}

export function runnableStages(q: Pick<Quest, "stages">): QuestStage[] {
  const done = new Set(q.stages.filter((stage) => stage.status === "done").map((stage) => stage.id))
  return q.stages.filter((stage) => stage.status === "pending" && stage.needs.every((id) => done.has(id)))
}
