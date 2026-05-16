import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

test("package exposes chat-codex as the main startup command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    name?: string;
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.name, "chat-codex");
  assert.equal(packageJson.bin?.["chat-codex"], "dist/src/cli.js");
  assert.equal(packageJson.bin?.["codex-wechat-bridge"], undefined);
  assert.equal(packageJson.scripts?.["chat-codex"], "npm run build && node dist/src/cli.js");
  assert.equal(packageJson.scripts?.["cli:chat-codex"], "npm run build && node dist/src/cli.js");
  assert.equal(packageJson.scripts?.codex, undefined);
  assert.equal(packageJson.scripts?.["cli:codex"], undefined);
  assert.equal(packageJson.scripts?.["cli:mock"], "npm run build && node dist/src/cli.js test");
  assert.equal(packageJson.scripts?.["cli:serve"], undefined);
  assert.equal(packageJson.scripts?.["cli:weixin:codex"], undefined);
  assert.equal(packageJson.scripts?.["cli:weixin:codex:direct"], undefined);
  assert.equal(packageJson.scripts?.["cli:feishu:status"], "npm run build && node dist/src/cli.js feishu status");
  assert.equal(packageJson.scripts?.["cli:feishu:codex"], undefined);
});

test("CLI help documents the chat-codex main entry", () => {
  const help = execFileSync(process.execPath, ["dist/src/cli.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.match(help, /chat-codex\s+启动统一交互入口/);
  assert.doesNotMatch(help, /codex-wechat-bridge codex/);
});

test("CLI help does not expose single-channel Codex startup entries", () => {
  const help = execFileSync(process.execPath, ["dist/src/cli.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.doesNotMatch(help, /weixin codex/);
  assert.doesNotMatch(help, /weixin codex-direct/);
  assert.doesNotMatch(help, /feishu codex/);
  assert.doesNotMatch(help, /chat-codex serve/);
  assert.doesNotMatch(help, /旧版微信直连入口/);
  assert.doesNotMatch(help, /weixin codex\s+启动真实微信通道 \+ Codex app-server/);
});

test("CLI help documents Feishu private-chat entry", () => {
  const help = execFileSync(process.execPath, ["dist/src/cli.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.match(help, /feishu status\s+查看飞书配置和连接状态/);
});
