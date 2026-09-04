/**
 * Guards the class of bug that shipped a Quest chrome nobody could see.
 *
 * The chrome mounted nowhere for two different reasons, a version apart:
 * first `context.ui.slot(...)` was called against a host that only had
 * `context.slots.register({ slots: { app_bottom } })`, and then — once the
 * host became beta-18684 — `slots.register` was called against a host that
 * only has `ui.slot`. Both threw out of setup() and took the rest of it down.
 *
 * So the slot map is read out of the installed host binary rather than out of
 * the @opencode-ai/plugin SDK in node_modules: that package is 1.18.5 and
 * still describes the underscored TuiHostSlotMap, while the host actually
 * running is 0.0.0-beta-18684 and renders dotted paths. The binary is the
 * authority because the binary is what loads the plugin.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

/**
 * The beta-18684 slot map, extracted from the host binary (see the evidence
 * test below, which re-derives this list and fails if the host changes it).
 *
 * `app` is always mounted and renders nothing of its own — it is where a
 * plugin mounts a component that registers keymap layers, because
 * keymap.layer() needs a render context. `prompt.footer` is the composer
 * footer; `sidebar.content` and `sidebar.footer` are the in-session panel
 * beside Subagents and receive `{ sessionID }`.
 */
const RUNTIME_SLOTS = [
  "app",
  "home.footer",
  "prompt.footer",
  "prompt.footer.file",
  "prompt.footer.status",
  "session.composer.top",
  "sidebar.content",
  "sidebar.footer",
]

const HOST_EXE = join(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe")

/** Comments explain the old broken APIs by name; only real code is scanned. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/**
 * The TUI plugins the host actually loads, per plugin-set.json. A file left in
 * tui-active/ that no entrypoint list names is not loaded and is not chrome.
 */
function tuiPluginSources(): Array<{ name: string; src: string }> {
  const set = JSON.parse(readFileSync(join(root, "plugin-set.json"), "utf8"))
  return (set.tuiEntrypoints as string[]).map((rel) => ({
    name: rel.split("/").pop()!,
    src: stripComments(readFileSync(join(root, rel), "utf8")),
  }))
}

/** Slot targets a source claims via ui.slot({ <placement>: "name", ... }). */
function claimedSlots(src: string): string[] {
  const claims = [...src.matchAll(/\bui\.slot\s*\(\s*\{([\s\S]*?)\brender\s*:/g)]
  return claims.flatMap(([, head]) =>
    [...head.matchAll(/\b(prepend|append|before|after|replace)\s*:\s*["']([^"']+)["']/g)].map((m) => m[2]),
  )
}

const SOURCES = tuiPluginSources()
const LOADED = SOURCES.filter(({ src }) => /\bui\.slot\s*\(/.test(src))

test.skipIf(!existsSync(HOST_EXE))("the running host still renders exactly these slots", async () => {
  // Never assert on a frame a test drew itself: this reads the host that
  // actually loads the plugins and re-derives the map from its own renderer
  // calls, `_(to, { path: "<slot>" })`.
  const text = new TextDecoder("latin1").decode(await Bun.file(HOST_EXE).bytes())
  const found = [...text.matchAll(/_\([A-Za-z$_][\w$]*,\{path:"([a-z][a-z.]*)"/g)].map((m) => m[1])
  expect([...new Set(found)].sort()).toEqual([...RUNTIME_SLOTS].sort())
})

test("the host has ui.slot and no longer has the underscored slots.register", async () => {
  if (!existsSync(HOST_EXE)) return
  const text = new TextDecoder("latin1").decode(await Bun.file(HOST_EXE).bytes())
  expect(text.includes("Slot claim requires exactly one placement key")).toBe(true)
  expect(text.includes("app_bottom")).toBe(false)
  expect(text.includes("sidebar_content")).toBe(false)
})

test("every TUI plugin mounts its chrome through ui.slot", () => {
  expect(LOADED.length).toBe(SOURCES.length)
  for (const { name, src } of SOURCES) {
    expect(`${name}: ${/\bslots\.register\s*\(/.test(src)}`).toBe(`${name}: false`)
  }
})

test("every claimed slot is a real host slot", () => {
  expect(LOADED.length).toBeGreaterThan(0)
  for (const { name, src } of LOADED) {
    const slots = claimedSlots(src)
    expect(`${name}: ${slots.length > 0}`).toBe(`${name}: true`)
    for (const slot of slots) {
      expect(`${name}/${slot}: ${RUNTIME_SLOTS.includes(slot)}`).toBe(`${name}/${slot}: true`)
    }
  }
})

test("no TUI plugin uses an underscored slot name — the host map is dotted", () => {
  for (const { name, src } of SOURCES) {
    const underscored = [...src.matchAll(/["'](app|home|sidebar|session)_(bottom|footer|logo|prompt|content|title)["']/g)]
    expect(`${name}: ${underscored.map((m) => m[0]).join(",")}`).toBe(`${name}: `)
  }
})

test("quests mount the count on the composer footer AND in the session sidebar", () => {
  const quests = SOURCES.find((s) => s.name === "quests.tsx")!
  const slots = claimedSlots(quests.src)
  // The footer alone is the bug the user reported: a count with no way to see
  // the Quests from inside the session where the work happens.
  expect(slots).toContain("prompt.footer")
  expect(slots).toContain("sidebar.content")
  // The command layer needs a render context, so it mounts too.
  expect(slots).toContain("app")
})

test("usage mounts its context footer on the composer footer", () => {
  const usage = SOURCES.find((s) => s.name === "usage.tsx")!
  expect(claimedSlots(usage.src)).toContain("prompt.footer")
})

test("no test fabricates a TUI frame and asserts on its own drawing", () => {
  // The deleted quests-screenshot test hand-drew a session frame and a Quest
  // count into a string, rendered it to a PNG, and asserted on the string it
  // had just written. That is not evidence.
  const self = "tui-slots.test.ts"
  for (const file of readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts") && f !== self)) {
    const src = readFileSync(join(root, "test", file), "utf8")
    const fabricates = /function sessionFrame\b/.test(src) || /Subagent \(\d+ of \d+\)/.test(src)
    expect(`${file}: ${fabricates}`).toBe(`${file}: false`)
  }
})
