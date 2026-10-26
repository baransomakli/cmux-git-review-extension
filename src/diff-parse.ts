import type { DiffLine, FileDiff, Hunk } from "./types.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style path quoting ("t\303\251st" → "tést"). Unquoted input is returned as is. */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strip the a/ or b/ prefix from a ---/+++ path; null for /dev/null. */
function sidePath(raw: string): string | null {
  const p = unquotePath(raw.replace(/\t$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/** Best-effort paths from "diff --git a/X b/Y", used when no ---/+++ lines follow (binary, pure rename, mode change). */
function headerPaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|.*)$/);
    if (m) return [sidePath(m[1]) ?? "", sidePath(m[2]) ?? ""];
  }
  // Same path on both sides is the common case and resolves spaces unambiguously.
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && rest.startsWith("a/") && rest.slice(2, 2 + len) === rest.slice(5 + len) && rest.slice(2 + len, 5 + len) === " b/") {
    const p = rest.slice(2, 2 + len);
    return [p, p];
  }
  const split = rest.indexOf(" b/");
  if (split > 0) return [rest.slice(2, split), rest.slice(split + 3)];
  return [rest, rest];
}

/** Parse `git diff` / `git show` unified output (no combined diffs) into files and hunks. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let last: DiffLine | undefined;

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const [a, b] = headerPaths(line.slice(11));
      file = { path: b, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      if (a !== b) file.oldPath = a;
      files.push(file);
      hunk = undefined;
      last = undefined;
      continue;
    }
    if (!file) continue;

    if (hunk && line[0] !== "\\" && oldNo >= hunk.oldStart + hunk.oldLines && newNo >= hunk.newStart + hunk.newLines) {
      hunk = undefined;
    }
    if (hunk) {
      const t = line[0];
      if (t === " " || t === "+" || t === "-") {
        const dl: DiffLine = { t, s: line.slice(1) };
        if (t !== "+") dl.o = oldNo++;
        if (t !== "-") dl.n = newNo++;
        if (t === "+") file.additions++;
        if (t === "-") file.deletions++;
        hunk.lines.push(dl);
        last = dl;
        continue;
      }
      if (t === "\\") {
        if (last) last.noeol = true;
        continue;
      }
      if (line === "") {
        // Some tools strip the leading space of empty context lines.
        const dl: DiffLine = { t: " ", s: "", o: oldNo++, n: newNo++ };
        hunk.lines.push(dl);
        last = dl;
        continue;
      }
    }

    const h = line.match(HUNK_RE);
    if (h) {
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        section: h[5] ?? "",
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }

    if (line.startsWith("--- ")) {
      const p = sidePath(line.slice(4));
      if (p === null) file.status = "added";
      else if (file.status !== "added") file.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = sidePath(line.slice(4));
      if (p === null) {
        file.status = "deleted";
        if (file.oldPath) file.path = file.oldPath;
      } else file.path = p;
    } else if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice(14);
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice(18);
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice(9);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice(9);
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      file.status = line.startsWith("rename") ? "renamed" : "copied";
      file.oldPath = unquotePath(line.slice(line.indexOf(" from ") + 6));
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      file.path = unquotePath(line.slice(line.indexOf(" to ") + 4));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }

  for (const f of files) {
    if (f.oldPath === f.path || f.status === "added" || f.status === "deleted") delete f.oldPath;
  }
  return files;
}
