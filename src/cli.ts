#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cmux, CMUX_BIN, findDockBrowsers } from "./cmux.js";
import { repoRoot } from "./git.js";
import { createServer } from "./server.js";
import { DEFAULT_PORT, isAlive, LOG_FILE, readState, STATE_DIR, writeState, type ServerState } from "./state.js";

const USAGE = `cmux-review — git review panel for the cmux Dock

Usage:
  cmux-review open [path]     Open the review panel for this repo in the workspace's Dock (starts the server)
  cmux-review serve [--port N] Run the server in the foreground
  cmux-review stop            Stop the background server
  cmux-review status          Show server state
  cmux-review url [path]      Print the panel URL
  cmux-review dock-config     Print a ~/.config/cmux/dock.json control that follows the selected workspace`;

function fail(message: string): never {
  console.error(`cmux-review: ${message}`);
  process.exit(1);
}

async function ping(state: ServerState): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/ping`, {
      headers: { "x-review-token": state.token },
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function serve(argv: string[]): Promise<void> {
  const state = readState();
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : state.port;
  if (!Number.isInteger(port) || port <= 0) fail("invalid --port");
  if (isAlive(state.pid) && state.pid !== process.pid && (await ping(state))) fail(`already running (pid ${state.pid}, port ${state.port})`);

  const server = createServer({ token: state.token, port });
  server.on("error", (err) => fail(err.message));
  server.listen(port, "127.0.0.1", () => {
    writeState({ ...state, port, pid: process.pid });
    console.log(`cmux-review listening on http://127.0.0.1:${port}`);
  });
  const shutdown = () => {
    const current = readState();
    if (current.pid === process.pid) writeState({ ...current, pid: undefined });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/** Start the background server if it is not answering, and return its state. */
async function ensureServer(): Promise<ServerState> {
  let state = readState();
  if (await ping(state)) return state;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    state = readState();
    if (await ping(state)) return state;
  }
  fail(`server did not start, see ${LOG_FILE}`);
}

function panelUrl(state: ServerState, params: Record<string, string | undefined>): string {
  const url = new URL(`http://127.0.0.1:${state.port}/`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  // The token goes last so it is easy to spot (and strip) when sharing a URL.
  url.searchParams.set("t", state.token);
  return url.toString();
}

async function open(argv: string[]): Promise<void> {
  const target = argv[0] ?? process.cwd();
  const root = await repoRoot(target);
  if (!root) fail(`not a git repository: ${target}`);
  const state = await ensureServer();
  const ws = process.env.CMUX_WORKSPACE_ID;
  const url = panelUrl(state, { repo: root, ws });
  if (!ws || !CMUX_BIN) {
    console.log(url);
    return;
  }

  const existing = await findDockBrowsers(ws, `http://127.0.0.1:${state.port}/`);
  if (existing.length) {
    await cmux(["browser", existing[0], "goto", url]);
  } else {
    const out = await cmux(["new-surface", "--type", "browser", "--placement", "dock", "--workspace", ws, "--url", url]);
    if (out === undefined) fail("cmux could not create the Dock browser (is the Dock enabled?)");
  }
  await cmux(["right-sidebar", "set", "dock", "--workspace", ws, "--no-focus"]);
  console.log(`Review panel for ${root} is open in the Dock.`);
}

async function stop(): Promise<void> {
  const state = readState();
  if (!isAlive(state.pid)) return console.log("not running");
  process.kill(state.pid!, "SIGTERM");
  console.log(`stopped pid ${state.pid}`);
}

async function status(): Promise<void> {
  const state = readState();
  const up = await ping(state);
  console.log(up ? `running: pid ${state.pid}, http://127.0.0.1:${state.port}` : "not running");
  console.log(`state: ${STATE_DIR}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "open":
      return open(rest);
    case "serve":
      return serve(rest);
    case "stop":
      return stop();
    case "status":
      return status();
    case "url": {
      const root = await repoRoot(rest[0] ?? process.cwd());
      return console.log(panelUrl(readState(), { repo: root ?? undefined }));
    }
    case "dock-config": {
      const state = readState();
      const control = { id: "git-review", title: "Review", type: "browser", url: panelUrl(state, {}), chrome: false };
      console.log(JSON.stringify({ controls: [control] }, null, 2));
      if (state.port !== DEFAULT_PORT) console.error(`note: uses non-default port ${state.port}`);
      return;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      return console.log(USAGE);
    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

await main();
