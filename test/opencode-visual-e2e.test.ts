import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { frameToSvg, standaloneArgs } from "../scripts/opencode-visual-e2e"

const root = join(import.meta.dir, "..")

test("visual harness can only launch an explicitly isolated standalone host", () => {
  const project = join(root, ".visual-e2e", "runs", "visual-e2e-usage-1", "project")
  expect(standaloneArgs(project)).toEqual(["--standalone", "--log-level", "error", project])
  expect(() => standaloneArgs(join(root, "project"))).toThrow(/isolated project path required/)
})

test("visual harness uses PTY bytes and never desktop capture or input APIs", () => {
  const source = ["opencode-visual-e2e.ts", "opencode-pty-bridge.mjs"]
    .map((file) => readFileSync(join(root, "scripts", file), "utf8"))
    .join("\n")
  expect(source).toMatch(/node-pty/)
  expect(source).toMatch(/EmbeddedTerminalRenderable/)
  expect(source).toMatch(/\.cast/)
  expect(source).toMatch(/args\[0\] !== "--standalone"/)
  expect(source).toMatch(/windowsHide: true/)
  expect(source).toMatch(/plugins: \[plugin\]/)
  expect(source).not.toMatch(/SendKeys|SetForegroundWindow|PrintWindow|CopyFromScreen|Start-Process/)
})

test("captured OpenTUI cells render to a styled SVG", async () => {
  const setup = await createTestRenderer({ width: 20, height: 4 })
  try {
    setup.renderer.root.add(new TextRenderable(setup.renderer, { content: "REAL FRAME", fg: "#20c7e8" }))
    await setup.renderOnce()
    const svg = frameToSvg(setup.captureSpans(), "fixture")
    expect(svg).toContain("REAL FRAME")
    expect(svg).toContain("#20c7e8")
    expect(svg).toContain("Cascadia Mono")
  } finally { setup.renderer.destroy() }
})
