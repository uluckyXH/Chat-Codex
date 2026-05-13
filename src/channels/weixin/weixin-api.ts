import crypto from "node:crypto";
import type {
  WeixinBaseInfo,
  WeixinGetUpdatesResponse,
  WeixinQrStartResponse,
  WeixinQrStatusResponse,
  WeixinSendMessageRequest,
} from "./weixin-types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WeixinApiClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  channelVersion?: string;
  botAgent?: string;
  appId?: string;
}

export class WeixinApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly channelVersion: string;
  private readonly botAgent: string;
  private readonly appId: string;

  constructor(options: WeixinApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://ilinkai.weixin.qq.com";
    this.fetchImpl = options.fetch ?? fetch;
    this.channelVersion = options.channelVersion ?? "2.4.3";
    this.botAgent = options.botAgent ?? "CodexWeChatMiddleware/0.1.0";
    this.appId = options.appId ?? "bot";
  }

  async startQrLogin(params: { botType: string; localTokenList?: string[] }): Promise<WeixinQrStartResponse> {
    return this.postJson<WeixinQrStartResponse>({
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType)}`,
      body: { local_token_list: params.localTokenList ?? [] },
    });
  }

  async getQrStatus(params: {
    qrcode: string;
    baseUrl?: string;
    verifyCode?: string;
    timeoutMs?: number;
  }): Promise<WeixinQrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    return this.getJson<WeixinQrStatusResponse>({
      endpoint,
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
    });
  }

  async getUpdates(params: {
    token: string;
    getUpdatesBuf?: string;
    timeoutMs?: number;
  }): Promise<WeixinGetUpdatesResponse> {
    return this.postJson<WeixinGetUpdatesResponse>({
      endpoint: "ilink/bot/getupdates",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        get_updates_buf: params.getUpdatesBuf ?? "",
        base_info: this.baseInfo(),
      },
    });
  }

  async sendMessage(params: {
    token: string;
    body: WeixinSendMessageRequest;
    timeoutMs?: number;
  }): Promise<void> {
    await this.postJson<unknown>({
      endpoint: "ilink/bot/sendmessage",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        ...params.body,
        base_info: this.baseInfo(),
      },
    });
  }

  async notifyStart(params: { token: string; timeoutMs?: number }): Promise<void> {
    await this.postJson<unknown>({
      endpoint: "ilink/bot/msg/notifystart",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: { base_info: this.baseInfo() },
    });
  }

  async notifyStop(params: { token: string; timeoutMs?: number }): Promise<void> {
    await this.postJson<unknown>({
      endpoint: "ilink/bot/msg/notifystop",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: { base_info: this.baseInfo() },
    });
  }

  private async getJson<T>(params: { endpoint: string; baseUrl?: string; timeoutMs?: number }): Promise<T> {
    const response = await this.fetchWithTimeout(this.url(params.endpoint, params.baseUrl), {
      method: "GET",
      headers: this.commonHeaders(),
    }, params.timeoutMs);
    return this.parseJson<T>(response, params.endpoint);
  }

  private async postJson<T>(params: {
    endpoint: string;
    body: unknown;
    token?: string;
    timeoutMs?: number;
  }): Promise<T> {
    const response = await this.fetchWithTimeout(this.url(params.endpoint), {
      method: "POST",
      headers: this.jsonHeaders(params.token),
      body: JSON.stringify(params.body),
    }, params.timeoutMs);
    return this.parseJson<T>(response, params.endpoint);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      return await this.fetchImpl(url, {
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async parseJson<T>(response: Response, label: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private url(endpoint: string, baseUrl = this.baseUrl): string {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(endpoint, base).toString();
  }

  private baseInfo(): WeixinBaseInfo {
    return {
      channel_version: this.channelVersion,
      bot_agent: this.botAgent,
    };
  }

  private jsonHeaders(token?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      ...this.commonHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private commonHeaders(): Record<string, string> {
    return {
      "iLink-App-Id": this.appId,
      "iLink-App-ClientVersion": String(buildClientVersion(this.channelVersion)),
    };
  }
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf-8").toString("base64");
}
