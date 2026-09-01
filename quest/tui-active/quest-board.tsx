/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { readAllQuests } from "../index"
import type { Quest, QuestStage } from "../types"
import { questIndicator } from "../tui-model"
import { questLane } from "../board"
import { watchQuests } from "../watcher"
import { talkToQuestGiver } from "../giver-session"

export const C = {
  bg: "#07111b", panel: "#0b1825", selected: "#112538", line: "#24364a",
  text: "#d8d4ca", muted: "#8f8a82", dim: "#596675", yellow: "#f2cf45",
  cyan: "#20c7e8", green: "#75c94f", orange: "#e99b45", red: "#e46c76",
}

export function projectRoot(context: any): string {
  const location = context.location ?? context.data?.location?.default?.()
  return location?.directory ?? process.cwd()
}

export function quests(root: string): Quest[] {
  return readAllQuests(root).flatMap((entry) => entry.quest ? [entry.quest] : [])
}

export function activate(event: any, action: () => void) { try { event?.stopPropagation?.() } catch {}; action() }

function repo(q: Quest): string {
  const value = q.scope.repos[0] ?? "workspace"
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function integrationSession(q: Quest) {
  return q.sessions.find((session) => session.sessionID === q.integrationOwner || session.openCodeSessionId === q.integrationOwner)
    ?? q.sessions.find((session) => session.role === "integration-owner" || session.agentRole === "orchestrator")
}

function branch(q: Quest): string { return integrationSession(q)?.branch ?? "workspace" }

function progress(q: Quest): { done: number; total: number } {
  if (q.stages.length) return { done: q.stages.filter((stage) => stage.status === "done").length, total: q.stages.length }
  if (q.deliverables.length) return { done: q.deliverables.filter((item) => item.status === "done").length, total: q.deliverables.length }
  return { done: q.acceptanceCriteria.filter((item) => item.satisfied).length, total: q.acceptanceCriteria.length }
}

function status(q: Quest): { label: string; color: string } {
  if (q.state === "Working") return { label: "RUNNING", color: C.green }
  if (q.state === "Needs attention") return { label: "STOPPED", color: C.red }
  if (q.state === "Verifying") return { label: "VERIFYING", color: C.orange }
  if (q.state === "Ready to complete" || q.state === "Complete") return { label: "READY", color: C.green }
  if (q.state === "Archived") return { label: "COMPLETED", color: C.muted }
  return { label: "WAITING", color: C.muted }
}

function stageRows(q: Quest): QuestStage[] {
  if (q.stages.length) return q.stages
  return q.deliverables.map((item) => ({
    id: item.id, title: item.title, status: item.status, needs: [], todos: [],
    claim: { repos: q.scope.repos, include: [], exclude: [] }, proofs: [], attempt: 1,
  }))
}

function badge(q: Quest): string {
  if (q.state === "Working") return "ACCEPTED"
  if (q.state === "Needs attention") return "NEEDS ATTENTION"
  if (q.state === "Ready to complete" || q.state === "Complete") return "TURN IN"
  return q.state.toUpperCase()
}

function Row(props: { quest: Quest; selected: boolean; select: () => void }) {
  const p = progress(props.quest), s = status(props.quest)
  return <box flexDirection="row" gap={1} padding={1} backgroundColor={props.selected ? C.selected : "transparent"} flexShrink={0} onMouseUp={(event: any) => activate(event, props.select)}>
    <Show when={props.selected}><box width={1} backgroundColor={C.cyan} flexShrink={0} /></Show>
    <box width={4} height={3} border borderColor={C.line} alignItems="center" justifyContent="center" flexShrink={0}><text fg={C.muted}>OC</text></box>
    <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
      <text fg={props.selected ? C.yellow : C.text} attributes={props.selected ? TextAttributes.BOLD : undefined} wrapMode="none" truncate>{props.quest.title}</text>
      <text fg={C.muted} wrapMode="none" truncate>{repo(props.quest)} · {branch(props.quest)}  <span fg={s.color}>{s.label}</span></text>
      <text fg={C.dim} wrapMode="none" truncate>{props.quest.nextAction}</text>
    </box>
    <box width={7} height={3} border borderStyle="rounded" borderColor={p.done === p.total && p.total ? C.green : C.line} alignItems="center" justifyContent="center" flexShrink={0}>
      <text fg={p.done ? C.green : C.muted}>{p.done}/{p.total}</text>
    </box>
  </box>
}

function StageList(props: { quest: Quest }) {
  return <box flexDirection="column" flexShrink={0}>
    <text fg={C.cyan} attributes={TextAttributes.BOLD}>QUEST STEPS</text>
    <For each={stageRows(props.quest)}>{(stage, index) => <box flexDirection="column" paddingTop={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexWrap="no-wrap">
        <text fg={stage.status === "done" ? C.green : C.dim} width={2}>{stage.status === "done" ? "☑" : "☐"}</text>
        <text fg={C.muted} width={3}>{String(index() + 1).padStart(2, "0")}</text>
        <text fg={C.text} wrapMode="word" flexGrow={1}>{stage.title}</text>
        <text fg={stage.status === "blocked" ? C.red : stage.status === "working" ? C.orange : C.muted}>ATTEMPT {stage.attempt}</text>
      </box>
      <For each={stage.todos}>{(todo) => <text fg={C.muted} paddingLeft={7}>{todo.status === "done" ? "✓" : "·"} {todo.title}</text>}</For>
      <For each={stage.proofs.filter((proof) => proof.attempt === stage.attempt)}>{(proof) => <text fg={proof.verdict === "FAIL" || proof.result === "failed" ? C.red : C.muted} paddingLeft={7}>Evidence: {proof.kind} · {proof.verdict ?? proof.result ?? "recorded"}{proof.reason ? ` · ${proof.reason}` : ""}</text>}</For>
    </box>}</For>
  </box>
}

function AgentLog(props: { quest: Quest }) {
  return <box flexDirection="column" flexShrink={0}>
    <text fg={C.cyan} attributes={TextAttributes.BOLD}>AGENT LOG</text>
    <Show when={props.quest.sessions.length > 0} fallback={<text fg={C.dim}>No delegated work yet</text>}>
      <For each={props.quest.sessions}>{(session) => <box flexDirection="row" gap={1} flexWrap="no-wrap">
        <text fg={C.text} flexGrow={1} truncate wrapMode="none">{session.model ?? `${session.providerID ?? "unknown"}/${session.modelID ?? "unknown"}`} - {session.task ?? session.taskID ?? "delegated work"}</text>
        <text fg={session.state === "executing" ? C.green : session.state === "failed" ? C.red : C.muted} width={10}>{session.state.toUpperCase()}</text>
      </box>}</For>
    </Show>
  </box>
}

type TalkLine = { role: "Jk" | "Quest Giver"; text: string }

function Conversation(props: { context: any; root: string; quest?: Quest }) {
  const [input, setInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [lines, setLines] = createSignal<TalkLine[]>([])
  const send = async (value: string) => {
    const text = value.trim(); if (!text || busy()) return
    setInput(""); setBusy(true); setLines((prior) => [...prior, { role: "Jk", text }])
    try {
      const reply = await talkToQuestGiver(props.context, props.root, text, props.quest && { id: props.quest.id, title: props.quest.title })
      setLines((prior) => [...prior, { role: "Quest Giver", text: reply || "Delegated. I am tracking it on the Quest board." }])
    } catch (error) { setLines((prior) => [...prior, { role: "Quest Giver", text: `Needs attention: ${String(error).slice(0, 180)}` }]) }
    finally { setBusy(false) }
  }
  return <box flexDirection="column" border borderColor={C.line} paddingLeft={1} paddingRight={1} flexShrink={0}>
    <text fg={C.yellow} attributes={TextAttributes.BOLD}>QUEST GIVER <span fg={C.muted}>· clean turn, durable Quests</span></text>
    <For each={lines().slice(-3)}>{(line) => <text fg={line.role === "Jk" ? C.text : C.yellow} wrapMode="word">{line.role}: {line.text}</text>}</For>
    <input value={input()} onInput={setInput} onSubmit={(value: string) => void send(value)} focused placeholder={busy() ? "Quest Giver is delegating…" : props.quest ? `Talk about “${props.quest.title}”…` : "Tell the Quest Giver what you want done…"} backgroundColor={C.panel} focusedBackgroundColor={C.selected} textColor={C.text} focusedTextColor={C.text} cursorColor={C.yellow} />
  </box>
}

function Detail(props: { quest: Quest; context: any; root: string }) {
  const q = props.quest
  return <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} padding={1} gap={1} backgroundColor={C.bg}>
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}><text fg={C.yellow} attributes={TextAttributes.BOLD}>{q.title}</text><text fg={C.yellow}>{badge(q)}</text></box>
    <text fg={C.cyan}>{repo(q)} <span fg={C.muted}>· {branch(q)} · {q.stages.length || q.deliverables.length} steps · {q.evidence.tests.length} checks</span></text>
    <box height={1} backgroundColor={C.line} flexShrink={0} />
    <scrollbox flexGrow={1} flexShrink={1} scrollbarOptions={{ visible: true }}>
      <box flexDirection="column" gap={1} flexShrink={0}>
        <text fg={C.text} wrapMode="word">{q.objective}</text>
        <text fg={C.muted} wrapMode="word">Next: {q.nextAction}</text>
        <box height={1} backgroundColor={C.line} flexShrink={0} />
        <StageList quest={q} />
        <Show when={q.setbacks.length > 0}><text fg={C.red} attributes={TextAttributes.BOLD}>SETBACKS</text><For each={q.setbacks}>{(item) => <text fg={C.muted}>Attempt {item.attempt} · {item.stageID} · {item.reason}</text>}</For></Show>
        <box height={1} backgroundColor={C.line} flexShrink={0} />
        <AgentLog quest={q} />
        <Show when={q.usageInstructions.length > 0}><box height={1} backgroundColor={C.line} flexShrink={0} /><text fg={C.cyan} attributes={TextAttributes.BOLD}>QUEST PAYOUT</text><For each={q.usageInstructions}>{(line) => <text fg={C.text}>▸ {line}</text>}</For></Show>
      </box>
    </scrollbox>
    <Conversation context={props.context} root={props.root} quest={q} />
  </box>
}

export function QuestBoard(props: { context: any; initialQuestID?: string }) {
  const root = projectRoot(props.context)
  const [all, setAll] = createSignal<Quest[]>([])
  const [selectedID, setSelectedID] = createSignal<string | undefined>(props.initialQuestID)
  const [incomingOpen, setIncomingOpen] = createSignal(false)
  const [completedOpen, setCompletedOpen] = createSignal(false)
  const refresh = () => { try { const list = quests(root); setAll(list); if (!selectedID() && list.length) setSelectedID([...list].filter((q) => q.state !== "Archived").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? list[0].id) } catch {} }
  onMount(() => { refresh(); const stop = watchQuests(root, refresh); onCleanup(stop) })
  const sorted = () => [...all()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const incoming = () => sorted().filter((q) => questLane(q) === "unassigned")
  const current = () => sorted().filter((q) => ["assigned", "attention", "verifying", "ready"].includes(questLane(q)))
  const completed = () => sorted().filter((q) => questLane(q) === "archived")
  const selected = () => all().find((q) => q.id === selectedID())
  return <box flexDirection="column" width="100%" height="100%" backgroundColor={C.bg}>
    <box flexDirection="row" justifyContent="space-between" height={3} paddingLeft={2} paddingRight={2} alignItems="center" backgroundColor={C.panel} flexShrink={0}>
      <text fg={C.text} attributes={TextAttributes.BOLD}>QUESTS <span fg={C.dim}>│</span> <span fg={C.yellow}>Quest Giver</span></text>
      <text fg={C.muted}>{questIndicator(all())} · one controller</text>
    </box>
    <box height={1} backgroundColor={C.line} flexShrink={0} />
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
      <box width={52} flexDirection="column" backgroundColor={C.panel} flexShrink={0}>
        <scrollbox flexGrow={1} flexShrink={1} scrollbarOptions={{ visible: true }}>
          <box flexDirection="column" flexShrink={0}>
            <text fg={C.yellow} padding={1} onMouseUp={(event: any) => activate(event, () => setSelectedID(undefined))}>＋ NEW QUEST <span fg={C.muted}>· just describe what you want</span></text>
            <Show when={incoming().length > 0}>
              <text fg={C.muted} paddingLeft={1} onMouseUp={(event: any) => activate(event, () => setIncomingOpen(!incomingOpen()))}>{incomingOpen() ? "⌄" : "›"} NEW QUESTS · {incoming().length}</text>
              <Show when={incomingOpen()}><For each={incoming()}>{(q) => <Row quest={q} selected={selectedID() === q.id} select={() => setSelectedID(q.id)} />}</For></Show>
            </Show>
            <text fg={C.muted} paddingLeft={1} paddingTop={1}>⌄ CURRENT QUESTS</text>
            <For each={current()}>{(q) => <Row quest={q} selected={selectedID() === q.id} select={() => setSelectedID(q.id)} />}</For>
            <Show when={!current().length}><text fg={C.dim} paddingLeft={2}>No active Quests</text></Show>
            <Show when={completed().length > 0}>
              <text fg={C.muted} paddingLeft={1} paddingTop={1} onMouseUp={(event: any) => activate(event, () => setCompletedOpen(!completedOpen()))}>{completedOpen() ? "⌄" : "›"} COMPLETED QUESTS · {completed().length}</text>
              <Show when={completedOpen()}><For each={completed()}>{(q) => <Row quest={q} selected={selectedID() === q.id} select={() => setSelectedID(q.id)} />}</For></Show>
            </Show>
          </box>
        </scrollbox>
      </box>
      <box width={1} backgroundColor={C.line} flexShrink={0} />
      <Show when={selected()} fallback={<box flexDirection="column" flexGrow={1} padding={2} gap={1}><text fg={C.yellow} attributes={TextAttributes.BOLD}>NEW QUEST</text><text fg={C.text}>Tell the Quest Giver the outcome. It will infer the Quest, delegate it, and track everything here.</text><Conversation context={props.context} root={root} /></box>}>
        {(q) => <Detail quest={q()} context={props.context} root={root} />}
      </Show>
    </box>
  </box>
}
