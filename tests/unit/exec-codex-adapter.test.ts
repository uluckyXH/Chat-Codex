import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecCodexAdapter, parseExecJsonLine } from "../../src/codex/exec-codex-adapter.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "exec-codex-test-"));
}

function writeSessionMeta(codexHome: string, id: string, cwd: string): void {
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "14");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `rollout-${id}.jsonl`), `${JSON.stringify({
    timestamp: "2026-05-14T02:00:00Z",
    type: "session_meta",
    payload: { id, cwd, timestamp: "2026-05-14T02:00:00Z" },
  })}\n`, "utf-8");
}

test("parseExecJsonLine reads thread.started event", () => {
  const parsed = parseExecJsonLine(
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
    "local-session",
    "turn-1",
  );

  assert.deepEqual(parsed, { threadId: "thread-123" });
});

test("parseExecJsonLine maps agent message completion", () => {
  const parsed = parseExecJsonLine(
    JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "done" } }),
    "local-session",
    "turn-1",
  );

  assert.deepEqual(parsed?.event, {
    type: "assistant.completed",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "done",
  });
});

test("parseExecJsonLine maps exec progress items", () => {
  assert.deepEqual(parseExecJsonLine(
    JSON.stringify({ type: "item.completed", item: { id: "reasoning-1", type: "reasoning", text: "我先检查项目结构。" } }),
    "local-session",
    "turn-1",
  )?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "我先检查项目结构。",
    kind: "reasoning",
  });

  assert.deepEqual(parseExecJsonLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "reasoning-2",
        item_type: "reasoning",
        summary: [{ text: "我会先确认状态，再执行修复。" }],
      },
    }),
    "local-session",
    "turn-1",
  )?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "我会先确认状态，再执行修复。",
    kind: "reasoning",
  });

  assert.deepEqual(parseExecJsonLine(
    JSON.stringify({ type: "codex_thinking", text: "正在判断下一步。" }),
    "local-session",
    "turn-1",
  )?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "正在判断下一步。",
    kind: "reasoning",
  });

  assert.deepEqual(parseExecJsonLine(
    JSON.stringify({ type: "item.updated", item: { id: "plan-1", type: "plan_update", plan: [{ step: "读取状态" }] } }),
    "local-session",
    "turn-1",
  )?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "计划更新: 读取状态",
    kind: "todo",
  });

  assert.deepEqual(parseExecJsonLine(
    JSON.stringify({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "npm test" } }),
    "local-session",
    "turn-1",
  )?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "正在执行命令: npm test",
    kind: "command",
  });

  assert.deepEqual(parseExecJsonLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: "node screenshot.js",
        aggregated_output: "saved screenshot: /tmp/codex-shot.png\n",
        exit_code: 0,
        status: "completed",
      },
    }),
    "local-session",
    "turn-1",
  )?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "命令完成: node screenshot.js\n输出:\nsaved screenshot: /tmp/codex-shot.png",
    kind: "command",
  });
});

test("ExecCodexAdapter lists sqlite titles for discovered sessions", async (t) => {
  if (spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("sqlite3 binary is not available");
    return;
  }
  const codexHome = tempDir();
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const result = spawnSync("sqlite3", [dbPath, [
    "CREATE TABLE threads (",
    "id TEXT PRIMARY KEY,",
    "title TEXT NOT NULL,",
    "preview TEXT NOT NULL,",
    "first_user_message TEXT NOT NULL,",
    "cwd TEXT NOT NULL,",
    "rollout_path TEXT NOT NULL,",
    "updated_at_ms INTEGER,",
    "updated_at INTEGER NOT NULL,",
    "archived INTEGER NOT NULL",
    ");",
    "INSERT INTO threads VALUES ('thread-title', '标题', '第一条', '第一条', '/tmp/title', '/tmp/rollout.jsonl', 1778716800000, 1778716800, 0);",
  ].join(" ")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const adapter = new ExecCodexAdapter({ codexHome });

  const sessions = await adapter.listSessions();

  assert.equal(sessions.find((session) => session.id === "thread-title")?.title, "标题");
});

test("parseExecJsonLine maps failed events and ignores malformed lines", () => {
  assert.deepEqual(parseExecJsonLine(
    JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    "local-session",
    "turn-1",
  )?.event, {
    type: "turn.failed",
    sessionId: "local-session",
    turnId: "turn-1",
    error: "boom",
  });

  assert.equal(parseExecJsonLine("not-json", "local-session", "turn-1"), undefined);
});

test("ExecCodexAdapter resumes discovered sessions with original cwd", async () => {
  const codexHome = tempDir();
  const cwd = path.join(codexHome, "project");
  fs.mkdirSync(cwd, { recursive: true });
  writeSessionMeta(codexHome, "thread-resume", cwd);
  const adapter = new ExecCodexAdapter({ codexHome });

  const session = await adapter.resumeSession("thread-resume");

  assert.equal(session.id, "thread-resume");
  assert.equal(session.cwd, cwd);
});

test("ExecCodexAdapter lists discovered Codex sessions when route is not scoped", async () => {
  const codexHome = tempDir();
  const cwd = path.join(codexHome, "project");
  writeSessionMeta(codexHome, "thread-history", cwd);
  const adapter = new ExecCodexAdapter({ codexHome });

  const sessions = await adapter.listSessions();

  assert.equal(sessions.some((session) => session.id === "thread-history" && session.cwd === cwd), true);
});

test("ExecCodexAdapter reports non-interactive approval support", () => {
  const adapter = new ExecCodexAdapter();

  const status = adapter.getRunPolicyStatus();

  assert.equal(status.policy.permissionMode, "approval");
  assert.equal(status.interactiveApprovals, false);
  assert.equal(status.effectiveApprovalPolicy, "never");
  assert.match(status.note ?? "", /非交互模式/);
});

test("ExecCodexAdapter scopes run policy per session", async () => {
  const adapter = new ExecCodexAdapter();
  const first = await adapter.startSession({
    routeKey: "route-a",
    cwd: process.cwd(),
    title: "first",
  });
  const second = await adapter.startSession({
    routeKey: "route-b",
    cwd: process.cwd(),
    title: "second",
  });

  adapter.setRunPolicy({ permissionMode: "full" }, first.id);

  assert.equal(adapter.getRunPolicy(first.id).permissionMode, "full");
  assert.equal(adapter.getRunPolicy(second.id).permissionMode, "approval");
  assert.equal(adapter.getRunPolicy().permissionMode, "approval");
});

test("ExecCodexAdapter cancel terminates a running exec task", async () => {
  const root = tempDir();
  const fakeScript = path.join(root, "fake-codex.js");
  const fakeBin = path.join(root, "fake-codex");
  fs.writeFileSync(fakeScript, [
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-cancel' }));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  fs.writeFileSync(fakeBin, [
    "#!/bin/sh",
    `exec "${process.execPath}" "${fakeScript}" "$@"`,
  ].join("\n"));
  fs.chmodSync(fakeBin, 0o755);
  const adapter = new ExecCodexAdapter({ codexBin: fakeBin });
  const session = await adapter.startSession({
    routeKey: "route-a",
    cwd: root,
    title: "cancel-test",
  });
  const events: string[] = [];
  const runPromise = (async () => {
    for await (const event of adapter.run(session.id, "长任务")) {
      events.push(event.type);
    }
  })();

  await waitFor(async () => (await adapter.getStatus(session.id)).type === "running");
  await adapter.cancel(session.id);
  await runPromise;

  assert.deepEqual(events, ["turn.started", "turn.completed"]);
  assert.equal((await adapter.getStatus(session.id)).type, "idle");
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
