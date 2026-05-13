#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Bridge } from "./bridge/bridge.js";
import { MockChannelAdapter } from "./channels/mock/mock-channel-adapter.js";
import { TerminalChannelAdapter } from "./channels/terminal/terminal-channel-adapter.js";
import { WeixinAdapter } from "./channels/weixin/weixin-adapter.js";
import { ExecCodexAdapter } from "./codex/exec-codex-adapter.js";
import { MockCodexAdapter } from "./codex/mock-codex-adapter.js";
import { ConsoleLogger } from "./logging/logger.js";

async function main(argv: string[]): Promise<void> {
  const [area, command] = argv;
  if (!area || area === "help" || area === "--help" || area === "-h") {
    printHelp();
    return;
  }

  if (area === "codex" && command === "test") {
    await runMockCodexFlow();
    return;
  }

  if (area === "terminal" && (command === "mock" || command === "codex")) {
    await runTerminalBridge(command);
    return;
  }

  if (area === "weixin" && command === "status") {
    const adapter = new WeixinAdapter();
    console.log(JSON.stringify(await adapter.getStatus(), null, 2));
    return;
  }

  if (area === "weixin" && command === "login") {
    const adapter = new WeixinAdapter({ verifyCodeProvider: askStdin });
    const started = await adapter.startLogin();
    console.log(started.message);
    if (started.qrCodeText) {
      console.log(started.qrCodeText);
    }
    const result = await adapter.waitLogin(started.sessionKey);
    console.log(result.message);
    return;
  }

  if (area === "start" || area === "mock") {
    await runTerminalBridge("mock");
    return;
  }

  throw new Error(`未知命令: ${argv.join(" ")}`);
}

async function askStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function runMockCodexFlow(): Promise<void> {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({
    channel,
    codex,
    logger: new ConsoleLogger(false),
    cwd: process.cwd(),
  });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("你好，Codex");
  await channel.emitText("请触发审批 approval");
  const approvalText = channel.sentMessages.find((message) => message.text.includes("Codex 请求审批"))?.text;
  const approvalKey = approvalText?.match(/\[(a[0-9a-z]+)\]/)?.[1];
  if (approvalKey) {
    await channel.emitText(`/approve ${approvalKey}`);
  }
  await channel.emitText("/status");
  await bridge.stop();

  for (const [index, message] of channel.sentMessages.entries()) {
    console.log(`--- mock outbound ${index + 1} ---`);
    console.log(message.text);
  }
}

async function runTerminalBridge(mode: "mock" | "codex"): Promise<void> {
  const channel = new TerminalChannelAdapter();
  const codex = mode === "codex" ? new ExecCodexAdapter() : new MockCodexAdapter();
  const bridge = new Bridge({
    channel,
    codex,
    logger: new ConsoleLogger(false),
    cwd: process.cwd(),
  });

  await bridge.start();
  await channel.waitUntilClosed();
  await bridge.stop();
}

function printHelp(): void {
  console.log([
    "Codex Weixin Middleware",
    "",
    "Commands:",
    "  codex-wechat-bridge codex test     运行本地 mock Codex/Channel 流程",
    "  codex-wechat-bridge terminal mock  启动本地终端通道 + MockCodex",
    "  codex-wechat-bridge terminal codex 启动本地终端通道 + codex exec",
    "  codex-wechat-bridge weixin status  查看 WeixinAdapter 当前状态",
    "  codex-wechat-bridge weixin login   显示第二阶段登录提示",
    "  codex-wechat-bridge start          当前等同 terminal mock",
  ].join("\n"));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
