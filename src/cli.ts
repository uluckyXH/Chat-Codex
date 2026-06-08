#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Bridge, parseProgressDeliveryMode, type ProgressDeliveryMode } from "./bridge/bridge.js";
import { MockChannelAdapter } from "./channels/mock/mock-channel-adapter.js";
import { TerminalChannelAdapter } from "./channels/terminal/terminal-channel-adapter.js";
import { WeixinAdapter } from "./channels/weixin/weixin-adapter.js";
import { displayWeixinQrCode } from "./channels/weixin/weixin-qr-display.js";
import { checkCodexCli, discoverCodexSessions, displayCodexSessionTitle, findCodexSessionById, formatCodexSessionTitleForDisplay, truncateDisplayText, type CodexCliStatus, type CodexPermissionMode, type CodexRunPolicy, type DiscoveredCodexSession } from "./codex/codex-cli.js";
import { formatCodexCommandSource, formatCodexPlatform } from "./codex/codex-process.js";
import { runServe } from "./cli/serve.js";
import { runFeishuStatus } from "./cli/feishu.js";
import {
  formatAdapterModeForUser,
  formatChannelStatusDetails,
  formatPermissionModeForUser,
  formatProgressModeForUser,
} from "./cli/serve-wizard.js";
import { AppServerCodexAdapter } from "./codex/app-server-codex-adapter.js";
import { ExecCodexAdapter } from "./codex/exec-codex-adapter.js";
import { MockCodexAdapter } from "./codex/mock-codex-adapter.js";
import type { CodexAdapter } from "./codex/types.js";
import { resolveNewSessionWorkdir } from "./codex/workdir.js";
import { ConsoleLogger } from "./logging/logger.js";
import { CHAT_CODEX_DISPLAY_NAME, chatCodexTitle, chatCodexVersion, chatCodexVersionSummary } from "./runtime/package-info.js";
import { formatLocalDateTime } from "./time/display-time.js";

interface StartupOptions {
  session?: string;
  permission?: CodexPermissionMode;
  codexAdapter?: RealCodexAdapterMode;
  yesDangerouslyFull?: boolean;
  cwd?: string;
  progressMode?: ProgressDeliveryMode;
  maxConcurrentTurns?: number;
  noInteractive?: boolean;
  noTui?: boolean;
}

type RealCodexAdapterMode = "app-server" | "exec";

interface PreparedCodexStartup {
  policy: CodexRunPolicy;
  adapterMode: RealCodexAdapterMode;
  sessionId?: string;
  sessionTitle?: string;
  cwd: string;
  codexStatus?: CodexCliStatus;
}

async function main(argv: string[]): Promise<void> {
  const [area, command, ...rest] = argv;
  if (!area) {
    await runServe({});
    return;
  }

  if (area === "--version" || area === "-v") {
    console.log(chatCodexVersion());
    return;
  }

  if (area === "version") {
    console.log(chatCodexVersionSummary());
    return;
  }

  if (area === "help" || area === "--help" || area === "-h") {
    printHelp();
    return;
  }

  if (area.startsWith("--")) {
    await runServe(parseStartupOptions(argv));
    return;
  }

  if (area === "test") {
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
    console.log(formatChannelStatusDetails(await adapter.getStatus(), adapter.getCapabilities()));
    return;
  }

  if (area === "weixin" && command === "login") {
    const adapter = new WeixinAdapter({ verifyCodeProvider: askStdin });
    const started = await adapter.startLogin();
    console.log(started.message);
    if (started.qrCodeText) {
      await displayWeixinQrCode(started.qrCodeText);
    }
    const result = await adapter.waitLogin(started.sessionKey);
    console.log(result.message);
    return;
  }

  if (area === "feishu" && command === "status") {
    await runFeishuStatus();
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
    } else if (arg === "--max-concurrent-turns") {
      const value = args[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--max-concurrent-turns 需要正整数");
      }
      options.maxConcurrentTurns = parsed;
    } else if (arg === "--no-interactive") {
      options.noInteractive = true;
    } else if (arg === "--no-tui") {
      options.noTui = true;
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
  console.log(`- 平台: ${formatCodexPlatform(status)}`);
  console.log(`- CLI: ${status.version ?? status.codexBin}`);
  console.log(`- 路径: ${status.codexBin}`);
  console.log(`- 来源: ${formatCodexCommandSource(status.codexBinSource)}`);
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
      codexStatus: status,
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
  console.log("1. 审批模式 - 使用 workspace-write 沙箱；app-server 可把审批推送到微信 /OK 或 /NO");
  console.log("2. 完全权限 - 跳过审批和沙箱，非常危险");
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
  const title = choice.session ? formatCodexSessionTitleForDisplay(choice.session) : undefined;
  console.log("");
  console.log("已选择已有 Codex 会话");
  console.log(`- Session ID: ${choice.sessionId}`);
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
  if (params.sessionTitle) console.log(`- 标题: ${truncateDisplayText(params.sessionTitle)}`);
  console.log(`- 工作目录: ${params.cwd}`);
  console.log(`- Codex 接入: ${formatAdapterForCli(params.adapterMode)}`);
  console.log(`- 权限模式: ${formatPolicyForCli(params.policy)}`);
  console.log(`- 阶段进度: ${formatProgressForCli(params.progressMode, params.progressDisabled)}`);
}

function printRuntimeSummary(
  title: string,
  startup: PreparedCodexStartup | { policy?: CodexRunPolicy; adapterMode?: RealCodexAdapterMode; sessionId?: string; sessionTitle?: string; cwd: string; codexStatus?: CodexCliStatus },
  progressMode?: ProgressDeliveryMode,
  display: { progressDisabled?: boolean } = {},
): void {
  console.log("");
  console.log(`${title}已启动`);
  console.log(`- 会话: ${startup.sessionId ? `首个聊天绑定 ${startup.sessionId}` : "首条消息自动新建"}`);
  if (startup.sessionTitle) console.log(`- 标题: ${truncateDisplayText(startup.sessionTitle)}`);
  console.log(`- 工作目录: ${startup.cwd}`);
  if (startup.codexStatus) {
    console.log(`- Codex CLI: ${startup.codexStatus.version ?? startup.codexStatus.codexBin}`);
    console.log(`- Codex 路径: ${startup.codexStatus.codexBin}`);
  }
  if (startup.adapterMode) console.log(`- Codex 接入: ${formatAdapterForCli(startup.adapterMode)}`);
  if (startup.policy) console.log(`- 权限模式: ${formatPolicyForCli(startup.policy)}`);
  console.log(`- 阶段进度: ${formatProgressForCli(progressMode, display.progressDisabled)}`);
  console.log("- 退出: Ctrl+C");
}

function formatSessionChoice(index: number, session: DiscoveredCodexSession): string {
  const title = formatCodexSessionTitleForDisplay(session);
  const parts = [`${index}. ${title ?? session.id}`];
  parts.push(`   Session ID: ${session.id}`);
  if (session.updatedAt) parts.push(`   最近更新: ${formatLocalDateTime(session.updatedAt)}`);
  if (session.cwd) parts.push(`   工作目录: ${session.cwd}`);
  return parts.join("\n");
}

function formatPolicyForCli(policy: CodexRunPolicy): string {
  if (policy.permissionMode === "full") return formatPermissionModeForUser(policy.permissionMode);
  return `审批模式（${policy.sandbox ?? "workspace-write"} 沙箱，推荐）`;
}

function formatAdapterForCli(adapterMode: RealCodexAdapterMode): string {
  return formatAdapterModeForUser(adapterMode);
}

function formatProgressForCli(progressMode: ProgressDeliveryMode | undefined, disabled?: boolean): string {
  return formatProgressModeForUser(progressMode, disabled);
}

function createRealCodexAdapter(startup: PreparedCodexStartup | { policy?: CodexRunPolicy; adapterMode?: RealCodexAdapterMode; codexStatus?: CodexCliStatus }): CodexAdapter {
  const runPolicy = startup.policy ?? { permissionMode: "approval", sandbox: "workspace-write" };
  if (startup.adapterMode === "exec") {
    return new ExecCodexAdapter({ runPolicy, codexCommand: startup.codexStatus?.command });
  }
  return new AppServerCodexAdapter({ runPolicy, codexCommand: startup.codexStatus?.command });
}

function printHelp(): void {
  console.log([
    chatCodexTitle(),
    "",
    "Commands:",
    "  chat-codex                         启动统一交互入口（管理渠道并启动 Codex）",
    "  chat-codex version                 查看 Chat-Codex 和 Node.js 版本",
    "  chat-codex test                    运行本地 mock Codex/Channel 流程",
    "  chat-codex terminal mock           启动本地终端通道 + MockCodex",
    "  chat-codex terminal codex          启动本地终端通道 + Codex",
    "",
    "Options:",
    "    -v, --version                   输出版本号",
    "    --session new|last|<id>          设置启动时首个微信私聊预设；不会绑定整个微信账号",
    "    --cwd <dir>, --workdir <dir>     设置新会话工作目录；目录不存在会自动创建",
    "    --permission approval|full       设置安全沙箱或完全权限",
    "    --codex-adapter app-server|exec  设置 Codex 接入方式；默认 app-server，支持微信审批",
    "    --yes-dangerously-full           非交互确认完全权限",
    "    --progress brief|detailed|tools|silent 设置默认进度投递模式；tools 仅在支持结构化工具生命周期的渠道生效",
    "    --max-concurrent-turns <n>       设置全局 Codex turn 并发上限；默认不限制",
    "    --no-tui                        使用普通 prompt 交互，不进入 Ink TUI",
    "    --no-interactive                 非交互启动；需要已有微信登录态",
    "  chat-codex weixin status           查看 WeixinAdapter 当前状态",
    "  chat-codex weixin login            显示终端二维码并等待微信扫码登录",
    "  chat-codex feishu status           查看飞书配置和连接状态",
    "  chat-codex start                   当前等同 terminal mock",
    "",
    `${CHAT_CODEX_DISPLAY_NAME}: ${chatCodexVersion()}`,
  ].join("\n"));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
