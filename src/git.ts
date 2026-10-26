import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseDiff } from "./diff-parse.js";
import type { Commit, DiffMode, DiffResponse, FileDiff, RepoContext } from "./types.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_UNTRACKED = 200;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const GIT_ENV = {
  ...process.env,
  LC_ALL: "C",
  // Polling must never take index.lock away from the user's own git commands.
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
};

/** Run git without a shell. `okCodes` lists exit codes that still count as success (diff --no-index exits 1). */
export function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args],
      { cwd, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        if (code !== null && okCodes.includes(code)) return resolve(stdout);
        reject(new GitError((stderr || err?.message || "git failed").trim(), code));
      },
    );
  });
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return null;
  }
}

/** Top level of the repository containing `dir`, or null. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) dir = path.dirname(dir);
  } catch {
    return null;
  }
  return tryGit(dir, ["rev-parse", "--show-toplevel"]);
}

export async function context(root: string): Promise<RepoContext> {
  const [head, branch, upstream] = await Promise.all([
    tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]),
    tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await tryGit(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    if (counts) [behind, ahead] = counts.split(/\s+/).map(Number);
  }
  return {
    root,
    name: path.basename(root),
    branch: branch ?? (head ? head.slice(0, 7) : null),
    detached: !branch && Boolean(head),
    head,
    upstream,
    ahead,
    behind,
    defaultBase: await defaultBase(root, branch),
  };
}

async function defaultBase(root: string, current: string | null): Promise<string | null> {
  const remoteHead = await tryGit(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead;
  for (const name of ["main", "master", "develop"]) {
    if (name === current) continue;
    if (await tryGit(root, ["rev-parse", "-q", "--verify", `refs/heads/${name}`])) return name;
  }
  return null;
}

export interface StatusEntry {
  path: string;
  origPath?: string;
  /** Index (staged) state, "." when unchanged. */
  x: string;
  /** Worktree state, "." when unchanged. */
  y: string;
  untracked: boolean;
  conflicted: boolean;
}

/** Parse `git status --porcelain=v2 -z`. */
export function parseStatus(raw: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === "?") {
      out.push({ path: rec.slice(2), x: ".", y: "?", untracked: true, conflicted: false });
    } else if (kind === "1") {
      const f = rec.split(" ");
      out.push({ path: f.slice(8).join(" "), x: f[1][0], y: f[1][1], untracked: false, conflicted: false });
    } else if (kind === "2") {
      const f = rec.split(" ");
      out.push({ path: f.slice(9).join(" "), origPath: parts[++i], x: f[1][0], y: f[1][1], untracked: false, conflicted: false });
    } else if (kind === "u") {
      const f = rec.split(" ");
      out.push({ path: f.slice(10).join(" "), x: f[1][0], y: f[1][1], untracked: false, conflicted: true });
    }
  }
  return out;
}

export async function status(root: string): Promise<StatusEntry[]> {
  return parseStatus(await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]));
}

/**
 * Cheap change detector for polling: status, HEAD and the size/mtime of every
 * changed file (editing an already-modified file does not change its status).
 */
export async function fingerprint(root: string): Promise<string> {
  const [raw, head] = await Promise.all([
    git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]),
  ]);
  const hash = createHash("sha1").update(raw).update(head ?? "");
  const stats = await Promise.all(
    parseStatus(raw).map((e) => fs.stat(path.join(root, e.path)).then((s) => `${s.size}:${s.mtimeMs}`, () => "-")),
  );
  hash.update(stats.join(","));
  return hash.digest("hex").slice(0, 16);
}

function stageOf(e: StatusEntry): FileDiff["stage"] {
  if (e.untracked) return "untracked";
  if (e.conflicted) return "conflicted";
  if (e.x !== "." && e.y !== ".") return "partial";
  return e.x !== "." ? "staged" : "unstaged";
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-M"];

/** Resolve user input (sha, branch) to a commit sha; never lets the value reach git as an option. */
export async function resolveCommit(root: string, ref: string): Promise<string> {
  const sha = await tryGit(root, ["rev-parse", "-q", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!sha) throw new GitError(`Unknown commit or branch: ${ref}`, null);
  return sha;
}

export async function diff(root: string, mode: DiffMode, opts: { path?: string; context?: number } = {}): Promise<DiffResponse> {
  const unified = `-U${Math.max(0, Math.min(opts.context ?? 3, 100000))}`;
  const pathspec = opts.path ? ["--", opts.path] : [];

  if (mode.kind === "commit") {
    const target = await resolveCommit(root, mode.sha);
    const [raw, meta] = await Promise.all([
      git(root, ["show", "--format=", "--diff-merges=first-parent", ...DIFF_FLAGS, unified, target, ...pathspec]),
      git(root, ["show", "-s", "--format=%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s%x1f%b", target]),
    ]);
    const [sha, short, author, time, parents, subject, body] = meta.replace(/\n$/, "").split("\x1f");
    return {
      files: parseDiff(raw),
      commit: { sha, short, author, time: Number(time), subject, body: body.trim(), parents: parents ? parents.split(" ").length : 0 },
    };
  }

  if (mode.kind === "compare") {
    const base = await resolveCommit(root, mode.base);
    const raw = await git(root, ["diff", ...DIFF_FLAGS, unified, `${base}...HEAD`, ...pathspec]);
    return { files: parseDiff(raw) };
  }

  const head = await tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  const [raw, entries] = await Promise.all([git(root, ["diff", ...DIFF_FLAGS, unified, head ?? EMPTY_TREE, ...pathspec]), status(root)]);
  const files = parseDiff(raw);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const f of files) {
    const e = byPath.get(f.path);
    if (e) f.stage = stageOf(e);
  }

  const untracked = entries.filter((e) => e.untracked && (!opts.path || e.path === opts.path));
  const shown = untracked.slice(0, MAX_UNTRACKED);
  for (const e of shown) files.push(await untrackedDiff(root, e.path, unified));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, omittedUntracked: untracked.length - shown.length || undefined };
}

async function untrackedDiff(root: string, file: string, unified: string): Promise<FileDiff> {
  const placeholder: FileDiff = { path: file, status: "added", binary: false, additions: 0, deletions: 0, hunks: [], stage: "untracked" };
  try {
    const st = await fs.lstat(path.join(root, file));
    if (st.isDirectory()) return placeholder;
    if (st.size > MAX_UNTRACKED_BYTES) return { ...placeholder, tooLarge: true };
  } catch {
    return placeholder;
  }
  const raw = await git(root, ["diff", "--no-index", ...DIFF_FLAGS, unified, "--", "/dev/null", file], [0, 1]);
  const parsed = parseDiff(raw)[0];
  return parsed ? { ...parsed, path: file, status: "added", stage: "untracked" } : placeholder;
}

export async function log(root: string, skip: number, limit: number): Promise<Commit[]> {
  if (!(await tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]))) return [];
  const raw = await git(root, ["log", `--skip=${skip}`, `-n${limit}`, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s%x1e"]);
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, short, author, time, parents, subject] = r.split("\x1f");
      return { sha, short, author, time: Number(time), subject, parents: parents ? parents.split(" ").length : 0 };
    });
}

export async function branches(root: string): Promise<string[]> {
  const raw = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(refname)", "refs/heads", "refs/remotes"]);
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((l) => !l.endsWith("/HEAD"))
    .map((l) => l.split("\t")[0]);
}

/** Expand `paths` to every path git knows for them (a rename's source too) and reject anything not changed. */
async function changedPaths(root: string, paths: string[]): Promise<string[]> {
  const entries = await status(root);
  const out = new Set<string>();
  for (const p of paths) {
    const e = entries.find((x) => x.path === p || x.origPath === p);
    if (!e) throw new GitError(`Not a changed file: ${p}`, null);
    out.add(e.path);
    if (e.origPath) out.add(e.origPath);
  }
  return [...out];
}

export async function stage(root: string, paths: string[]): Promise<void> {
  await git(root, ["add", "-A", "--", ...(await changedPaths(root, paths))]);
}

export async function unstage(root: string, paths: string[]): Promise<void> {
  const list = await changedPaths(root, paths);
  const head = await tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  if (head) await git(root, ["restore", "--staged", "--", ...list]);
  else await git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...list]);
}

function localStamp(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Discard every change by stashing it (untracked files included); `git stash pop`
 * brings it all back. Returns the stash message.
 */
export async function discardAll(root: string): Promise<string> {
  if (!(await tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]))) {
    throw new GitError("Discard all needs at least one commit (git stash cannot run in an empty repository).", null);
  }
  const message = `cmux-review discard ${localStamp()} (all)`;
  await git(root, ["stash", "push", "--include-untracked", "-m", message]);
  return message;
}

/**
 * Discard single files. A path-limited stash would still record the whole
 * index, so popping it later rewrites other files; instead the current
 * worktree copies are backed up under `backupRoot` before git resets them.
 * Returns the backup directory.
 */
export async function discardFiles(root: string, paths: string[], backupRoot: string): Promise<string> {
  const list = await changedPaths(root, paths);
  const backup = path.join(backupRoot, path.basename(root), localStamp().replace(/[: ]/g, "-"));
  for (const rel of list) {
    const src = path.join(root, rel);
    const st = await fs.lstat(src).catch(() => null);
    if (!st || st.isDirectory()) continue;
    await fs.mkdir(path.dirname(path.join(backup, rel)), { recursive: true });
    await fs.cp(src, path.join(backup, rel), { verbatimSymlinks: true });
  }

  const head = await tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  const inHead = new Set(head ? (await git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...list])).split("\0").filter(Boolean) : []);
  const tracked = list.filter((p) => inHead.has(p));
  const fresh = list.filter((p) => !inHead.has(p));
  if (tracked.length) await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  if (fresh.length) {
    await git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...fresh]);
    for (const rel of fresh) await fs.rm(path.join(root, rel), { force: true });
  }
  return backup;
}
