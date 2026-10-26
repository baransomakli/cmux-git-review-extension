import { execFile } from "node:child_process";
import fs from "node:fs";

export const CMUX_BIN = [process.env.CMUX_BUNDLED_CLI_PATH, "/Applications/cmux.app/Contents/Resources/bin/cmux"].find(
  (p): p is string => Boolean(p && fs.existsSync(p)),
);

// The server outlives the terminal that started it, so never let that
// terminal's workspace/surface become an implicit default for a command.
const { CMUX_WORKSPACE_ID: _ws, CMUX_SURFACE_ID: _surface, CMUX_PANEL_ID: _panel, CMUX_TAB_ID: _tab, ...BASE_ENV } = process.env;

export function cmux(args: string[]): Promise<string | undefined> {
  if (!CMUX_BIN) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(CMUX_BIN, args, { timeout: 4000, env: { ...BASE_ENV, CMUX_QUIET: "1" } }, (err, stdout) =>
      resolve(err ? undefined : stdout),
    );
  });
}

async function json<T>(args: string[]): Promise<T | undefined> {
  const out = await cmux([...args, "--json"]);
  try {
    return out === undefined ? undefined : (JSON.parse(out) as T);
  } catch {
    return undefined;
  }
}

interface WindowRow {
  id: string;
  key?: boolean;
  selected_workspace_id?: string;
}

interface WorkspaceRow {
  id: string;
  current_directory?: string | null;
}

let dirCache: { at: number; dirs: Map<string, string>; selected?: string } | undefined;

/** Workspace id → current directory for every window, plus the key window's selected workspace. Cached for 1.5 s. */
async function workspaceDirs(): Promise<typeof dirCache> {
  if (dirCache && Date.now() - dirCache.at < 1500) return dirCache;
  const windows = await json<WindowRow[]>(["list-windows"]);
  if (!windows) return undefined;
  const dirs = new Map<string, string>();
  for (const win of windows) {
    const list = await json<{ workspaces?: WorkspaceRow[] }>(["workspace", "list", "--window", win.id]);
    for (const ws of list?.workspaces ?? []) if (ws.current_directory) dirs.set(ws.id, ws.current_directory);
  }
  const selected = (windows.find((w) => w.key) ?? windows[0])?.selected_workspace_id;
  dirCache = { at: Date.now(), dirs, selected };
  return dirCache;
}

/** Current directory of a workspace, or of the selected workspace when `workspaceId` is omitted. */
export async function workspaceDirectory(workspaceId?: string): Promise<string | undefined> {
  const info = await workspaceDirs();
  const id = workspaceId ?? info?.selected;
  return id ? info?.dirs.get(id) : undefined;
}

interface TreeSurface {
  ref: string;
  id?: string;
  type: string;
  url?: string | null;
}

/** Browser surfaces in a workspace's Dock whose URL starts with `prefix`. */
export async function findDockBrowsers(workspaceId: string, prefix: string): Promise<string[]> {
  const tree = await json<unknown>(["tree", "--workspace", workspaceId, "--id-format", "both"]);
  const found: string[] = [];
  const visit = (node: unknown, inDock: boolean): void => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, inDock));
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const dock = inDock || typeof obj.dock_scope === "string";
    const s = obj as unknown as TreeSurface;
    if (dock && s.type === "browser" && typeof s.url === "string" && s.url.startsWith(prefix)) found.push(s.id ?? s.ref);
    for (const v of Object.values(obj)) if (v && typeof v === "object") visit(v, dock);
  };
  visit(tree, false);
  return [...new Set(found)];
}
