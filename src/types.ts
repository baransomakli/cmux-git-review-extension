/** Shapes shared by the server API and the web client. */

export type LineType = " " | "+" | "-";

export interface DiffLine {
  t: LineType;
  /** Old-side line number (context and deletions). */
  o?: number;
  /** New-side line number (context and additions). */
  n?: number;
  s: string;
  /** "\ No newline at end of file" followed this line. */
  noeol?: true;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  oldMode?: string;
  newMode?: string;
  hunks: Hunk[];
  /** Hunks were withheld because the diff is large; request the file with `full=1`. */
  tooLarge?: boolean;
  /** Uncommitted mode only: where the change lives. */
  stage?: "staged" | "unstaged" | "partial" | "untracked" | "conflicted";
}

export interface RepoContext {
  root: string;
  name: string;
  /** Branch name, or the short sha when HEAD is detached; null in a repo without commits. */
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  defaultBase: string | null;
}

export interface Commit {
  sha: string;
  short: string;
  author: string;
  time: number;
  subject: string;
  parents: number;
}

export type DiffMode = { kind: "uncommitted" } | { kind: "commit"; sha: string } | { kind: "compare"; base: string };

export interface DiffResponse {
  files: FileDiff[];
  commit?: Commit & { body: string };
  /** Untracked files that were skipped because there were too many. */
  omittedUntracked?: number;
}
