import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelCapabilities,
  ChannelLoginResult,
  ChannelMedia,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelTarget,
  ChannelToolProgress,
  SendOptions,
  SendResult,
} from "../../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../../protocol/delivery-policy.js";
import { saveInboundMedia } from "../../bridge/inbound-media-store.js";
import { buildRouteKey } from "../../protocol/channel.js";
import { FileWeixinAccountStore, normalizeWeixinAccountId, type StoredWeixinAccount, type WeixinAccountStore } from "./weixin-account-store.js";
import { WeixinApiClient, type WeixinApiClientOptions } from "./weixin-api.js";
import {
  WeixinMessageItemType,
  WeixinMessageState,
  WeixinMessageType,
  type WeixinMessageItem,
  type WeixinMessage,
  type WeixinQrStatusResponse,
  type WeixinSendMessageRequest,
} from "./weixin-types.js";
import {
  DEFAULT_WEIXIN_CDN_BASE_URL,
  buildWeixinFileItem,
  buildWeixinImageItem,
  downloadWeixinCdnMedia,
  materializeChannelMedia,
  mediaTypeForPath,
  uploadLocalMediaToWeixin,
} from "./weixin-media.js";

export interface WeixinAdapterOptions {
  id?: string;
  sourceVersion?: string;
  accountId?: string;
  baseUrl?: string;
  botType?: string;
  stateDir?: string;
  api?: WeixinApiClient;
  apiOptions?: WeixinApiClientOptions;
  store?: WeixinAccountStore;
  cdnBaseUrl?: string;
  verifyCodeProvider?: (prompt: string) => Promise<string>;
  pollOnStart?: boolean;
  longPollTimeoutMs?: number;
  loginTimeoutMs?: number;
  loginPollIntervalMs?: number;
  outboundMinIntervalMs?: number;
  outboundMaxRetries?: number;
  outboundRetryBaseDelayMs?: number;
  outboundRequestTimeoutMs?: number;
  mediaRequestTimeoutMs?: number;
  inboundMediaRootDir?: string;
  now?: () => number;
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

interface CachedTypingTicket {
  ticket: string;
  expiresAt: number;
  fetchedAt: number;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const SESSION_EXPIRED_ERRCODE = -14;
const TYPING_TICKET_TTL_MS = 20 * 60 * 1000;
const GETCONFIG_PROBE_INTERVAL_MS = 10_000;
const DEFAULT_OUTBOUND_MIN_INTERVAL_MS = 1200;
const DEFAULT_OUTBOUND_MAX_RETRIES = 2;
const DEFAULT_OUTBOUND_RETRY_BASE_DELAY_MS = 1500;
const DEFAULT_OUTBOUND_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MEDIA_REQUEST_TIMEOUT_MS = 60_000;
const WEIXIN_DELIVERY_POLICY: ChannelDeliveryPolicy = {
  taskStart: "suppress",
  progress: "send",
  toolProgress: "send",
  progressCommand: "enabled",
  defaultProgressMode: "silent",
  refreshCommands: [
    {
      command: "fff",
      description: "微信专用静默刷新命令，不发送回复",
      silent: true,
    },
  ],
};

export class WeixinAdapter implements ChannelAdapter {
  readonly id: string;
  readonly label = "Weixin Adapter";
  private readonly sourceVersion: string;
  private readonly botType: string;
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly accountId?: string;
  private readonly api: WeixinApiClient;
  private readonly store: WeixinAccountStore;
  private readonly verifyCodeProvider?: (prompt: string) => Promise<string>;
  private readonly pollOnStart: boolean;
  private readonly longPollTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly loginPollIntervalMs: number;
  private readonly outboundMinIntervalMs: number;
  private readonly outboundMaxRetries: number;
  private readonly outboundRetryBaseDelayMs: number;
  private readonly outboundRequestTimeoutMs: number;
  private readonly mediaRequestTimeoutMs: number;
  private readonly inboundMediaRootDir?: string;
  private readonly now: () => number;
  private handler?: ChannelMessageHandler;
  private status: ChannelStatus;
  private activeLogin?: ActiveLogin;
  private abortController?: AbortController;
  private pollTask?: Promise<void>;
  private outboundQueue: Promise<void> = Promise.resolve();
  private typingQueue: Promise<void> = Promise.resolve();
  private lastOutboundSentAt = 0;
  private readonly typingTickets = new Map<string, CachedTypingTicket>();

  constructor(private readonly options: WeixinAdapterOptions = {}) {
    this.id = options.id ?? "weixin";
    this.sourceVersion = options.sourceVersion ?? "2.4.4";
    this.botType = options.botType ?? DEFAULT_BOT_TYPE;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_WEIXIN_CDN_BASE_URL;
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
    this.outboundMinIntervalMs = options.outboundMinIntervalMs ?? DEFAULT_OUTBOUND_MIN_INTERVAL_MS;
    this.outboundMaxRetries = options.outboundMaxRetries ?? DEFAULT_OUTBOUND_MAX_RETRIES;
    this.outboundRetryBaseDelayMs = options.outboundRetryBaseDelayMs ?? DEFAULT_OUTBOUND_RETRY_BASE_DELAY_MS;
    this.outboundRequestTimeoutMs = options.outboundRequestTimeoutMs ?? DEFAULT_OUTBOUND_REQUEST_TIMEOUT_MS;
    this.mediaRequestTimeoutMs = options.mediaRequestTimeoutMs ?? DEFAULT_MEDIA_REQUEST_TIMEOUT_MS;
    this.inboundMediaRootDir = options.inboundMediaRootDir;
    this.now = options.now ?? (() => Date.now());
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
    await this.outboundQueue.catch(() => undefined);
    await this.typingQueue.catch(() => undefined);
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
      message: "请用手机微信扫描二维码完成登录。",
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
      let result: ChannelLoginResult | undefined;
      try {
        result = await this.pollLoginOnce(this.activeLogin, Math.max(1, Math.min(35_000, deadline - Date.now())));
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
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
      receiveMedia: true,
      typing: true,
      direct: true,
      group: false,
      thread: false,
      login: "qr",
      messageUpdate: false,
      streamingHint: true,
    };
  }

  getDeliveryPolicy(): ChannelDeliveryPolicy {
    return WEIXIN_DELIVERY_POLICY;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult> {
    const account = this.resolveAccount(target.accountId);
    if (!account) {
      throw new Error("WeixinAdapter 未登录：请先运行 weixin login");
    }
    const clientId = `codex-weixin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body: WeixinSendMessageRequest = {
      msg: {
        from_user_id: "",
        to_user_id: target.recipient.id || target.conversation.id,
        client_id: clientId,
        message_type: WeixinMessageType.BOT,
        message_state: WeixinMessageState.FINISH,
        ...weixinMessageContext(target, options),
        item_list: text ? [{ type: WeixinMessageItemType.TEXT, text_item: { text } }] : undefined,
      },
    };
    await this.sendRawMessage(account, body);
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

  async sendMedia(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult> {
    if (media.type !== "image" && media.type !== "file") {
      throw new Error(`WeixinAdapter 当前只支持图片和文件媒体发送: ${media.type}`);
    }
    const account = this.resolveAccount(target.accountId);
    if (!account) {
      throw new Error("WeixinAdapter 未登录：请先运行 weixin login");
    }
    const filePath = await materializeChannelMedia({ media, api: this.api, timeoutMs: this.mediaRequestTimeoutMs });
    const uploadMediaType = media.type === "file" ? "FILE" : mediaTypeForPath(filePath);
    if (uploadMediaType === "VIDEO") throw new Error(`WeixinAdapter 当前不支持视频媒体发送: ${filePath}`);
    const toUserId = target.recipient.id || target.conversation.id;
    const uploaded = await uploadLocalMediaToWeixin({
      api: this.api,
      token: account.token,
      filePath,
      toUserId,
      cdnBaseUrl: account.cdnBaseUrl ?? this.cdnBaseUrl,
      mediaType: uploadMediaType,
      timeoutMs: this.mediaRequestTimeoutMs,
    });
    const items: WeixinMessageItem[] = [];
    const caption = media.caption?.trim();
    if (caption) items.push({ type: WeixinMessageItemType.TEXT, text_item: { text: caption } });
    items.push(uploadMediaType === "IMAGE"
      ? buildWeixinImageItem(uploaded)
      : buildWeixinFileItem(uploaded, media.name ?? pathBasename(filePath)));

    const result = await this.sendItems(target, account, items, options);
    return {
      ...result,
      raw: { media, uploaded: { filekey: uploaded.filekey, fileSize: uploaded.fileSize } },
    };
  }

  async sendToolProgress(target: ChannelTarget, progress: ChannelToolProgress, options?: SendOptions): Promise<SendResult> {
    const account = this.resolveAccount(target.accountId);
    if (!account) {
      throw new Error("WeixinAdapter 未登录：请先运行 weixin login");
    }
    const now = Date.now();
    const item: WeixinMessageItem = progress.phase === "start"
      ? {
          type: WeixinMessageItemType.TOOL_CALL_START,
          create_time_ms: now,
          update_time_ms: now,
          is_completed: false,
          tool_call_start_item: {
            tool_name: progress.toolName,
            tool_call_id: progress.toolCallId,
          },
        }
      : {
          type: WeixinMessageItemType.TOOL_CALL_RESULT,
          create_time_ms: now,
          update_time_ms: now,
          is_completed: true,
          tool_call_result_item: {
            tool_name: progress.toolName,
            tool_call_id: progress.toolCallId,
            status: progress.status ?? "unknown",
          },
        };
    return this.sendItems(target, account, [item], options);
  }

  async sendTyping(target: ChannelTarget, typing: boolean, _options?: SendOptions): Promise<void> {
    const account = this.resolveAccount(target.accountId);
    if (!account) {
      throw new Error("WeixinAdapter 未登录：请先运行 weixin login");
    }
    const toUserId = target.recipient.id || target.conversation.id;
    if (!toUserId) {
      throw new Error("WeixinAdapter 无法发送 typing：缺少接收方");
    }
    this.enqueueTyping(account, target, toUserId, typing);
  }

  private enqueueTyping(account: StoredWeixinAccount, target: ChannelTarget, toUserId: string, typing: boolean): void {
    this.typingQueue = this.typingQueue
      .then(() => this.sendTypingNow(account, target, toUserId, typing))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.status = {
          ...this.status,
          state: "degraded",
          account: account.accountId,
          lastError: message,
          details: this.statusDetails("typing-failed"),
        };
      });
  }

  private async sendTypingNow(
    account: StoredWeixinAccount,
    target: ChannelTarget,
    toUserId: string,
    typing: boolean,
  ): Promise<void> {
    const ticket = typing
      ? await this.typingTicket(account, target, toUserId, { probe: true })
      : this.cachedTypingTicket(account, target, toUserId);
    if (!ticket) return;
    await this.api.sendTyping({
      token: account.token,
      timeoutMs: 10_000,
      body: {
        ilink_user_id: toUserId,
        typing_ticket: ticket,
        status: typing ? 1 : 2,
      },
    });
  }

  hasMessageHandler(): boolean {
    return Boolean(this.handler);
  }

  private async pollLoginOnce(login: ActiveLogin, timeoutMs = 35_000): Promise<ChannelLoginResult | undefined> {
    const response = await this.api.getQrStatus({
      qrcode: login.qrcode,
      baseUrl: login.currentBaseUrl,
      verifyCode: login.pendingVerifyCode,
      timeoutMs,
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
      cdnBaseUrl: this.cdnBaseUrl,
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
        if (response.ret === SESSION_EXPIRED_ERRCODE || response.errcode === SESSION_EXPIRED_ERRCODE) {
          this.status = {
            ...this.status,
            state: "login_required",
            account: account.accountId,
            lastError: "weixin session expired, login required",
          };
          return;
        }
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(`getupdates failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`);
        }
        if (response.get_updates_buf) {
          getUpdatesBuf = response.get_updates_buf;
          this.store.saveGetUpdatesBuf(account.accountId, getUpdatesBuf);
        }
        for (const raw of response.msgs ?? []) {
          await this.handleInbound(account, raw);
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.status = { ...this.status, state: "degraded", lastError: message };
        await sleep(2000);
      }
    }
  }

  private async handleInbound(account: StoredWeixinAccount, raw: WeixinMessage): Promise<void> {
    if (!this.handler) return;
    const message = weixinMessageToChannelMessage(this.id, account.accountId, raw);
    await this.downloadInboundAttachments(message, account);
    this.status = {
      ...this.status,
      state: "connected",
      account: account.accountId,
      lastInboundAt: message.timestamp,
      lastError: undefined,
    };
    await this.handler(message);
  }

  private async sendItems(
    target: ChannelTarget,
    account: StoredWeixinAccount,
    items: WeixinMessageItem[],
    options?: SendOptions,
  ): Promise<SendResult> {
    let lastClientId = "";
    let lastBody: WeixinSendMessageRequest | undefined;
    for (const item of items) {
      lastClientId = `codex-weixin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body: WeixinSendMessageRequest = {
        msg: {
          from_user_id: "",
          to_user_id: target.recipient.id || target.conversation.id,
          client_id: lastClientId,
          message_type: WeixinMessageType.BOT,
          message_state: WeixinMessageState.FINISH,
          ...weixinMessageContext(target, options),
          item_list: [item],
        },
      };
      await this.sendRawMessage(account, body);
      lastBody = body;
    }
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
      messageId: lastClientId,
      deliveredAt,
      raw: lastBody,
    };
  }

  private resolveAccount(accountId = this.accountId): StoredWeixinAccount | undefined {
    if (accountId) return this.store.loadAccount(normalizeWeixinAccountId(accountId));
    return this.store.getDefaultAccount();
  }

  private async typingTicket(
    account: StoredWeixinAccount,
    target: ChannelTarget,
    toUserId: string,
    options: { probe?: boolean } = {},
  ): Promise<string> {
    const contextToken = typeof target.context?.contextToken === "string" ? target.context.contextToken : undefined;
    const cacheKey = [account.accountId, toUserId, contextToken ?? ""].join(":");
    const cached = this.typingTickets.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      if (!options.probe || now - cached.fetchedAt < GETCONFIG_PROBE_INTERVAL_MS) {
        return cached.ticket;
      }
    }
    const config = await this.api.getConfig({
      token: account.token,
      timeoutMs: 10_000,
      body: {
        ilink_user_id: toUserId,
        context_token: contextToken,
      },
    });
    const ticket = config.typing_ticket?.trim();
    if (!ticket) {
      throw new Error("getconfig response missing typing_ticket");
    }
    const fetchedAt = this.now();
    this.typingTickets.set(cacheKey, {
      ticket,
      fetchedAt,
      expiresAt: fetchedAt + TYPING_TICKET_TTL_MS,
    });
    return ticket;
  }

  private cachedTypingTicket(account: StoredWeixinAccount, target: ChannelTarget, toUserId: string): string | undefined {
    const contextToken = typeof target.context?.contextToken === "string" ? target.context.contextToken : undefined;
    const cacheKey = [account.accountId, toUserId, contextToken ?? ""].join(":");
    const cached = this.typingTickets.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.ticket;
    return undefined;
  }

  private async sendRawMessage(account: StoredWeixinAccount, body: WeixinSendMessageRequest): Promise<void> {
    try {
      await this.enqueueOutbound(async () => {
        await this.sendMessageWithRetry(account, body);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        state: "degraded",
        account: account.accountId,
        lastError: message,
      };
      throw error;
    }
  }

  private async sendMessageWithRetry(account: StoredWeixinAccount, body: WeixinSendMessageRequest): Promise<void> {
    let attempt = 0;
    let requestBody = body;
    let retriedWithoutContextToken = false;
    while (true) {
      try {
        await this.api.sendMessage({ token: account.token, body: requestBody, timeoutMs: this.outboundRequestTimeoutMs });
        return;
      } catch (error) {
        if (
          !retriedWithoutContextToken
          && hasContextToken(requestBody)
          && attempt >= this.outboundMaxRetries
          && isContextTokenFallbackSendError(error)
        ) {
          retriedWithoutContextToken = true;
          requestBody = withoutContextToken(requestBody);
          attempt = 0;
          const message = error instanceof Error ? error.message : String(error);
          this.status = {
            ...this.status,
            state: "degraded",
            account: account.accountId,
            lastError: `sendmessage retry without context_token after: ${message}`,
            details: this.statusDetails("sendmessage-context-fallback"),
          };
          continue;
        }
        if (attempt >= this.outboundMaxRetries || !isRetryableSendMessageError(error)) {
          throw error;
        }
        const delayMs = retryDelayMs(this.outboundRetryBaseDelayMs, attempt);
        const message = error instanceof Error ? error.message : String(error);
        this.status = {
          ...this.status,
          state: "degraded",
          account: account.accountId,
          lastError: `sendmessage retry ${attempt + 1}/${this.outboundMaxRetries} after ${delayMs}ms: ${message}`,
          details: this.statusDetails("sendmessage-retry"),
        };
        attempt += 1;
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }

  private enqueueOutbound<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.outboundQueue.catch(() => undefined).then(async () => {
      await this.waitForOutboundPace();
      try {
        return await operation();
      } finally {
        this.lastOutboundSentAt = Date.now();
      }
    });
    this.outboundQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async waitForOutboundPace(): Promise<void> {
    if (this.outboundMinIntervalMs <= 0 || this.lastOutboundSentAt <= 0) return;
    const waitMs = this.outboundMinIntervalMs - (Date.now() - this.lastOutboundSentAt);
    if (waitMs > 0) await sleep(waitMs);
  }

  private statusDetails(phase: string): Record<string, unknown> {
    return {
      source: "@tencent-weixin/openclaw-weixin",
      sourceVersion: this.sourceVersion,
      phase,
      runtime: "codex-wechat-middleware",
      outboundMinIntervalMs: this.outboundMinIntervalMs,
      outboundMaxRetries: this.outboundMaxRetries,
      outboundRequestTimeoutMs: this.outboundRequestTimeoutMs,
      mediaRequestTimeoutMs: this.mediaRequestTimeoutMs,
    };
  }

  private async downloadInboundAttachments(message: ChannelMessage, account: StoredWeixinAccount): Promise<void> {
    if (!message.attachments || message.attachments.length === 0) return;
    const nextAttachments: ChannelAttachment[] = [];
    for (const attachment of message.attachments) {
      nextAttachments.push(await this.downloadInboundAttachment(message, attachment, account));
    }
    message.attachments = nextAttachments;
  }

  private async downloadInboundAttachment(
    message: ChannelMessage,
    attachment: ChannelAttachment,
    account: StoredWeixinAccount,
  ): Promise<ChannelAttachment> {
    const raw = attachment.raw && typeof attachment.raw === "object" ? attachment.raw as WeixinInboundAttachmentRaw : undefined;
    if (!raw?.media && !raw?.fallbackUrl) {
      return {
        ...attachment,
        downloadState: "unsupported",
        error: "weixin media missing download metadata",
      };
    }
    try {
      const downloaded = await downloadWeixinCdnMedia({
        api: this.api,
        media: raw.media,
        aesKey: raw.aesKey,
        fallbackUrl: raw.fallbackUrl,
        cdnBaseUrl: account.cdnBaseUrl ?? this.cdnBaseUrl,
        timeoutMs: this.mediaRequestTimeoutMs,
      });
      const saved = await saveInboundMedia({
        message,
        attachment: {
          ...attachment,
          mimeType: attachment.mimeType ?? downloaded.contentType,
        },
        data: downloaded.body,
        rootDir: this.inboundMediaRootDir,
      });
      return {
        ...attachment,
        mimeType: saved.mimeType ?? attachment.mimeType ?? downloaded.contentType,
        sizeBytes: attachment.sizeBytes ?? saved.sizeBytes,
        localPath: saved.localPath,
        url: downloaded.url,
        downloadState: "available",
        error: undefined,
      };
    } catch (error) {
      return {
        ...attachment,
        downloadState: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function isRetryableSendMessageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bret=(-1|-2)\b/.test(message)
    || /errcode=(45009|45011|45047|45048)\b/.test(message)
    || /\b(429|500|502|503|504)\b/.test(message)
    || /rate.?limit|too many|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

function isContextTokenFallbackSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bret=-2\b/.test(message);
}

function hasContextToken(body: WeixinSendMessageRequest): boolean {
  return typeof body.msg?.context_token === "string" && body.msg.context_token.length > 0;
}

function withoutContextToken(body: WeixinSendMessageRequest): WeixinSendMessageRequest {
  return {
    ...body,
    msg: body.msg ? { ...body.msg, context_token: undefined } : undefined,
  };
}

function weixinMessageContext(target: ChannelTarget, options?: SendOptions): Pick<WeixinMessage, "context_token" | "run_id"> {
  const contextToken = stringContextValue(target, "contextToken");
  const runId = options?.correlationId ?? stringContextValue(target, "runId");
  return {
    ...(contextToken ? { context_token: contextToken } : {}),
    ...(runId ? { run_id: runId } : {}),
  };
}

function stringContextValue(target: ChannelTarget, key: string): string | undefined {
  const value = target.context?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function retryDelayMs(baseDelayMs: number, attempt: number): number {
  if (baseDelayMs <= 0) return 0;
  return baseDelayMs * (2 ** attempt);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function weixinMessageToChannelMessage(channelId: string, accountId: string, raw: WeixinMessage): ChannelMessage {
  const senderId = raw.from_user_id || "unknown";
  const conversationKind = raw.group_id ? "group" : "direct";
  const conversationId = raw.group_id || senderId;
  return {
    id: String(raw.message_id ?? raw.client_id ?? raw.seq ?? `weixin-${Date.now()}`),
    routeKey: buildRouteKey({
      channelId,
      accountId,
      conversationKind,
      conversationId,
    }),
    channelId,
    accountId,
    sender: { id: senderId },
    conversation: { id: conversationId, kind: conversationKind },
    text: textFromWeixinMessage(raw),
    attachments: attachmentsFromWeixinMessage(raw),
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

interface WeixinInboundAttachmentRaw {
  media?: NonNullable<WeixinMessageItem["image_item"]>["media"] | NonNullable<WeixinMessageItem["file_item"]>["media"];
  aesKey?: string;
  fallbackUrl?: string;
}

function attachmentsFromWeixinMessage(raw: WeixinMessage): ChannelAttachment[] | undefined {
  const attachments: ChannelAttachment[] = [];
  for (const [index, item] of (raw.item_list ?? []).entries()) {
    if (item.type === WeixinMessageItemType.IMAGE && item.image_item) {
      const attachmentId = String(item.msg_id ?? `image-${index}`);
      attachments.push({
        id: attachmentId,
        type: "image",
        name: `weixin-image-${attachmentId}`,
        sizeBytes: firstPositiveNumber(item.image_item.hd_size, item.image_item.mid_size, item.image_item.thumb_size),
        url: item.image_item.media?.full_url ?? item.image_item.url,
        raw: {
          media: item.image_item.media,
          aesKey: item.image_item.aeskey ? Buffer.from(item.image_item.aeskey, "hex").toString("base64") : item.image_item.media?.aes_key,
          fallbackUrl: item.image_item.url,
        } satisfies WeixinInboundAttachmentRaw,
      });
    } else if (item.type === WeixinMessageItemType.FILE && item.file_item) {
      const attachmentId = String(item.msg_id ?? item.file_item.file_name ?? `file-${index}`);
      attachments.push({
        id: attachmentId,
        type: "file",
        name: item.file_item.file_name ?? `weixin-file-${attachmentId}`,
        sizeBytes: parseOptionalInteger(item.file_item.len),
        url: item.file_item.media?.full_url,
        raw: {
          media: item.file_item.media,
          aesKey: item.file_item.media?.aes_key,
        } satisfies WeixinInboundAttachmentRaw,
      });
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

function firstPositiveNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.at(-1) || "file";
}
