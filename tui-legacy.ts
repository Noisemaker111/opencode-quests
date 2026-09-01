/**
 * opencode2 beta-18743 still invokes legacy `{ id, setup }` TUI modules, but
 * its config-scoped @opencode-ai/plugin package no longer exports Plugin or
 * usePlugin. Keep the host contract local so a package-only SDK update cannot
 * make every configured TUI module fail before setup.
 */
export const Plugin = {
  define<T extends { id: string; setup: (context: any) => unknown }>(plugin: T): T { return plugin },
}