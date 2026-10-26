import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as g from "../git.js";

async function repo(): Promise<string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmux-review-test-")));
  await g.git(dir, ["init", "-q", "-b", "main"]);
  await g.git(dir, ["config", "user.email", "t@example.com"]);
  await g.git(dir, ["config", "user.name", "Test"]);
  return dir;
}

const write = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};

async function commit(dir: string, message: string): Promise<void> {
  await g.git(dir, ["add", "-A"]);
  await g.git(dir, ["commit", "-q", "-m", message]);
}

test("empty repository: untracked files show, discard refuses", async () => {
  const dir = await repo();
  write(dir, "a.txt", "one\n");
  const ctx = await g.context(dir);
  assert.equal(ctx.head, null);
  const { files } = await g.diff(dir, { kind: "uncommitted" });
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.stage, f.additions]),
    [["a.txt", "added", "untracked", 1]],
  );
  await g.stage(dir, ["a.txt"]);
  assert.equal((await g.diff(dir, { kind: "uncommitted" })).files[0].stage, "staged");
  await g.unstage(dir, ["a.txt"]);
  assert.equal((await g.diff(dir, { kind: "uncommitted" })).files[0].stage, "untracked");
  await assert.rejects(g.discardAll(dir), /at least one commit/);
  // Single-file discard works without commits: the new file is removed after a backup.
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-review-backup-"));
  const backup = await g.discardFiles(dir, ["a.txt"], backupRoot);
  assert.equal(fs.readFileSync(path.join(backup, "a.txt"), "utf8"), "one\n");
  assert.deepEqual(await g.status(dir), []);
});

test("uncommitted diff, stage states, history, compare and recoverable discard", async () => {
  const dir = await repo();
  write(dir, "src/app.ts", "a\nb\nc\n");
  write(dir, "old name.txt", "same\n");
  await commit(dir, "first");

  write(dir, "src/app.ts", "a\nB\nc\n");
  await g.git(dir, ["mv", "old name.txt", "new name.txt"]);
  write(dir, "notes/new.md", "# hi\n");
  await g.git(dir, ["add", "src/app.ts"]);
  write(dir, "src/app.ts", "a\nB\nc\nd\n");

  const { files } = await g.diff(dir, { kind: "uncommitted" });
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(byPath["src/app.ts"].stage, "partial");
  assert.deepEqual([byPath["src/app.ts"].additions, byPath["src/app.ts"].deletions], [2, 1]);
  assert.equal(byPath["new name.txt"].status, "renamed");
  assert.equal(byPath["new name.txt"].oldPath, "old name.txt");
  assert.equal(byPath["notes/new.md"].stage, "untracked");

  await assert.rejects(g.stage(dir, ["not-changed.txt"]), /Not a changed file/);
  await assert.rejects(g.diff(dir, { kind: "commit", sha: "--output=/tmp/x" }), /Unknown commit/);

  const fp1 = await g.fingerprint(dir);
  write(dir, "src/app.ts", "a\nB\nc\nd\ne\n");
  assert.notEqual(await g.fingerprint(dir), fp1, "editing an already-modified file changes the fingerprint");

  // Discard one file: backed up and reset, other files (and their staged state) untouched.
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-review-backup-"));
  const backup = await g.discardFiles(dir, ["src/app.ts"], backupRoot);
  assert.equal(fs.readFileSync(path.join(backup, "src/app.ts"), "utf8"), "a\nB\nc\nd\ne\n");
  assert.equal(fs.readFileSync(path.join(dir, "src/app.ts"), "utf8"), "a\nb\nc\n");
  let after = await g.status(dir);
  assert.ok(!after.some((e) => e.path === "src/app.ts"));
  assert.ok(after.some((e) => e.path === "new name.txt" && e.x === "R"), "staged rename survives");
  // A rename discards both sides back to HEAD; an untracked file is removed.
  await g.discardFiles(dir, ["new name.txt", "notes/new.md"], backupRoot);
  after = await g.status(dir);
  assert.deepEqual(after, []);
  assert.equal(fs.existsSync(path.join(dir, "old name.txt")), true);
  assert.equal(fs.existsSync(path.join(dir, "new name.txt")), false);
  assert.equal(fs.existsSync(path.join(dir, "notes/new.md")), false);

  write(dir, "src/app.ts", "a\nB\nc\nd\ne\n");
  write(dir, "notes/new.md", "# hi\n");

  // Discard all, then recover everything.
  assert.match(await g.discardAll(dir), /cmux-review discard .* \(all\)/);
  assert.deepEqual(await g.status(dir), []);
  await g.git(dir, ["stash", "pop", "-q"]);
  assert.equal(fs.readFileSync(path.join(dir, "src/app.ts"), "utf8"), "a\nB\nc\nd\ne\n");

  await commit(dir, "second\n\nbody text");
  const commits = await g.log(dir, 0, 10);
  assert.deepEqual(
    commits.map((c) => c.subject),
    ["second", "first"],
  );
  const shown = await g.diff(dir, { kind: "commit", sha: commits[0].short });
  assert.equal(shown.commit?.body, "body text");
  assert.ok(shown.files.some((f) => f.path === "notes/new.md"));

  await g.git(dir, ["checkout", "-q", "-b", "feature"]);
  write(dir, "feature.txt", "x\n");
  await commit(dir, "feature work");
  assert.equal((await g.context(dir)).defaultBase, "main");
  const cmp = await g.diff(dir, { kind: "compare", base: "main" });
  assert.deepEqual(
    cmp.files.map((f) => f.path),
    ["feature.txt"],
  );
  assert.deepEqual(await g.branches(dir), ["feature", "main"]);
});
