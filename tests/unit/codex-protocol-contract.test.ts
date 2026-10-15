import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { APP_SERVER_PROTOCOL_CAPABILITIES } from "../../src/codex/app-server/protocol-capabilities.js";

const fixtures = path.join(process.cwd(), "tests/fixtures/codex-protocol");
for (const name of ["0.162.1-default", "0.162.1-experimental", "main-bb64b894"]) {
  test(`protocol inventory covers pinned ${name} without a reference checkout`, () => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.json`), "utf8"));
    const keys = APP_SERVER_PROTOCOL_CAPABILITIES.map((entry) => `${entry.direction}:${entry.method}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate classifications");
    for (const [direction, methods] of Object.entries(snapshot.methods) as Array<[string, string[]]>) {
      assert.ok(methods.length >= 10);
      assert.deepEqual(methods.filter((method) => !keys.includes(`${direction}:${method}`)), []);
    }
    assert.match(snapshot.contracts.MessagePhase, /partial_answer/);
    assert.match(snapshot.contracts["v2/ThreadItem.agentMessage"], /questions:/);
    assert.match(snapshot.contracts["v2/ToolRequestUserInputParams"], /isBlocking: boolean/);
    assert.match(snapshot.contracts["v2/ThreadGoalSetParams"], /origin\??:/);
    assert.ok(!snapshot.methods.client_request.includes("thread/rollback"));
  });
}

test("protocol audit detects added and removed methods and changed fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-contract-"));
  try {
    for (const name of ["ClientRequest", "ServerRequest", "ServerNotification"]) {
      fs.writeFileSync(path.join(root, `${name}.ts`), `export type ${name} = { method: "before"; params: unknown };`);
    }
    fs.writeFileSync(path.join(root, "MessagePhase.ts"), 'export type MessagePhase = "final_answer";');
    const args = ["scripts/audit-codex-protocol.mjs", "--schema", root, "--baseline", path.join(root, "baseline.json")];
    assert.equal(spawnSync(process.execPath, [...args, "--write"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
    fs.writeFileSync(path.join(root, "ClientRequest.ts"), 'export type ClientRequest = { "method": "after"; params: unknown };');
    fs.writeFileSync(path.join(root, "MessagePhase.ts"), 'export type MessagePhase = "final_answer" | "partial_answer";');
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /added client_request: after/);
    assert.match(result.stdout, /removed client_request: before/);
    assert.match(result.stdout, /changed contract: MessagePhase/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
