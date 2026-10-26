import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "cmux-review");
const STATE_FILE = path.join(STATE_DIR, "server.json");
export const LOG_FILE = path.join(STATE_DIR, "server.log");

/** Fixed default so Dock browsers restored from a cmux session keep working after a restart. */
export const DEFAULT_PORT = 47391;

export interface ServerState {
  /** Survives restarts for the same reason as the port. */
  token: string;
  port: number;
  pid?: number;
}

export function readState(): ServerState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<ServerState>;
    if (typeof s.token === "string" && s.token.length >= 32 && typeof s.port === "number") return s as ServerState;
  } catch {
    // First run or unreadable: start fresh.
  }
  // Persist right away so every command (url, dock-config, serve) agrees on the token.
  const fresh = { token: randomBytes(24).toString("hex"), port: DEFAULT_PORT };
  writeState(fresh);
  return fresh;
}

export function writeState(state: ServerState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
