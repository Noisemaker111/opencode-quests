/**
 * Real OpenCode2 visual E2E.
 *
 * Runs the installed v2 host in an owned `--standalone` pseudo-terminal,
 * writes terminal input directly, records an asciinema v2 cast, and renders
 * screenshots from OpenTUI's real Ghostty VT cell buffer. It never opens a
 * window or uses desktop input/capture APIs.
 */
import { EmbeddedTerminalRenderable, KeyEvent, TextAttributes, type CapturedFrame } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Resvg } from "@resvg/resvg-js"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export type VisualScenario = "usage" | "quests"

type CastEvent = [number, "o" | "i", string]
type Artifact = { scenario: VisualScenario; screenshot: string; text: string; spans: string; cast: string }

const COLS = 120
const ROWS = 40
const CELL_WIDTH = 9.6
const CELL_HEIGHT = 20
const PAD = 16
const DEFAULT_BG = "#07111b"
const DEFAULT_FG = "#d8d4ca"

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function has(name: string): boolean { return process.argv.includes(name) }

function sleep(ms: number): Promise<void> { return new Promise((done) => setTimeout(done, ms)) }

function which(name: string): string | undefined {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)
}

export function standaloneArgs(project: string, hostLogs = false): string[] {
  if (!basename(dirname(project)).startsWith("visual-e2e-")) throw new Error(`isolated project path required: ${project}`)
  return ["--standalone", ...(hostLogs ? ["--print-logs", "--log-level", "all"] : ["--log-level", "error"]), project]
}

function opencode2(root: string): string {
  const explicit = process.env.OPENCODE2_EXE
  const local = join(root, "node_modules", "@opencode-ai", "cli", "bin", process.platform === "win32" ? "opencode2.exe" : "opencode2")
  const global = process.platform === "win32"
    ? join(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe")
    : which("opencode2")
  const found = [explicit, local, global].find((value): value is string => Boolean(value && existsSync(value)))
  if (!found) throw new Error("opencode2 not found; set OPENCODE2_EXE or install @opencode-ai/cli")
  const version = spawnSync(found, ["--version"], { encoding: "utf8" })
  const text = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim()
  if (!/^opencode2 v0\.0\.0-beta-\d+$/.test(text)) throw new Error(`visual E2E requires a v2 beta host, got: ${text}`)
  return found
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function color(value: { toInts(): [number, number, number, number] }, fallback: string): string {
  const [r, g, b, a] = value.toInts()
  if (a === 0) return fallback
  return `#${[r, g, b].map((part) => Math.max(0, Math.min(255, part)).toString(16).padStart(2, "0")).join("")}`
}

export function frameToSvg(frame: CapturedFrame, title = "OpenCode2 visual E2E"): string {
  const width = Math.ceil(frame.cols * CELL_WIDTH + PAD * 2)
  const height = Math.ceil(frame.rows * CELL_HEIGHT + PAD * 2)
  const body: string[] = [`<rect width="100%" height="100%" fill="${DEFAULT_BG}" rx="10"/>`]
  frame.lines.forEach((line, row) => {
    let column = 0
    for (const span of line.spans) {
      const x = PAD + column * CELL_WIDTH
      const y = PAD + row * CELL_HEIGHT
      const spanWidth = Math.max(0, span.width) * CELL_WIDTH
      const bg = color(span.bg, DEFAULT_BG)
      const fg = color(span.fg, DEFAULT_FG)
      if (spanWidth > 0 && bg !== DEFAULT_BG) body.push(`<rect x="${x}" y="${y}" width="${spanWidth}" height="${CELL_HEIGHT}" fill="${bg}"/>`)
      if (span.text && /\S/.test(span.text)) {
        const bold = (span.attributes & TextAttributes.BOLD) !== 0 ? " font-weight=\"700\"" : ""
        const italic = (span.attributes & TextAttributes.ITALIC) !== 0 ? " font-style=\"italic\"" : ""
        const underline = (span.attributes & TextAttributes.UNDERLINE) !== 0 ? " text-decoration=\"underline\"" : ""
        body.push(`<text x="${x}" y="${y + 15}" fill="${fg}"${bold}${italic}${underline} xml:space="preserve">${escapeXml(span.text)}</text>`)
      }
      column += span.width
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeXml(title)}</title><style>text{font-family:"Cascadia Mono","Consolas","DejaVu Sans Mono",monospace;font-size:16px}</style>${body.join("")}</svg>`
}

function writeScreenshot(frame: CapturedFrame, text: string, base: string, title: string): { screenshot: string; text: string; spans: string } {
  const svg = frameToSvg(frame, title)
  const svgFile = `${base}.svg`
  const pngFile = `${base}.png`
  const textFile = `${base}.txt`
  const spansFile = `${base}.json`
  writeFileSync(svgFile, svg, "utf8")
  writeFileSync(pngFile, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng())
  writeFileSync(textFile, text, "utf8")
  writeFileSync(spansFile, JSON.stringify(frame, null, 2) + "\n", "utf8")
  return { screenshot: pngFile, text: textFile, spans: spansFile }
}

async function createQuestFixture(sourceRoot: string, project: string): Promise<void> {
  const module = await import(pathToFileURL(join(sourceRoot, "quest", "agent-api.ts")).href)
  const api = module.createQuestAgentAPI(project)
  const quest = api.create({
    title: "Visual E2E Quest",
    objective: "Prove the public Quest interface in a real isolated OpenCode2 terminal",
    nextAction: "Inspect the captured Quest board",
    scope: { repos: [project], include: ["quest/**"], exclude: [] },
    deliverables: [{ id: "capture", title: "Capture the real Quest board", status: "working" }],
    acceptanceCriteria: [{ id: "visible", text: "Quest is visible in the OpenCode2 route", satisfied: false }],
  })
  api.accept(quest.id)
}

function createUsageFixture(config: string): void {
  const usage = join(config, "usage")
  mkdirSync(usage, { recursive: true })
  writeFileSync(join(usage, "usage-cache.json"), JSON.stringify({
    updated: new Date().toISOString(),
    sources: [
      { id: "openai", probe: "ok", windows: [{ label: "5h", usedTokens: 35000, used: 35, cap: 100000, pct: 35, resetsInSeconds: 3600 }] },
      { id: "opencode-go", probe: "ok", windows: [{ label: "7d", usedTokens: 78000, used: 78, cap: 100000, pct: 78, resetsInSeconds: 172800 }] },
    ],
  }, null, 2))
  writeFileSync(join(usage, "usage-plans.json"), JSON.stringify({ plans: {} }, null, 2))
  writeFileSync(join(usage, "usage-collector.ts"), "process.exit(0)\n", "utf8")
}

async function waitForScreen(
  render: () => Promise<{ text: string; frame: CapturedFrame }>,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<{ text: string; frame: CapturedFrame }> {
  const deadline = Date.now() + timeoutMs
  let last = { text: "", frame: undefined as CapturedFrame | undefined }
  while (Date.now() < deadline) {
    await sleep(100)
    last = await render()
    if (predicate(last.text)) return last as { text: string; frame: CapturedFrame }
  }
  throw new Error(`${label} did not appear in ${timeoutMs}ms\n${last.text.slice(-4000)}`)
}

async function runScenario(root: string, scenario: VisualScenario, out: string, keepRun: boolean, probe: boolean): Promise<Artifact> {
  const entry = join(root, scenario === "usage" ? "usage/tui-active/usage.tsx" : "quest/tui-active/quests.tsx")
  if (!existsSync(entry)) throw new Error(`${scenario} entrypoint missing: ${entry}`)
  const runs = join(root, ".visual-e2e", "runs")
  const run = join(runs, `visual-e2e-${scenario}-${process.pid}-${Date.now()}`)
  const home = join(run, "home")
  const config = join(home, ".config", "opencode")
  const project = join(run, "project")
  mkdirSync(config, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(out, { recursive: true })
  if (!within(runs, run)) throw new Error(`unsafe visual run path: ${run}`)
  const initialized = spawnSync("git", ["init", "--quiet", project], { encoding: "utf8" })
  if (initialized.status !== 0) throw new Error(`failed to isolate fixture Git root: ${(initialized.stderr ?? "").trim()}`)

  const plugin = join(config, "plugins", `visual-${scenario}`)
  mkdirSync(plugin, { recursive: true })
  const bootstrap = join(plugin, "tui.ts")
  const probeFile = join(run, "probe-loaded.txt")
  writeFileSync(bootstrap, probe
    ? `import { writeFileSync } from "node:fs"\nexport default { id: "visual-probe", setup(context) { writeFileSync(${JSON.stringify(probeFile)}, "loaded\\n"); context.ui.toast.show({ title: "Visual E2E Probe", message: "VISUAL E2E PROBE", duration: 20000 }) } }\n`
    : `export { default } from ${JSON.stringify(pathToFileURL(entry).href)}\n`, "utf8")
  writeFileSync(join(plugin, "package.json"), JSON.stringify({
    name: `opencode-visual-${scenario}`,
    private: true,
    type: "module",
    exports: { ".": "./index.ts", "./tui": "./tui.ts" },
  }, null, 2) + "\n", "utf8")
  writeFileSync(join(plugin, "index.ts"), `import { define } from "@opencode-ai/plugin/v2/promise"\nexport default define({ id: "visual-${scenario}", setup() {} })\n`, "utf8")
  writeFileSync(join(config, "cli.json"), JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", plugins: [] }, null, 2) + "\n", "utf8")
  writeFileSync(join(config, "tui.json"), JSON.stringify({ plugin: [] }, null, 2) + "\n", "utf8")
  writeFileSync(join(config, "opencode.jsonc"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [plugin], mcp: {} }, null, 2) + "\n", "utf8")
  if (scenario === "usage") createUsageFixture(config)
  else await createQuestFixture(root, project)

  const setup = await createTestRenderer({ width: COLS, height: ROWS })
  const terminal = new EmbeddedTerminalRenderable(setup.renderer, { id: scenario, width: COLS, height: ROWS, cols: COLS, rows: ROWS, maxScrollback: 2_000_000 })
  setup.renderer.root.add(terminal)
  terminal.focus()

  const exe = opencode2(root)
  const started = Date.now()
  const cast: CastEvent[] = []
  let exited = false
  let closing = false
  let stoppedByHarness = false
  let exitCode: number | undefined
  const env = cleanEnv({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG: join(config, "opencode.jsonc"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  })
  const node = which("node")
  const bridge = join(root, "scripts", "opencode-pty-bridge.mjs")
  if (!node) throw new Error("Node.js is required for the Windows PTY bridge")
  if (!existsSync(bridge)) throw new Error(`PTY bridge missing: ${bridge}`)
  const args = standaloneArgs(project, has("--host-logs"))
  const child = spawn(node, [bridge, "--exe", exe, "--cwd", project, "--cols", String(COLS), "--rows", String(ROWS), "--args", Buffer.from(JSON.stringify(args)).toString("base64url")], {
    cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  })
  let bridgeBuffer = ""
  let bridgeError = ""
  const bridgeWrite = (value: string) => {
    if (exited || !child.stdin.writable) return
    child.stdin.write(`${JSON.stringify({ type: "write", data: Buffer.from(value, "utf8").toString("base64") })}\n`)
  }
  terminal.onData = (data) => {
    if (exited) return
    try { bridgeWrite(Buffer.from(data).toString("utf8")) } catch {}
  }
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    bridgeBuffer += chunk
    while (true) {
      const newline = bridgeBuffer.indexOf("\n")
      if (newline < 0) break
      const line = bridgeBuffer.slice(0, newline)
      bridgeBuffer = bridgeBuffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as { type: "data"; data: string } | { type: "exit"; exitCode: number }
      if (message.type === "exit") {
        exited = true
        exitCode = message.exitCode
        continue
      }
      if (closing) continue
      const data = Buffer.from(message.data, "base64").toString("utf8")
      cast.push([(Date.now() - started) / 1000, "o", data])
      terminal.write(data)
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => { bridgeError += chunk })
  child.on("exit", (code) => {
    if (!exited) {
      exited = true
      exitCode = code ?? 1
    }
  })
  const send = async (value: string, delay = 120) => {
    if (exited) return
    cast.push([(Date.now() - started) / 1000, "i", value])
    try { bridgeWrite(value) } catch {}
    await sleep(delay)
  }
  const paste = (value: string, delay = 120) => send(Buffer.from(terminal.encodePaste(new TextEncoder().encode(value))).toString("utf8"), delay)
  const enter = (delay = 120) => send(Buffer.from(terminal.encodeKey(new KeyEvent({
    name: "return", ctrl: false, meta: false, shift: false, option: false,
    sequence: "\r", number: false, raw: "\r", eventType: "press", source: "raw",
  }))).toString("utf8"), delay)
  const render = async () => {
    await setup.renderOnce()
    return { text: terminal.screen().text, frame: setup.captureSpans() }
  }

  try {
    await waitForScreen(render, (text) => text.trim().length > 20, 15_000, `${scenario} OpenCode2 screen`)
    let captured: { text: string; frame: CapturedFrame }
    if (probe) {
      captured = await waitForScreen(render, (text) => text.includes("VISUAL E2E PROBE"), 5_000, "visual plugin probe")
    } else if (scenario === "usage") {
      await paste("/usage", 200)
      await enter(200)
      captured = await waitForScreen(render, (text) => text.includes("Subscription usage"), 15_000, "/usage dialog")
    } else {
      captured = await waitForScreen(render, (text) => text.includes("Visual E2E Quest") && text.includes("QUEST STEPS"), 15_000, "Quest board")
    }
    const base = join(out, probe ? `${scenario}-probe` : scenario)
    const screenshot = writeScreenshot(captured.frame, captured.text, base, `OpenCode2 ${scenario} visual E2E`)
    const castFile = `${base}.cast`
    const header = { version: 2, width: COLS, height: ROWS, timestamp: Math.floor(started / 1000), env: { SHELL: "opencode2", TERM: "xterm-256color" } }
    writeFileSync(castFile, [JSON.stringify(header), ...cast.map((event) => JSON.stringify(event))].join("\n") + "\n", "utf8")
    return { scenario, ...screenshot, cast: castFile }
  } catch (error) {
    const castFile = join(out, `${scenario}-failed.cast`)
    const header = { version: 2, width: COLS, height: ROWS, timestamp: Math.floor(started / 1000), env: { SHELL: "opencode2", TERM: "xterm-256color" } }
    writeFileSync(castFile, [JSON.stringify(header), ...cast.map((event) => JSON.stringify(event))].join("\n") + "\n", "utf8")
    const failed = await render().catch(() => undefined)
    if (failed) writeFileSync(join(out, `${scenario}-failed.txt`), failed.text, "utf8")
    try {
      await send("\x1b", 100)
      await paste("/plugins", 150)
      await enter(250)
      await sleep(1_500)
      const plugins = await render()
      writeScreenshot(plugins.frame, plugins.text, join(out, `${scenario}-plugins`), `OpenCode2 ${scenario} plugin diagnostic`)
      writeFileSync(castFile, [JSON.stringify(header), ...cast.map((event) => JSON.stringify(event))].join("\n") + "\n", "utf8")
    } catch {}
    throw error
  } finally {
    closing = true
    terminal.onData = undefined
    terminal.destroy()
    await sleep(100)
    if (!exited) {
      stoppedByHarness = true
      try { child.stdin.write(`${JSON.stringify({ type: "kill" })}\n`) } catch {}
      const deadline = Date.now() + 2_000
      while (!exited && Date.now() < deadline) await sleep(50)
    }
    if (!exited) child.kill()
    setup.renderer.destroy()
    if (!keepRun && within(runs, run)) {
      for (let attempt = 0; attempt < 8; attempt++) {
        try { rmSync(run, { recursive: true, force: true }); break }
        catch (error) {
          if (attempt === 7) console.error(`[visual-e2e] cleanup retained ${run}: ${String(error)}`)
          else await sleep(250)
        }
      }
    }
    if (!stoppedByHarness && exitCode !== undefined && exitCode !== 0 && exitCode !== 130 && exitCode !== 3221225786) {
      console.error(`[visual-e2e] ${scenario} exited ${exitCode}`)
    }
    if (bridgeError.trim()) console.error(`[visual-e2e] PTY bridge: ${bridgeError.trim()}`)
  }
}

export async function main(): Promise<void> {
  const root = resolve(option("--root") ?? process.cwd())
  const requested = option("--scenario") ?? "both"
  if (!/^(usage|quests|both)$/.test(requested)) throw new Error("--scenario must be usage, quests, or both")
  const scenarios: VisualScenario[] = requested === "both" ? ["usage", "quests"] : [requested as VisualScenario]
  const out = resolve(option("--out") ?? join(root, ".visual-e2e", "artifacts"))
  const artifacts: Artifact[] = []
  for (const scenario of scenarios) artifacts.push(await runScenario(root, scenario, out, has("--keep-run"), has("--probe")))
  const manifest = join(out, "manifest.json")
  writeFileSync(manifest, JSON.stringify({ generatedAt: new Date().toISOString(), host: opencode2(root), artifacts }, null, 2) + "\n", "utf8")
  console.log(JSON.stringify({ ok: true, manifest, artifacts }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1) })
}
