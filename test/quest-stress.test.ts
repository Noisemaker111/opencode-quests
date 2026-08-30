import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { QuestStore } from "../quest/store"
const stressTest = process.env.QUEST_STRESS === "1" ? test : test.skip
stressTest("20 isolated quests remain distinct under eight deterministic writer lanes", () => { const root = mkdtempSync(join(tmpdir(), "quest-stress-")); const store = new QuestStore(root); const seed = "01j00000000000000000000000"; const ids = Array.from({ length: 20 }, (_, i) => seed.slice(0, -2) + String(i).padStart(2, "0")); ids.forEach((id) => store.create({ id, title: id, objective: "stress" })); for (let lane = 0; lane < 8; lane++) for (let i = lane; i < ids.length; i += 8) { const q = store.read(ids[i])!; store.apply(q.id, "patched", { reason: `lane-${lane}` }) }; expect(new Set(ids.map((id) => store.read(id)?.id)).size).toBe(20); expect(ids.every((id) => store.read(id)?.title === id)).toBe(true); rmSync(root, { recursive: true, force: true }) })
