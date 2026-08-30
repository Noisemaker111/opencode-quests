export type QuestHost = { slot?: (name: string, render: () => unknown) => unknown; command?: (name: string, run: (args: string[]) => unknown) => unknown; toast?: (message: string) => void }
export function installQuestHost(host: any, render: () => unknown): () => void {
  try { if (typeof host?.slot === "function") { const dispose = host.slot("home-right", render); return typeof dispose === "function" ? dispose : () => {} } } catch {}
  try { if (typeof host?.slot === "function") { const dispose = host.slot("home.footer", render); return typeof dispose === "function" ? dispose : () => {} } } catch {}
  return () => {}
}
