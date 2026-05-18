import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureCodexStatePreviewIfEmpty,
  setCodexStatePreviewIfEmpty,
} from "../../src/codex/codex-state-preview.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-preview-test-"));
}

test("setCodexStatePreviewIfEmpty fills empty Codex thread previews only once", (t) => {
  if (spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("sqlite3 binary is not available");
    return;
  }
  const codexHome = tempDir();
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const setup = spawnSync("sqlite3", [dbPath, [
    "CREATE TABLE threads (id TEXT PRIMARY KEY, preview TEXT NOT NULL, archived INTEGER NOT NULL);",
    "INSERT INTO threads VALUES ('thread-empty', '', 0);",
    "INSERT INTO threads VALUES ('thread-existing', '已有 preview', 0);",
  ].join(" ")], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);

  assert.deepEqual(setCodexStatePreviewIfEmpty("thread-empty", "微信 / 主聊天", { codexHome }), {
    ok: true,
    applied: true,
    preview: "微信 / 主聊天",
  });
  assert.deepEqual(setCodexStatePreviewIfEmpty("thread-existing", "不会覆盖", { codexHome }), {
    ok: true,
    applied: false,
    preview: "已有 preview",
  });

  const query = spawnSync("sqlite3", ["-json", dbPath, "SELECT id, preview FROM threads ORDER BY id"], { encoding: "utf8" });
  assert.equal(query.status, 0, query.stderr);
  assert.deepEqual(JSON.parse(query.stdout), [
    { id: "thread-empty", preview: "微信 / 主聊天" },
    { id: "thread-existing", preview: "已有 preview" },
  ]);
});

test("ensureCodexStatePreviewIfEmpty waits until Codex writes the thread row", async (t) => {
  if (spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("sqlite3 binary is not available");
    return;
  }
  const codexHome = tempDir();
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const setup = spawnSync("sqlite3", [dbPath, [
    "CREATE TABLE threads (id TEXT PRIMARY KEY, preview TEXT NOT NULL, archived INTEGER NOT NULL);",
  ].join(" ")], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);

  const timer = setTimeout(() => {
    spawnSync("sqlite3", [dbPath, "INSERT INTO threads VALUES ('thread-delayed', '', 0);"], { encoding: "utf8" });
  }, 20);
  t.after(() => clearTimeout(timer));

  const result = await ensureCodexStatePreviewIfEmpty("thread-delayed", "飞书 / 大龙虾 / 小黄", {
    codexHome,
    attempts: 10,
    retryDelayMs: 10,
  });

  assert.deepEqual(result, {
    ok: true,
    applied: true,
    preview: "飞书 / 大龙虾 / 小黄",
  });
});
