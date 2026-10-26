import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmux, workspaceDirectory } from "./cmux.js";
import * as g from "./git.js";
import { STATE_DIR } from "./state.js";
import type { DiffMode, FileDiff } from "./types.js";

const WEB_DIR = fileURLToPath(new URL("./web/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const BACKUP_DIR = path.join(STATE_DIR, "discarded");
/** Files whose diff has more lines than this are sent without hunks until asked for. */
const LARGE_FILE_LINES = 1500;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new HttpError(413, "Body too large");
  }
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x.length > 0)) {
    throw new HttpError(400, "paths must be a non-empty string array");
  }
  return v as string[];
}

function parseMode(raw: string | null): DiffMode {
  if (!raw || raw === "uncommitted") return { kind: "uncommitted" };
  if (raw.startsWith("commit:")) return { kind: "commit", sha: raw.slice(7) };
  if (raw.startsWith("compare:")) return { kind: "compare", base: raw.slice(8) };
  throw new HttpError(400, `Unknown mode: ${raw}`);
}

/** The repository a request is about: explicit `repo`, else the workspace's directory (`ws`), else the selected workspace's. */
async function resolveRepo(url: URL): Promise<string | null> {
  const repo = url.searchParams.get("repo");
  if (repo) {
    if (!path.isAbsolute(repo)) throw new HttpError(400, "repo must be an absolute path");
    return g.repoRoot(repo);
  }
  const dir = await workspaceDirectory(url.searchParams.get("ws") ?? undefined);
  return dir ? g.repoRoot(dir) : null;
}

function withholdLarge(files: FileDiff[]): FileDiff[] {
  return files.map((f) => {
    const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    return lines > LARGE_FILE_LINES ? { ...f, hunks: [], tooLarge: true } : f;
  });
}

export function createServer(opts: { token: string; port: number }): http.Server {
  const token = Buffer.from(opts.token);
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  const authorized = (req: http.IncomingMessage): boolean => {
    const given = Buffer.from(String(req.headers["x-review-token"] ?? ""));
    return given.length === token.length && timingSafeEqual(given, token);
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/ping") return send(res, 200, { ok: true, pid: process.pid });

    const root = await resolveRepo(url);
    if (!root) return send(res, 200, { repo: null });

    switch (route) {
      case "GET /api/context":
        return send(res, 200, { repo: await g.context(root) });
      case "GET /api/fingerprint":
        return send(res, 200, { root, fp: await g.fingerprint(root) });
      case "GET /api/diff": {
        const mode = parseMode(url.searchParams.get("mode"));
        const file = url.searchParams.get("path") ?? undefined;
        const context = Number(url.searchParams.get("context") ?? 3);
        const result = await g.diff(root, mode, { path: file, context: Number.isFinite(context) ? context : 3 });
        if (url.searchParams.get("full") !== "1") result.files = withholdLarge(result.files);
        return send(res, 200, result);
      }
      case "GET /api/log": {
        const skip = Math.max(0, Number(url.searchParams.get("skip")) || 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return send(res, 200, { commits: await g.log(root, skip, limit) });
      }
      case "GET /api/branches":
        return send(res, 200, { branches: await g.branches(root) });
      case "POST /api/stage":
        await g.stage(root, stringList((await readBody(req)).paths));
        return send(res, 200, { ok: true });
      case "POST /api/unstage":
        await g.unstage(root, stringList((await readBody(req)).paths));
        return send(res, 200, { ok: true });
      case "POST /api/discard":
        return send(res, 200, { ok: true, backup: await g.discardFiles(root, stringList((await readBody(req)).paths), BACKUP_DIR) });
      case "POST /api/discard-all":
        return send(res, 200, { ok: true, stash: await g.discardAll(root) });
      case "POST /api/open": {
        const [rel] = stringList((await readBody(req)).paths);
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(root + path.sep)) throw new HttpError(400, "Path outside repository");
        const ws = url.searchParams.get("ws");
        const ok = await cmux(["open", abs, "--focus", "true", ...(ws ? ["--workspace", ws] : [])]);
        return send(res, ok === undefined ? 502 : 200, ok === undefined ? { error: "cmux open failed" } : { ok: true });
      }
    }
    throw new HttpError(404, "Not found");
  }

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.join(WEB_DIR, name);
    if (!file.startsWith(WEB_DIR) || !MIME[path.extname(file)]) throw new HttpError(404, "Not found");
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)], "cache-control": "no-cache" });
      res.end(body);
    } catch {
      throw new HttpError(404, "Not found");
    }
  }

  return http.createServer(async (req, res) => {
    try {
      // Blocks DNS rebinding: only our own loopback origin may talk to us.
      if (!allowedHosts.has(String(req.headers.host))) throw new HttpError(403, "Forbidden host");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
        return await serveStatic(res, url.pathname);
      }
      // A custom header also forces a CORS preflight, which we never answer.
      if (!authorized(req)) throw new HttpError(403, "Missing or wrong token");
      await api(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof g.GitError) return send(res, 409, { error: err.message });
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
