import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { QuestStore } from "../quest/store"
test("journal replay is idempotent after a write interruption", () => { const root = mkdtempSync(join(tmpdir(), "quest-crash-")), store = new QuestStore(root), id = "01j00000000000000000000000"; store.create({ id, title: "Crash", objective: "replay" }); store.apply(id, "patched", { reason: "journaled" }); const first = store.read(id)!; const second = store.read(id)!; expect(second.revision).toBe(first.revision); expect(second.reason).toBe(first.reason); rmSync(root, { recursive: true, force: true }) })
