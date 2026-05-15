#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Bridge, parseProgressDeliveryMode, type ProgressDeliveryMode } from "./bridge/bridge.js";
import { MockChannelAdapter } from "./channels/mock/mock-channel-adapter.js";
import { TerminalChannelAdapter } from "./channels/terminal/terminal-channel-adapter.js";
import { WeixinAdapter } from "./channels/weixin/weixin-adapter.js";
import { checkCodexCli, discoverCodexSessions, displayCodexSessionTitle, findCodexSessionById, type CodexPermissionMode, type CodexRunPolicy, type DiscoveredCodexSession } from "./codex/codex-cli.js";
import { AppServerCodexAdapter } from "./codex/app-server-codex-adapter.js";
import { ExecCodexAdapter } from "./codex/exec-codex-adapter.js";
import { MockCodexAdapter } from "./codex/mock-codex-adapter.js";
import type { CodexAdapter } from "./codex/types.js";
import { resolveNewSessionWorkdir } from "./codex/workdir.js";
import { ConsoleLogger } from "./logging/logger.js";
import { ConsoleTranscriptSink } from "./logging/transcript.js";

interface StartupOptions {
  session?: string;
  permission?: CodexPermissionMode;
  codexAdapter?: RealCodexAdapterMode;
  yesDangerouslyFull?: boolean;
  cwd?: string;
  progressMode?: ProgressDeliveryMode;
}

type RealCodexAdapterMode = "app-server" | "exec";

interface PreparedCodexStartup {
  policy: CodexRunPolicy;
  adapterMode: RealCodexAdapterMode;
  sessionId?: string;
  sessionTitle?: string;
  cwd: string;
}

async function main(argv: string[]): Promise<void> {
  const [area, command, ...rest] = argv;
  if (!area || area === "help" || area === "--help" || area === "-h") {
    printHelp();
    return;
  }

  if (area === "codex" && command === "test") {
    await runMockCodexFlow();
    return;
  }

  if (area === "terminal" && (command === "mock" || command === "codex")) {
    await runTerminalBridge(command, parseStartupOptions(rest));
    return;
  }

  if (area === "weixin" && command === "status") {
    const adapter = new WeixinAdapter({ pollOnStart: false });
    await adapter.start();
    console.log(JSON.stringify(await adapter.getStatus(), null, 2));
    return;
  }

  if (area === "weixin" && command === "codex") {
    await runWeixinCodexBridge(parseStartupOptions(rest));
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
    await runTerminalBridge("mock", parseStartupOptions(rest));
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
  await channel.emitText("/OK");
  await channel.emitText("/status");
  await bridge.stop();

  for (const [index, message] of channel.sentMessages.entries()) {
    console.log(`--- mock outbound ${index + 1} ---`);
    console.log(message.text);
  }
}

function parseStartupOptions(args: string[]): StartupOptions {
  const options: StartupOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--session") {
      options.session = args[++index];
    } else if (arg === "--permission") {
      const value = args[++index];
      if (value !== "approval" && value !== "full") {
        throw new Error("--permission 只能是 approval 或 full");
      }
      options.permission = value;
    } else if (arg === "--codex-adapter" || arg === "--adapter") {
      const value = args[++index];
      if (value !== "app-server" && value !== "exec") {
        throw new Error(`${arg} 只能是 app-server 或 exec`);
      }
      options.codexAdapter = value;
    } else if (arg === "--yes-dangerously-full") {
      options.yesDangerouslyFull = true;
    } else if (arg === "--cwd" || arg === "--workdir") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} 需要目录参数`);
      options.cwd = value;
    } else if (arg === "--progress" || arg === "--progress-mode") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} 需要模式参数`);
      const mode = parseProgressDeliveryMode(value);
      if (!mode) throw new Error(`${arg} 只能是 brief、detailed 或 silent`);
      options.progressMode = mode;
    } else {
      throw new Error(`未知启动参数: ${arg}`);
    }
  }
  return options;
}

async function runTerminalBridge(mode: "mock" | "codex", options: StartupOptions = {}): Promise<void> {
  const channel = new TerminalChannelAdapter();
  const startup = mode === "codex" ? await prepareCodexStartup(options) : { policy: undefined, adapterMode: undefined, sessionId: undefined, cwd: process.cwd() };
  const codex = mode === "codex" ? createRealCodexAdapter(startup) : new MockCodexAdapter();
  const bridge = new Bridge({
    channel,
    codex,
    logger: new ConsoleLogger(false),
    cwd: startup.cwd,
    progressMode: options.progressMode,
  });

  await bridge.start();
  if (mode === "codex") {
    printRuntimeSummary("终端 Codex 中间件", startup, options.progressMode);
    if (startup.sessionId) {
      await channel.emitText(`/resume ${startup.sessionId}`);
    } else {
      await channel.emitText("/new");
    }
  }
  await channel.waitUntilClosed();
  await bridge.stop();
}

async function runWeixinCodexBridge(options: StartupOptions = {}): Promise<void> {
  const startup = await prepareCodexStartup(options, { progressDisabled: true });
  const channel = new WeixinAdapter({ verifyCodeProvider: askStdin });
  const codex = createRealCodexAdapter(startup);
  const bridge = new Bridge({
    channel,
    codex,
    logger: new ConsoleLogger(false),
    transcript: new ConsoleTranscriptSink(),
    cwd: startup.cwd,
    initialSessionId: startup.sessionId,
    progressMode: options.progressMode,
  });

  await bridge.start();
  await ensureWeixinLoggedIn(channel);
  printRuntimeSummary("微信 Codex 中间件", startup, options.progressMode, { progressDisabled: true });
  await waitForShutdownSignal();
  await bridge.stop();
}

async function ensureWeixinLoggedIn(channel: WeixinAdapter): Promise<void> {
  let status = await channel.getStatus();
  if (status.state === "connected") {
    console.log(`微信已登录: ${status.account ?? "default"}`);
    return;
  }
  console.log("微信未登录，开始二维码登录。");
  const started = await channel.startLogin();
  console.log(started.message);
  if (started.qrCodeText) {
    console.log(started.qrCodeText);
  }
  const loginResult = await channel.waitLogin(started.sessionKey);
  console.log(loginResult.message);
  if (loginResult.state !== "connected") {
    throw new Error(`微信登录未完成: ${loginResult.message}`);
  }
  await channel.start();
  status = await channel.getStatus();
  if (status.state !== "connected") {
    throw new Error(`微信登录后启动失败: ${status.lastError ?? status.state}`);
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function prepareCodexStartup(
  options: StartupOptions,
  display: { progressDisabled?: boolean } = {},
): Promise<PreparedCodexStartup> {
  const status = await checkCodexCli();
  if (!status.available) {
    throw new Error(`Codex 不可用: ${status.error ?? "unknown error"}`);
  }
  console.log("");
  console.log("Codex 启动准备");
  console.log(`- CLI: ${status.version ?? status.codexBin}`);
  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;
  try {
    const sessions = discoverCodexSessions({ limit: 10 });
    const adapterMode = options.codexAdapter ?? "app-server";
    const sessionChoice = await resolveSessionChoice(options, rl, sessions);
    const cwd = sessionChoice.sessionId
      ? resolveExistingSessionCwd(sessionChoice, options.cwd)
      : await resolveStartupWorkdir(options, rl);
    const permissionMode = await resolvePermissionMode(options, rl);
    const policy: CodexRunPolicy = {
      permissionMode,
      sandbox: permissionMode === "approval" ? "workspace-write" : undefined,
    };
    printStartupSelection({
      sessionId: sessionChoice.sessionId,
      sessionTitle: sessionChoice.session ? displayCodexSessionTitle(sessionChoice.session) : undefined,
      cwd,
      policy,
      adapterMode,
      progressMode: options.progressMode,
      progressDisabled: display.progressDisabled,
    });
    return {
      policy,
      adapterMode,
      sessionId: sessionChoice.sessionId,
      sessionTitle: sessionChoice.session ? displayCodexSessionTitle(sessionChoice.session) : undefined,
      cwd,
    };
  } finally {
    rl?.close();
  }
}

async function resolvePermissionMode(options: StartupOptions, rl?: Interface): Promise<CodexPermissionMode> {
  if (options.permission === "full" && !options.yesDangerouslyFull && !rl) {
    throw new Error("使用完全权限必须显式传入 --yes-dangerously-full");
  }
  if (options.permission === "full") {
    await confirmFullPermission(rl, Boolean(options.yesDangerouslyFull));
    return "full";
  }
  if (options.permission === "approval") return "approval";
  if (!rl) return "approval";
  console.log("");
  console.log("Codex 权限模式（作用于本次启动后的后续任务）");
  console.log("1. approval - 使用 workspace-write sandbox；app-server 可把审批推送到微信 /OK 或 /NO");
  console.log("2. full - 完全权限，跳过审批和沙箱，非常危险");
  const answer = (await rl.question("请选择权限模式 [1]: ")).trim();
  if (answer === "2" || answer.toLowerCase() === "full") {
    await confirmFullPermission(rl, false);
    return "full";
  }
  return "approval";
}

async function confirmFullPermission(rl: Interface | undefined, alreadyConfirmed: boolean): Promise<void> {
  const warning = "警告：完全权限会让 Codex 跳过审批和沙箱，能够直接执行命令并修改文件。只有在你完全信任当前任务时才继续。";
  console.log(warning);
  if (alreadyConfirmed) return;
  if (!rl) throw new Error("完全权限需要交互确认，或传入 --yes-dangerously-full");
  const answer = await rl.question("如确认继续，请输入 YES: ");
  if (answer.trim() !== "YES") {
    throw new Error("已取消完全权限启动");
  }
}

async function resolveSessionChoice(
  options: StartupOptions,
  rl: Interface | undefined,
  sessions: DiscoveredCodexSession[],
): Promise<{ sessionId?: string; session?: DiscoveredCodexSession }> {
  if (options.session && options.session !== "new") {
    if (options.session === "last") {
      return { sessionId: sessions[0]?.id, session: sessions[0] };
    }
    return {
      sessionId: options.session,
      session: sessions.find((session) => session.id === options.session) ?? findCodexSessionById(options.session),
    };
  }
  if (options.session === "new" || !rl) return {};
  console.log("");
  console.log("Codex 会话");
  console.log("0. 创建新的会话记录");
  sessions.forEach((session, index) => {
    console.log(formatSessionChoice(index + 1, session));
  });
  const answer = (await rl.question("请选择会话 [0]: ")).trim();
  if (!answer || answer === "0" || answer.toLowerCase() === "new") return {};
  const index = Number.parseInt(answer, 10);
  if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
    return { sessionId: sessions[index - 1].id, session: sessions[index - 1] };
  }
  return {
    sessionId: answer,
    session: sessions.find((session) => session.id === answer) ?? findCodexSessionById(answer),
  };
}

async function resolveStartupWorkdir(options: StartupOptions, rl?: Interface): Promise<string> {
  const defaultCwd = process.cwd();
  let input = options.cwd;
  if (!input && rl) {
    console.log("");
    console.log(`新 Codex 会话默认工作目录: ${defaultCwd}`);
    input = await rl.question("请输入新会话工作目录 [默认当前目录]: ");
  }
  const resolved = resolveNewSessionWorkdir(input, defaultCwd);
  if (resolved.created) {
    console.log(`工作目录不存在，已创建: ${resolved.cwd}`);
  }
  console.log(`新 Codex 会话工作目录: ${resolved.cwd}`);
  return resolved.cwd;
}

function resolveExistingSessionCwd(
  choice: { sessionId?: string; session?: DiscoveredCodexSession },
  ignoredCwd?: string,
): string {
  if (ignoredCwd) {
    console.log("已选择已有 Codex 会话，启动参数 --cwd/--workdir 将被忽略。");
  }
  const cwd = choice.session?.cwd ?? process.cwd();
  const title = choice.session ? displayCodexSessionTitle(choice.session) : undefined;
  console.log("");
  console.log("已选择已有 Codex 会话");
  console.log(`- Session: ${choice.sessionId}`);
  if (title) console.log(`- 标题: ${title}`);
  if (choice.session?.cwd) {
    console.log(`- 工作目录: ${cwd}`);
  } else {
    console.log(`- 工作目录: ${cwd}（历史记录未提供，暂用当前目录）`);
  }
  return cwd;
}

function printStartupSelection(params: {
  sessionId?: string;
  sessionTitle?: string;
  cwd: string;
  policy: CodexRunPolicy;
  adapterMode: RealCodexAdapterMode;
  progressMode?: ProgressDeliveryMode;
  progressDisabled?: boolean;
}): void {
  console.log("");
  console.log("启动选择");
  console.log(`- 会话: ${params.sessionId ? `恢复 ${params.sessionId}` : "新建"}`);
  if (params.sessionTitle) console.log(`- 标题: ${params.sessionTitle}`);
  console.log(`- 工作目录: ${params.cwd}`);
  console.log(`- Codex Adapter: ${formatAdapterForCli(params.adapterMode)}`);
  console.log(`- 权限: ${formatPolicyForCli(params.policy)}`);
  console.log(`- 进度: ${formatProgressForCli(params.progressMode, params.progressDisabled)}`);
}

function printRuntimeSummary(
  title: string,
  startup: PreparedCodexStartup | { policy?: CodexRunPolicy; adapterMode?: RealCodexAdapterMode; sessionId?: string; sessionTitle?: string; cwd: string },
  progressMode?: ProgressDeliveryMode,
  display: { progressDisabled?: boolean } = {},
): void {
  console.log("");
  console.log(`${title}已启动`);
  console.log(`- 会话: ${startup.sessionId ? `首个聊天绑定 ${startup.sessionId}` : "首条消息自动新建"}`);
  if (startup.sessionTitle) console.log(`- 标题: ${startup.sessionTitle}`);
  console.log(`- 工作目录: ${startup.cwd}`);
  if (startup.adapterMode) console.log(`- Codex Adapter: ${formatAdapterForCli(startup.adapterMode)}`);
  if (startup.policy) console.log(`- 权限: ${formatPolicyForCli(startup.policy)}`);
  console.log(`- 进度: ${formatProgressForCli(progressMode, display.progressDisabled)}`);
  console.log("- 退出: Ctrl+C");
}

function formatSessionChoice(index: number, session: DiscoveredCodexSession): string {
  const title = displayCodexSessionTitle(session);
  const parts = [`${index}. ${title ?? session.id}`];
  parts.push(`   id: ${session.id}`);
  if (session.updatedAt) parts.push(`   updated: ${session.updatedAt}`);
  if (session.cwd) parts.push(`   cwd: ${session.cwd}`);
  return parts.join("\n");
}

function formatPolicyForCli(policy: CodexRunPolicy): string {
  if (policy.permissionMode === "full") {
    return "full（跳过审批和沙箱）";
  }
  return `approval（sandbox=${policy.sandbox ?? "workspace-write"}）`;
}

function formatAdapterForCli(adapterMode: RealCodexAdapterMode): string {
  if (adapterMode === "app-server") return "app-server（支持微信交互审批）";
  return "exec（非交互；不支持微信审批，仅作为回退）";
}

function formatProgressForCli(progressMode: ProgressDeliveryMode | undefined, disabled?: boolean): string {
  return disabled ? "disabled（微信渠道不投递）" : progressMode ?? "brief";
}

function createRealCodexAdapter(startup: PreparedCodexStartup | { policy?: CodexRunPolicy; adapterMode?: RealCodexAdapterMode }): CodexAdapter {
  const runPolicy = startup.policy ?? { permissionMode: "approval", sandbox: "workspace-write" };
  if (startup.adapterMode === "exec") {
    return new ExecCodexAdapter({ runPolicy });
  }
  return new AppServerCodexAdapter({ runPolicy });
}

function printHelp(): void {
  console.log([
    "Codex Weixin Middleware",
    "",
    "Commands:",
    "  codex-wechat-bridge codex test     运行本地 mock Codex/Channel 流程",
    "  codex-wechat-bridge terminal mock  启动本地终端通道 + MockCodex",
    "  codex-wechat-bridge terminal codex 启动本地终端通道 + Codex",
    "    --session new|last|<id>          选择新会话或已有 Codex 会话",
    "    --cwd <dir>, --workdir <dir>     设置新会话工作目录；目录不存在会自动创建",
    "    --permission approval|full       设置安全沙箱或完全权限",
    "    --codex-adapter app-server|exec  设置 Codex 接入方式；默认 app-server，支持微信审批",
    "    --yes-dangerously-full           非交互确认完全权限",
    "    --progress brief|detailed|silent 设置默认进度投递模式（微信渠道固定禁用）",
    "  codex-wechat-bridge weixin codex   启动真实微信通道 + Codex app-server",
    "  codex-wechat-bridge weixin status  查看 WeixinAdapter 当前状态",
    "  codex-wechat-bridge weixin login   显示第二阶段登录提示",
    "  codex-wechat-bridge start          当前等同 terminal mock",
  ].join("\n"));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
