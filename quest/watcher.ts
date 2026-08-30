import { existsSync, watch, type FSWatcher } from "node:fs"
import { join } from "node:path"
import { listQuestFiles } from "./index"
export function watchQuests(projectRoot: string, onChange: (paths: string[]) => void, debounceMs = 100): () => void {
  const dir = join(projectRoot, ".opencode", "quests"); if (!existsSync(dir)) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined, pending = new Set<string>(); let watcher: FSWatcher
  try { watcher = watch(dir, (_event, name) => { if (name) pending.add(join(dir, String(name))); clearTimeout(timer); timer = setTimeout(() => { const paths = [...pending]; pending.clear(); onChange(paths.filter((p) => listQuestFiles(projectRoot).includes(p))) }, debounceMs) }) } catch { return () => {} }
  return () => { clearTimeout(timer); watcher.close(); pending.clear() }
}
