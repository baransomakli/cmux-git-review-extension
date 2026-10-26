import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff, unquotePath } from "../diff-parse.js";

test("modified file with line numbers and stats", () => {
  const [f] = parseDiff(
    [
      "diff --git a/types/object.ts b/types/object.ts",
      "index 1111111..2222222 100644",
      "--- a/types/object.ts",
      "+++ b/types/object.ts",
      "@@ -38,3 +38,4 @@ export interface Item {",
      " }",
      " ",
      "-export type SortOrder = 'newest' | null;",
      "+export type SortOrder = 'newest' | 'popular' | null;",
      "+// added",
      "",
    ].join("\n"),
  );
  assert.equal(f.path, "types/object.ts");
  assert.equal(f.status, "modified");
  assert.equal(f.oldPath, undefined);
  assert.deepEqual([f.additions, f.deletions], [2, 1]);
  const h = f.hunks[0];
  assert.equal(h.section, "export interface Item {");
  assert.deepEqual(
    h.lines.map((l) => [l.t, l.o, l.n]),
    [
      [" ", 38, 38],
      [" ", 39, 39],
      ["-", 40, undefined],
      ["+", undefined, 40],
      ["+", undefined, 41],
    ],
  );
});

test("added, deleted, renamed, binary, mode change and no-newline marker", () => {
  const files = parseDiff(
    [
      "diff --git a/new file.txt b/new file.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "--- /dev/null",
      "+++ b/new file.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "\\ No newline at end of file",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to src/new.ts",
      "diff --git a/logo.png b/logo.png",
      "index 1..2 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.oldPath, f.binary]),
    [
      ["new file.txt", "added", undefined, false],
      ["gone.txt", "deleted", undefined, false],
      ["src/new.ts", "renamed", "old.ts", false],
      ["logo.png", "modified", undefined, true],
      ["run.sh", "modified", undefined, false],
    ],
  );
  assert.equal(files[0].hunks[0].lines[0].noeol, true);
  assert.deepEqual([files[4].oldMode, files[4].newMode], ["100644", "100755"]);
});

test("content lines that look like headers stay content", () => {
  const [f] = parseDiff(
    ["diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -1,2 +1,2 @@", "--- a/x", "+++ b/y", "diff --git a/b b/b", ""].join("\n"),
  );
  assert.equal(f.hunks[0].lines.length, 2);
  assert.deepEqual([f.additions, f.deletions], [1, 1]);
});

test("unquotes C-style paths", () => {
  assert.equal(unquotePath('"t\\303\\251st\\tx.txt"'), "tést\tx.txt");
  assert.equal(unquotePath("plain.txt"), "plain.txt");
});
