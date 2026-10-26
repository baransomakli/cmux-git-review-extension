import { diffWordsWithSpace } from "diff";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { Commit, DiffLine, DiffResponse, FileDiff, Hunk, RepoContext } from "../src/types.js";

for (const [name, lang] of Object.entries({ bash, css, javascript, json, markdown, php, python, scss, sql, swift, typescript, xml, yaml })) {
  hljs.registerLanguage(name, lang);
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  php: "php", css: "css", scss: "scss", sass: "scss", json: "json", jsonc: "json",
  md: "markdown", mdx: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", py: "python", swift: "swift", sql: "sql",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", twig: "xml", vue: "xml", liquid: "xml",
};

const POLL_MS = 2000;
const CONTEXT_STEP = 20;
const LOG_PAGE = 100;

// ---------- api ----------

const params = new URLSearchParams(location.search);
const token = params.get("t") ?? "";
const scope = new URLSearchParams();
for (const k of ["repo", "ws"]) {
  const v = params.get(k);
  if (v) scope.set(k, v);
}

async function api<T>(route: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
  const q = new URLSearchParams(scope);
  for (const [k, v] of Object.entries(query)) q.set(k, v);
  const res = await fetch(`/api/${route}?${q}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-review-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------- state ----------

type Mode = "uncommitted" | "history" | "compare";

const state = {
  ctx: null as RepoContext | null,
  root: null as string | null,
  fp: "",
  mode: "uncommitted" as Mode,
  base: "",
  commits: [] as Commit[],
  commitsDone: false,
  sha: null as string | null,
  files: [] as FileDiff[],
  context: new Map<string, number>(),
  collapsed: new Set<string>(),
  loadSeq: 0,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  bar: $("bar"),
  branch: $("branch-name"),
  summary: $("summary"),
  mode: $<HTMLSelectElement>("mode"),
  base: $<HTMLSelectElement>("base"),
  discardAll: $<HTMLButtonElement>("discard-all"),
  refresh: $<HTMLButtonElement>("refresh"),
  collapseAll: $<HTMLButtonElement>("collapse-all"),
  commits: $("commits"),
  commitInfo: $("commit-info"),
  files: $("files"),
  toast: $("toast"),
};

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode or blocked storage: the preference just isn't remembered.
    }
  },
};

const collapsedKey = () => `cmux-review:collapsed:${state.root}:${modeKey()}`;
const modeKey = () => (state.mode === "history" ? `commit:${state.sha}` : state.mode === "compare" ? `compare:${state.base}` : "uncommitted");

function loadCollapsed(): void {
  try {
    state.collapsed = new Set(JSON.parse(storage.get(collapsedKey()) ?? "[]") as string[]);
  } catch {
    state.collapsed = new Set();
  }
}

const saveCollapsed = () => storage.set(collapsedKey(), JSON.stringify([...state.collapsed]));

// ---------- helpers ----------

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function relTime(epoch: number): string {
  const s = Date.now() / 1000 - epoch;
  if (s < 60) return "just now";
  const units: [number, string][] = [[31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]];
  for (const [size, unit] of units) if (s >= size) return `${Math.floor(s / size)}${unit} ago`;
  return "";
}

let toastTimer = 0;
function toast(message: string, error = false): void {
  el.toast.textContent = message;
  el.toast.className = error ? "error" : "";
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), error ? 6000 : 3500);
}

/** A destructive button needs a second click within 3 s; the first one only arms it. */
function armed(button: HTMLButtonElement, label: string, action: () => Promise<void>): void {
  const original = [...button.childNodes];
  let timer = 0;
  button.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!button.classList.contains("confirm")) {
      button.classList.add("confirm");
      button.replaceChildren(icon("undo"), h("span", {}, label));
      timer = window.setTimeout(reset, 3000);
      return;
    }
    reset();
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
    }
  });
  function reset(): void {
    clearTimeout(timer);
    button.classList.remove("confirm");
    button.replaceChildren(...original);
  }
}

// ---------- syntax highlighting & word diff ----------

function languageFor(path: string): string | undefined {
  const base = path.split("/").pop() ?? "";
  if (/^(Dockerfile|Makefile)$/.test(base)) return undefined;
  if (base === ".zshrc" || base === ".bashrc") return "bash";
  return LANG_BY_EXT[base.split(".").pop()?.toLowerCase() ?? ""];
}

/** Split highlight.js HTML into lines, closing and reopening spans that cross a newline. */
function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const m of html.matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+/g)) {
    const tok = m[0];
    if (tok === "\n") {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else {
      if (tok.startsWith("<span")) open.push(tok);
      else if (tok === "</span>") open.pop();
      cur += tok;
    }
  }
  lines.push(cur);
  return lines;
}

function highlightSide(lines: string[], lang: string | undefined): string[] {
  if (!lang) return lines.map(escapeHtml);
  try {
    const out = splitHighlighted(hljs.highlight(lines.join("\n"), { language: lang, ignoreIllegals: true }).value);
    return out.length === lines.length ? out : lines.map(escapeHtml);
  } catch {
    return lines.map(escapeHtml);
  }
}

type Range = [number, number];

/** Character ranges that changed between a removed line and the added line paired with it. */
function wordRanges(a: string, b: string): { old: Range[]; new: Range[] } | null {
  const parts = diffWordsWithSpace(a, b);
  const old: Range[] = [];
  const neu: Range[] = [];
  let oa = 0;
  let ob = 0;
  let changed = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.removed) {
      old.push([oa, oa + len]);
      oa += len;
      changed += len;
    } else if (p.added) {
      neu.push([ob, ob + len]);
      ob += len;
      changed += len;
    } else {
      oa += len;
      ob += len;
    }
  }
  // Mostly rewritten lines read better without confetti.
  if (changed > 0.7 * (a.length + b.length)) return null;
  return { old, new: neu };
}

/** Wrap character ranges of an element's text in <mark>, across syntax spans. */
function markRanges(root: HTMLElement, ranges: Range[]): void {
  if (!ranges.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let offset = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: offset });
    offset += (n as Text).length;
  }
  for (const { node, start } of nodes) {
    const end = start + node.length;
    const hits = ranges
      .filter(([s, e]) => s < end && e > start)
      .map(([s, e]) => [Math.max(s, start) - start, Math.min(e, end) - start] as Range)
      .sort((x, y) => y[0] - x[0]);
    for (const [s, e] of hits) {
      node.splitText(e);
      const mid = node.splitText(s);
      const mark = document.createElement("mark");
      mid.replaceWith(mark);
      mark.append(mid);
    }
  }
}

// ---------- rendering ----------

function renderHunkRows(hunk: Hunk, lang: string | undefined, out: HTMLElement): void {
  const oldSide = hunk.lines.filter((l) => l.t !== "+");
  const newSide = hunk.lines.filter((l) => l.t !== "-");
  const oldHtml = highlightSide(oldSide.map((l) => l.s), lang);
  const newHtml = highlightSide(newSide.map((l) => l.s), lang);
  const html = new Map<DiffLine, string>();
  oldSide.forEach((l, i) => html.set(l, oldHtml[i]));
  newSide.forEach((l, i) => l.t === "+" && html.set(l, newHtml[i]));

  // Pair each run of deletions with the run of additions right after it.
  const marks = new Map<DiffLine, Range[]>();
  for (let i = 0; i < hunk.lines.length; ) {
    if (hunk.lines[i].t !== "-") {
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (hunk.lines[i]?.t === "-") dels.push(hunk.lines[i++]);
    const adds: DiffLine[] = [];
    while (hunk.lines[i]?.t === "+") adds.push(hunk.lines[i++]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const r = wordRanges(dels[k].s, adds[k].s);
      if (r) {
        marks.set(dels[k], r.old);
        marks.set(adds[k], r.new);
      }
    }
  }

  for (const line of hunk.lines) {
    const row = h("div", { class: `row ${line.t === "+" ? "add" : line.t === "-" ? "del" : "ctx"}` });
    const ln = h("span", { class: "ln" }, String((line.t === "-" ? line.o : line.n) ?? ""));
    const code = h("span", { class: "code" });
    code.innerHTML = html.get(line) ?? "";
    const r = marks.get(line);
    if (r) markRanges(code, r);
    if (line.noeol) code.append(h("span", { class: "noeol", title: "No newline at end of file" }, "no EOL"));
    row.append(ln, code);
    out.append(row);
  }
}

function hunkHeader(file: FileDiff, hunk: Hunk, index: number): HTMLElement | null {
  if (index === 0 && hunk.oldStart <= 1 && hunk.newStart <= 1) return null;
  const row = h("div", { class: "row hunk", title: "Show more context", role: "button", tabindex: "0" });
  const ln = h("span", { class: "ln" });
  ln.append(icon("expand"));
  row.append(ln, h("span", { class: "code" }, hunk.section ? `@@ ${hunk.section}` : "⋯"));
  const expand = () => void expandContext(file.path);
  row.addEventListener("click", expand);
  row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), expand()));
  return row;
}

function renderBody(file: FileDiff, body: HTMLElement): void {
  body.replaceChildren();
  const note = (text: string, button?: [string, () => void]) => {
    const p = h("div", { class: "placeholder" }, text);
    if (button) {
      const b = h("button", {}, button[0]);
      b.addEventListener("click", button[1]);
      p.append(b);
    }
    body.append(p);
  };
  if (file.binary) return note("Binary file");
  if (file.tooLarge) return note("Large diff hidden.", ["Load diff", () => void reloadFile(file.path, { full: "1" })]);
  if (!file.hunks.length) {
    if (file.status === "renamed") return note(`Renamed from ${file.oldPath} without changes`);
    if (file.oldMode && file.newMode) return note(`Mode changed ${file.oldMode} → ${file.newMode}`);
    return note(file.stage === "untracked" ? "Empty file" : "No content changes");
  }

  const lang = languageFor(file.path);
  const lines = h("div", { class: "lines" });
  const maxNo = Math.max(...file.hunks.map((x) => Math.max(x.oldStart + x.oldLines, x.newStart + x.newLines)));
  lines.style.setProperty("--ln-w", `${String(maxNo).length}ch`);
  file.hunks.forEach((hunk, i) => {
    const header = hunkHeader(file, hunk, i);
    if (header) lines.append(header);
    renderHunkRows(hunk, lang, lines);
  });
  body.append(lines);
}

const STATUS_TAG: Partial<Record<FileDiff["status"], string>> = { added: "added", deleted: "deleted", renamed: "renamed", copied: "copied" };

function card(file: FileDiff): HTMLElement {
  const c = h("section", { class: "card", "data-path": file.path });
  if (state.collapsed.has(file.path)) c.classList.add("collapsed");

  const toggle = h("button", { class: "toggle", "aria-expanded": String(!state.collapsed.has(file.path)) });
  const slash = file.path.lastIndexOf("/");
  const path = h("span", { class: "path", title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path });
  const bdi = h("bdi");
  if (slash >= 0) bdi.append(h("span", { class: "dir" }, file.path.slice(0, slash + 1)));
  bdi.append(file.path.slice(slash + 1));
  path.append(bdi);
  toggle.append(icon("chevron"), path);

  const badge = h("span", { class: "badge" }, h("span", { class: "add" }, `+${file.additions}`), " · ", h("span", { class: "del" }, `-${file.deletions}`));
  const head = h("div", { class: "card-head" }, toggle, badge);
  const tag = file.stage === "untracked" ? "untracked" : file.stage === "conflicted" ? "conflicted" : STATUS_TAG[file.status];
  if (tag) head.append(h("span", { class: `tag ${tag}` }, tag === "untracked" ? "new" : tag));
  if (file.stage === "staged" || file.stage === "partial") head.append(h("span", { class: "tag staged" }, file.stage));

  const actions = h("div", { class: "actions" });
  if (state.mode === "uncommitted" && file.stage !== "conflicted") {
    const staged = file.stage === "staged";
    const stageBtn = h("button", { class: "icon-btn", title: staged ? "Unstage" : file.stage === "partial" ? "Stage all of this file" : "Stage" });
    stageBtn.append(icon(staged ? "check" : file.stage === "partial" ? "partial" : "square"));
    stageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void mutate(staged ? "unstage" : "stage", { paths: [file.path] });
    });
    const discardBtn = h("button", { class: "icon-btn danger", title: "Discard changes (a backup copy is kept)" });
    discardBtn.append(icon("undo"));
    armed(discardBtn, "Discard?", async () => {
      const res = await mutate<{ backup: string }>("discard", { paths: [file.path] });
      if (res) toast(`Discarded ${file.path} — backup in ${res.backup.replace(/^\/Users\/[^/]+/, "~")}`);
    });
    actions.append(stageBtn, discardBtn);
  }
  if (file.status !== "deleted") {
    const openBtn = h("button", { class: "icon-btn", title: "Open file in cmux" });
    openBtn.append(icon("open"));
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      api("open", {}, { paths: [file.path] }).catch((err: Error) => toast(err.message, true));
    });
    actions.append(openBtn);
  }
  head.append(actions);

  const body = h("div", { class: "body" });
  if (!state.collapsed.has(file.path)) renderBody(file, body);
  toggle.addEventListener("click", () => setCollapsed(c, file, !c.classList.contains("collapsed")));
  c.append(head, body);
  return c;
}

function setCollapsed(c: HTMLElement, file: FileDiff, collapsed: boolean): void {
  c.classList.toggle("collapsed", collapsed);
  c.querySelector(".toggle")?.setAttribute("aria-expanded", String(!collapsed));
  const body = c.querySelector<HTMLElement>(".body")!;
  if (collapsed) state.collapsed.add(file.path);
  else {
    state.collapsed.delete(file.path);
    if (!body.childElementCount) renderBody(file, body);
  }
  saveCollapsed();
}

function empty(title: string, detail = ""): HTMLElement {
  const e = h("div", { class: "empty" }, h("b", {}, title));
  if (detail) {
    const d = h("div");
    d.innerHTML = detail;
    e.append(d);
  }
  return e;
}

function renderFiles(res?: DiffResponse): void {
  delete el.files.dataset.view;
  const scrollY = window.scrollY;
  const nodes = state.files.map(card);
  if (!nodes.length) {
    const msg =
      state.mode === "uncommitted"
        ? empty("No uncommitted changes", "Working tree is clean.")
        : state.mode === "history" && !state.sha
          ? empty("Pick a commit", "")
          : empty("No changes", "");
    nodes.push(msg);
  }
  if (res?.omittedUntracked) nodes.push(empty("", `${res.omittedUntracked} more untracked files not shown.`));
  el.files.replaceChildren(...nodes);
  window.scrollTo(0, scrollY);
  renderSummary();
}

function renderSummary(): void {
  const add = state.files.reduce((n, f) => n + f.additions, 0);
  const del = state.files.reduce((n, f) => n + f.deletions, 0);
  el.summary.replaceChildren(icon("file"), String(state.files.length), " · ", h("span", { class: "add" }, `+${add}`), h("span", { class: "del" }, `-${del}`));
  const ctx = state.ctx;
  el.branch.textContent = ctx?.branch ?? "no commits";
  el.branch.title = ctx ? `${ctx.root}${ctx.upstream ? `\n↑${ctx.ahead} ↓${ctx.behind} ${ctx.upstream}` : ""}` : "";
  el.discardAll.hidden = state.mode !== "uncommitted";
  el.discardAll.disabled = !state.files.length || !ctx?.head;
}

function renderCommits(): void {
  el.commits.hidden = state.mode !== "history";
  if (state.mode !== "history") return;
  const rows: HTMLElement[] = state.commits.map((c) => {
    const b = h("button", { class: `commit${c.sha === state.sha ? " selected" : ""}`, title: c.subject });
    b.append(
      h("span", { class: "sha" }, c.short),
      h("span", { class: "subject" }, c.subject),
      h("span", { class: "by" }, `${c.author} · ${relTime(c.time)}${c.parents > 1 ? " · merge" : ""}`),
    );
    b.addEventListener("click", () => void selectCommit(c.sha));
    return b;
  });
  if (!state.commits.length) rows.push(h("div", { class: "commits-more" }, "No commits yet"));
  else if (!state.commitsDone) rows.push(h("div", { class: "commits-more" }, "Scroll for more…"));
  el.commits.replaceChildren(...rows);
}

function renderCommitInfo(res?: DiffResponse): void {
  const c = state.mode === "history" ? res?.commit : undefined;
  el.commitInfo.hidden = !c;
  if (!c) return;
  const parts: HTMLElement[] = [h("div", { class: "subject" }, c.subject)];
  if (c.body) parts.push(h("div", { class: "body" }, c.body));
  parts.push(h("div", { class: "by" }, `${c.short} · ${c.author} · ${new Date(c.time * 1000).toLocaleString()}${c.parents > 1 ? " · merge (vs first parent)" : ""}`));
  el.commitInfo.replaceChildren(...parts);
}

function syncBarHeight(): void {
  document.documentElement.style.setProperty("--bar-h", `${el.bar.offsetHeight}px`);
}

// ---------- data flow ----------

function diffMode(): string | null {
  if (state.mode === "uncommitted") return "uncommitted";
  if (state.mode === "history") return state.sha ? `commit:${state.sha}` : null;
  return state.base ? `compare:${state.base}` : null;
}

async function loadContext(): Promise<boolean> {
  const res = await api<{ repo: RepoContext | null }>("context");
  state.ctx = res.repo;
  if (res.repo && res.repo.root !== state.root) {
    state.root = res.repo.root;
    state.context.clear();
    loadCollapsed();
  }
  document.title = res.repo ? `Review · ${res.repo.name}` : "Review";
  return Boolean(res.repo);
}

async function loadDiff(): Promise<void> {
  const seq = ++state.loadSeq;
  const mode = diffMode();
  if (!mode) {
    state.files = [];
    renderCommitInfo();
    renderFiles();
    return;
  }
  el.files.classList.add("loading");
  try {
    const res = await api<DiffResponse>("diff", { mode });
    if (seq !== state.loadSeq) return;
    // Keep files the user widened at their wider context.
    for (const [i, f] of res.files.entries()) {
      const ctx = state.context.get(f.path);
      if (ctx) {
        const wide = await api<DiffResponse>("diff", { mode, path: f.path, context: String(ctx) }).catch(() => null);
        if (wide?.files[0]) res.files[i] = { ...wide.files[0], stage: f.stage };
      }
    }
    if (seq !== state.loadSeq) return;
    state.files = res.files;
    renderCommitInfo(res);
    renderFiles(res);
  } finally {
    if (seq === state.loadSeq) el.files.classList.remove("loading");
    syncBarHeight();
  }
}

async function reloadFile(path: string, extra: Record<string, string> = {}): Promise<void> {
  const mode = diffMode();
  if (!mode) return;
  const ctx = state.context.get(path);
  try {
    const res = await api<DiffResponse>("diff", { mode, path, ...(ctx ? { context: String(ctx) } : {}), ...extra });
    const idx = state.files.findIndex((f) => f.path === path);
    const next = res.files.find((f) => f.path === path);
    if (idx < 0 || !next) return;
    next.stage ??= state.files[idx].stage;
    state.files[idx] = next;
    el.files.querySelector(`.card[data-path="${CSS.escape(path)}"]`)?.replaceWith(card(next));
  } catch (err) {
    toast((err as Error).message, true);
  }
}

function expandContext(path: string): Promise<void> {
  state.context.set(path, (state.context.get(path) ?? 3) + CONTEXT_STEP);
  return reloadFile(path);
}

async function loadCommits(reset: boolean): Promise<void> {
  if (reset) {
    state.commits = [];
    state.commitsDone = false;
  }
  if (state.commitsDone) return;
  const { commits } = await api<{ commits: Commit[] }>("log", { skip: String(state.commits.length), limit: String(LOG_PAGE) });
  state.commits.push(...commits);
  state.commitsDone = commits.length < LOG_PAGE;
  renderCommits();
  syncBarHeight();
}

async function selectCommit(sha: string): Promise<void> {
  state.sha = sha;
  state.context.clear();
  loadCollapsed();
  renderCommits();
  window.scrollTo(0, 0);
  await loadDiff();
}

async function loadBranches(): Promise<void> {
  const { branches } = await api<{ branches: string[] }>("branches");
  const current = state.ctx?.branch;
  const choices = branches.filter((b) => b !== current);
  if (!state.base || !choices.includes(state.base)) state.base = state.ctx?.defaultBase && choices.includes(state.ctx.defaultBase) ? state.ctx.defaultBase : (choices[0] ?? "");
  el.base.replaceChildren(...choices.map((b) => h("option", { value: b }, `${b}...HEAD`)));
  el.base.value = state.base;
}

async function setMode(mode: Mode): Promise<void> {
  state.mode = mode;
  el.mode.value = mode;
  el.base.hidden = mode !== "compare";
  state.context.clear();
  storage.set("cmux-review:mode", mode);
  try {
    if (mode === "history") {
      await loadCommits(true);
      if (!state.sha || !state.commits.some((c) => c.sha === state.sha)) state.sha = state.commits[0]?.sha ?? null;
      renderCommits();
    } else {
      renderCommits();
    }
    if (mode === "compare") await loadBranches();
    loadCollapsed();
    await loadDiff();
  } catch (err) {
    toast((err as Error).message, true);
  }
}

async function mutate<T = unknown>(route: string, body: unknown): Promise<T | null> {
  try {
    const res = await api<T>(route, {}, body);
    await refresh(true);
    return res;
  } catch (err) {
    toast((err as Error).message, true);
    return null;
  }
}

/** Re-read everything when the repository changed (or always with `force`). */
async function refresh(force = false): Promise<void> {
  const res = await api<{ root?: string; fp?: string; repo?: null }>("fingerprint");
  if (!res.fp || !res.root) {
    showNoRepo();
    return;
  }
  const repoChanged = res.root !== state.root;
  if (!force && !repoChanged && res.fp === state.fp) return;
  state.fp = res.fp;
  const prevHead = state.ctx?.head;
  await loadContext();
  if (repoChanged) {
    state.sha = null;
    return setMode(state.mode);
  }
  if (state.mode === "history" && (force || state.ctx?.head !== prevHead)) await loadCommits(true);
  if (state.mode !== "history" || force) await loadDiff();
  renderSummary();
}

function showNoRepo(): void {
  // Polling keeps landing here while the workspace has no repo; render once.
  if (state.root === null && el.files.dataset.view === "no-repo") return;
  el.files.dataset.view = "no-repo";
  state.root = null;
  state.ctx = null;
  state.files = [];
  state.fp = "";
  el.branch.textContent = "—";
  el.summary.replaceChildren();
  el.commits.hidden = true;
  el.commitInfo.hidden = true;
  el.discardAll.hidden = true;
  document.title = "Review";
  el.files.replaceChildren(
    empty("Not a git repository", "This workspace's folder is not inside a git repo.<br>Run <code>cmux-review open</code> from a repo to pin the panel to it."),
  );
}

// ---------- keyboard ----------

function currentCard(): HTMLElement | null {
  const cards = [...el.files.querySelectorAll<HTMLElement>(".card")];
  const top = el.bar.offsetHeight + 4;
  return cards.find((c) => c.getBoundingClientRect().bottom > top + 24) ?? null;
}

function jump(dir: 1 | -1): void {
  const cards = [...el.files.querySelectorAll<HTMLElement>(".card")];
  if (!cards.length) return;
  const cur = currentCard();
  const idx = cur ? cards.indexOf(cur) : -1;
  const target = cards[Math.min(cards.length - 1, Math.max(0, idx + dir))];
  cards.forEach((c) => c.classList.toggle("current", c === target));
  window.scrollTo({ top: target.offsetTop - el.bar.offsetHeight - 8, behavior: "smooth" });
}

function toggleAll(): void {
  const cards = [...el.files.querySelectorAll<HTMLElement>(".card")];
  const collapse = cards.some((c) => !c.classList.contains("collapsed"));
  for (const c of cards) {
    const file = state.files.find((f) => f.path === c.dataset.path);
    if (file) setCollapsed(c, file, collapse);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("select, input, textarea")) return;
  if (e.key === "j") jump(1);
  else if (e.key === "k") jump(-1);
  else if (e.key === "x") {
    const c = currentCard();
    const file = state.files.find((f) => f.path === c?.dataset.path);
    if (c && file) setCollapsed(c, file, !c.classList.contains("collapsed"));
  } else if (e.key === "X") toggleAll();
  else if (e.key === "r") void refresh(true);
  else return;
  e.preventDefault();
});

// ---------- wiring ----------

el.mode.addEventListener("change", () => void setMode(el.mode.value as Mode));
el.base.addEventListener("change", () => {
  state.base = el.base.value;
  state.context.clear();
  loadCollapsed();
  void loadDiff();
});
el.refresh.addEventListener("click", () => void refresh(true).catch((err: Error) => toast(err.message, true)));
el.collapseAll.addEventListener("click", toggleAll);
armed(el.discardAll, "Discard all?", async () => {
  const res = await mutate<{ stash: string }>("discard-all", {});
  if (res) toast("All changes stashed — git stash pop to restore");
});
el.commits.addEventListener("scroll", () => {
  const c = el.commits;
  if (!state.commitsDone && c.scrollTop + c.clientHeight > c.scrollHeight - 80) void loadCommits(false);
});
new ResizeObserver(syncBarHeight).observe(el.bar);

// cmux's Dock webview reports document.hidden even while it is on screen, so
// polling cannot pause on visibility; a status call every 2 s is cheap anyway.
let polling = false;
async function poll(): Promise<void> {
  if (polling || !token) return;
  polling = true;
  try {
    await refresh();
  } catch {
    // Server restarting or repo busy; the next tick retries.
  } finally {
    polling = false;
  }
}
setInterval(() => void poll(), POLL_MS);
window.addEventListener("focus", () => void poll());
document.addEventListener("visibilitychange", () => void poll());

async function start(): Promise<void> {
  if (!token) {
    el.files.replaceChildren(empty("Missing token", "Open this panel with <code>cmux-review open</code>."));
    return;
  }
  try {
    const saved = storage.get("cmux-review:mode") as Mode | null;
    const fp = await api<{ root?: string; fp?: string }>("fingerprint");
    if (!fp.root) return showNoRepo();
    state.fp = fp.fp ?? "";
    await loadContext();
    await setMode(saved === "history" || saved === "compare" ? saved : "uncommitted");
  } catch (err) {
    el.files.replaceChildren(empty("Could not load", escapeHtml((err as Error).message)));
  }
}

void start();
