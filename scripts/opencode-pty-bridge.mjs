/**
 * Node-only PTY transport for opencode-visual-e2e.ts.
 *
 * OpenTUI's Windows FFI currently needs Bun, while node-pty's Windows input
 * transport needs Node. This bridge owns one exact isolated --standalone
 * OpenCode2 child and exchanges base64 terminal bytes as JSON lines.
 */
import * as pty from "node-pty"
import { basename, dirname } from "node:path"

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emit(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }

const exe = option("--exe")
const cwd = option("--cwd")
const args = JSON.parse(Buffer.from(option("--args") ?? "", "base64url").toString("utf8"))
const cols = Number(option("--cols"))
const rows = Number(option("--rows"))

if (!exe || !/^opencode2(?:\.exe)?$/i.test(basename(exe))) throw new Error("opencode2 executable required")
if (!cwd || !basename(dirname(cwd)).startsWith("visual-e2e-")) throw new Error("isolated visual-e2e cwd required")
if (!Array.isArray(args) || args[0] !== "--standalone" || args.at(-1) !== cwd) throw new Error("exact standalone args required")
if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error("valid PTY dimensions required")

const terminal = pty.spawn(exe, args, { name: "xterm-256color", cols, rows, cwd, env: process.env })
let exited = false
terminal.onData((data) => emit({ type: "data", data: Buffer.from(data, "utf8").toString("base64") }))
terminal.onExit((event) => {
  exited = true
  emit({ type: "exit", exitCode: event.exitCode, signal: event.signal })
  setTimeout(() => process.exit(0), 25)
})

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  input += chunk
  while (true) {
    const newline = input.indexOf("\n")
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.type === "write" && !exited) terminal.write(Buffer.from(message.data, "base64").toString("utf8"))
    if (message.type === "resize" && !exited) terminal.resize(message.cols, message.rows)
    if (message.type === "kill" && !exited) terminal.kill()
  }
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!exited) terminal.kill()
  })
}
