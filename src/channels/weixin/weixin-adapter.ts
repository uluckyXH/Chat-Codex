import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelLoginResult,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelTarget,
  SendOptions,
  SendResult,
} from "../../protocol/channel.js";
import { buildRouteKey } from "../../protocol/channel.js";
import { FileWeixinAccountStore, normalizeWeixinAccountId, type StoredWeixinAccount, type WeixinAccountStore } from "./weixin-account-store.js";
import { WeixinApiClient, type WeixinApiClientOptions } from "./weixin-api.js";
import {
  WeixinMessageItemType,
  WeixinMessageState,
  WeixinMessageType,
  type WeixinMessage,
  type WeixinQrStatusResponse,
  type WeixinSendMessageRequest,
} from "./weixin-types.js";

export interface WeixinAdapterOptions {
  sourceVersion?: string;
  accountId?: string;
  baseUrl?: string;
  botType?: string;
  stateDir?: string;
  api?: WeixinApiClient;
  apiOptions?: WeixinApiClientOptions;
  store?: WeixinAccountStore;
  verifyCodeProvider?: (prompt: string) => Promise<string>;
  pollOnStart?: boolean;
  longPollTimeoutMs?: number;
  loginTimeoutMs?: number;
  loginPollIntervalMs?: number;
}

export interface WeixinLoginStartResult extends ChannelLoginResult {
  sessionKey: string;
}

interface ActiveLogin {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  currentBaseUrl: string;
  startedAt: number;
  pendingVerifyCode?: string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";

export class WeixinAdapter implements ChannelAdapter {
  readonly id = "weixin";
  readonly label = "Weixin Adapter";
  private readonly sourceVersion: string;
  private readonly botType: string;
  private readonly baseUrl: string;
  private readonly accountId?: string;
  private readonly api: WeixinApiClient;
  private readonly store: WeixinAccountStore;
  private readonly verifyCodeProvider?: (prompt: string) => Promise<string>;
  private readonly pollOnStart: boolean;
  private readonly longPollTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly loginPollIntervalMs: number;
  private handler?: ChannelMessageHandler;
  private status: ChannelStatus;
  private activeLogin?: ActiveLogin;
  private abortController?: AbortController;
  private pollTask?: Promise<void>;

  constructor(private readonly options: WeixinAdapterOptions = {}) {
    this.sourceVersion = options.sourceVersion ?? "2.4.3";
    this.botType = options.botType ?? DEFAULT_BOT_TYPE;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.accountId = options.accountId;
    this.store = options.store ?? new FileWeixinAccountStore(options.stateDir);
    this.verifyCodeProvider = options.verifyCodeProvider;
    this.api = options.api ?? new WeixinApiClient({
      baseUrl: this.baseUrl,
      channelVersion: this.sourceVersion,
      ...options.apiOptions,
    });
    this.pollOnStart = options.pollOnStart ?? true;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? 35_000;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 480_000;
    this.loginPollIntervalMs = options.loginPollIntervalMs ?? 1000;
    this.status = {
      channelId: this.id,
      state: "login_required",
      details: this.statusDetails("adapter-ready"),
    };
  }

  async start(): Promise<void> {
    const account = this.resolveAccount();
    if (!account) {
      this.status = {
        ...this.status,
        state: "login_required",
        details: this.statusDetails("missing-account"),
      };
      return;
    }
    this.status = {
      ...this.status,
      state: "connected",
      account: account.accountId,
      lastError: undefined,
      details: this.statusDetails("account-loaded"),
    };
    if (this.pollOnStart) {
      this.startPollLoop(account);
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    const account = this.resolveAccount();
    if (account) {
      try {
        await this.api.notifyStop({ token: account.token, timeoutMs: 10_000 });
      } catch {
        // stopping should be best effort
      }
    }
    await this.pollTask?.catch(() => undefined);
    this.status = { ...this.status, state: "stopped" };
  }

  async login(): Promise<ChannelLoginResult> {
    return this.startLogin();
  }

  async startLogin(): Promise<WeixinLoginStartResult> {
    const localTokenList = this.store.listAccountIds()
      .map((id) => this.store.loadAccount(id)?.token)
      .filter((token): token is string => Boolean(token))
      .slice(-10)
      .reverse();
    const qr = await this.api.startQrLogin({ botType: this.botType, localTokenList });
    const sessionKey = this.accountId ?? `login-${Date.now()}`;
    this.activeLogin = {
      sessionKey,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      currentBaseUrl: this.baseUrl,
      startedAt: Date.now(),
    };
    this.status = {
      ...this.status,
      state: "login_required",
      details: this.statusDetails("qr-issued"),
    };
    return {
      state: "login_required",
      message: "请用手机微信扫描二维码链接完成登录。",
      qrCodeText: qr.qrcode_img_content,
      sessionKey,
      details: { sessionKey },
    };
  }

  async waitLogin(sessionKey: string, timeoutMs = this.loginTimeoutMs): Promise<ChannelLoginResult> {
    if (!this.activeLogin || this.activeLogin.sessionKey !== sessionKey) {
      return { state: "login_required", message: "当前没有进行中的登录，请先执行 weixin login。" };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.pollLoginOnce(this.activeLogin);
      if (result) return result;
      await sleep(this.loginPollIntervalMs);
    }
    this.status = { ...this.status, state: "login_required", lastError: "login timeout" };
    return { state: "login_required", message: "登录超时，请重试。" };
  }

  async getStatus(): Promise<ChannelStatus> {
    return this.status;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      text: true,
      media: true,
      typing: true,
      direct: true,
      group: true,
      login: "qr",
      messageUpdate: false,
      streamingHint: true,
    };
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  async sendText(target: ChannelTarget, text: string, _options?: SendOptions): Promise<SendResult> {
    const account = this.resolveAccount(target.accountId);
    if (!account) {
      throw new Error("WeixinAdapter 未登录：请先运行 weixin login");
    }
    const contextToken = typeof target.context?.contextToken === "string" ? target.context.contextToken : undefined;
    const clientId = `codex-weixin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body: WeixinSendMessageRequest = {
      msg: {
        from_user_id: "",
        to_user_id: target.recipient.id || target.conversation.id,
        client_id: clientId,
        message_type: WeixinMessageType.BOT,
        message_state: WeixinMessageState.FINISH,
        item_list: text ? [{ type: WeixinMessageItemType.TEXT, text_item: { text } }] : undefined,
        context_token: contextToken,
      },
    };
    await this.api.sendMessage({ token: account.token, body });
    const deliveredAt = new Date().toISOString();
    this.status = {
      ...this.status,
      state: "connected",
      account: account.accountId,
      lastOutboundAt: deliveredAt,
      lastError: undefined,
    };
    return {
      channelId: this.id,
      messageId: clientId,
      deliveredAt,
      raw: body,
    };
  }

  hasMessageHandler(): boolean {
    return Boolean(this.handler);
  }

  private async pollLoginOnce(login: ActiveLogin): Promise<ChannelLoginResult | undefined> {
    const response = await this.api.getQrStatus({
      qrcode: login.qrcode,
      baseUrl: login.currentBaseUrl,
      verifyCode: login.pendingVerifyCode,
      timeoutMs: 35_000,
    });
    switch (response.status) {
      case "confirmed":
        return this.finishConfirmedLogin(response);
      case "binded_redirect":
        this.activeLogin = undefined;
        this.status = { ...this.status, state: "connected", details: this.statusDetails("already-connected") };
        return { state: "connected", message: "该微信账号已经连接过，无需重复登录。" };
      case "scaned_but_redirect":
        if (response.redirect_host) {
          login.currentBaseUrl = `https://${response.redirect_host}`;
        }
        return undefined;
      case "need_verifycode":
        if (!this.verifyCodeProvider) {
          return { state: "login_required", message: "微信要求输入手机上显示的配对数字，请在支持交互的 CLI 中重新登录。" };
        }
        login.pendingVerifyCode = await this.verifyCodeProvider(
          login.pendingVerifyCode ? "配对数字不匹配，请重新输入：" : "请输入手机微信显示的配对数字：",
        );
        return undefined;
      case "expired":
      case "verify_code_blocked":
        this.activeLogin = undefined;
        this.status = { ...this.status, state: "login_required", lastError: response.status };
        return { state: "login_required", message: `登录未完成: ${response.status}` };
      default:
        return undefined;
    }
  }

  private finishConfirmedLogin(response: WeixinQrStatusResponse): ChannelLoginResult {
    if (!response.bot_token || !response.ilink_bot_id) {
      this.status = { ...this.status, state: "failed", lastError: "confirmed login missing token or account id" };
      return { state: "failed", message: "登录失败：服务端未返回 bot_token 或 ilink_bot_id。" };
    }
    const accountId = normalizeWeixinAccountId(response.ilink_bot_id);
    const account: StoredWeixinAccount = {
      accountId,
      token: response.bot_token,
      baseUrl: response.baseurl || this.baseUrl,
      userId: response.ilink_user_id,
      savedAt: new Date().toISOString(),
    };
    this.store.saveAccount(account);
    this.activeLogin = undefined;
    this.status = {
      ...this.status,
      state: "connected",
      account: account.accountId,
      lastError: undefined,
      details: this.statusDetails("login-confirmed"),
    };
    return { state: "connected", message: `微信登录完成，账号 ${account.accountId} 已保存。` };
  }

  private startPollLoop(account: StoredWeixinAccount): void {
    if (this.pollTask) return;
    const controller = new AbortController();
    this.abortController = controller;
    this.pollTask = this.pollLoop(account, controller.signal).finally(() => {
      this.pollTask = undefined;
    });
  }

  private async pollLoop(account: StoredWeixinAccount, signal: AbortSignal): Promise<void> {
    try {
      await this.api.notifyStart({ token: account.token, timeoutMs: 10_000 });
    } catch {
      // notifyStart is useful but not required to begin polling
    }
    let getUpdatesBuf = account.getUpdatesBuf ?? "";
    while (!signal.aborted) {
      try {
        const response = await this.api.getUpdates({
          token: account.token,
          getUpdatesBuf,
          timeoutMs: this.longPollTimeoutMs,
        });
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(`getupdates failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`);
        }
        if (response.get_updates_buf) {
          getUpdatesBuf = response.get_updates_buf;
          this.store.saveGetUpdatesBuf(account.accountId, getUpdatesBuf);
        }
        for (const raw of response.msgs ?? []) {
          await this.handleInbound(account.accountId, raw);
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.status = { ...this.status, state: "degraded", lastError: message };
        await sleep(2000);
      }
    }
  }

  private async handleInbound(accountId: string, raw: WeixinMessage): Promise<void> {
    if (!this.handler) return;
    const message = weixinMessageToChannelMessage(accountId, raw);
    this.status = {
      ...this.status,
      state: "connected",
      account: accountId,
      lastInboundAt: message.timestamp,
      lastError: undefined,
    };
    await this.handler(message);
  }

  private resolveAccount(accountId = this.accountId): StoredWeixinAccount | undefined {
    if (accountId) return this.store.loadAccount(normalizeWeixinAccountId(accountId));
    return this.store.getDefaultAccount();
  }

  private statusDetails(phase: string): Record<string, unknown> {
    return {
      source: "@tencent-weixin/openclaw-weixin",
      sourceVersion: this.sourceVersion,
      phase,
      runtime: "codex-wechat-middleware",
    };
  }
}

export function weixinMessageToChannelMessage(accountId: string, raw: WeixinMessage): ChannelMessage {
  const senderId = raw.from_user_id || "unknown";
  const conversationKind = raw.group_id ? "group" : "direct";
  const conversationId = raw.group_id || senderId;
  return {
    id: String(raw.message_id ?? raw.client_id ?? raw.seq ?? `weixin-${Date.now()}`),
    routeKey: buildRouteKey({
      channelId: "weixin",
      accountId,
      conversationKind,
      conversationId,
    }),
    channelId: "weixin",
    accountId,
    sender: { id: senderId },
    conversation: { id: conversationId, kind: conversationKind },
    text: textFromWeixinMessage(raw),
    timestamp: new Date(raw.create_time_ms ?? Date.now()).toISOString(),
    raw,
  };
}

function textFromWeixinMessage(raw: WeixinMessage): string | undefined {
  for (const item of raw.item_list ?? []) {
    if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
    if (item.type === WeixinMessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
