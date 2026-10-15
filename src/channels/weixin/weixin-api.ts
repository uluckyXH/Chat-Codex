import crypto from "node:crypto";
import { parseWeixinApiJson } from "./weixin-json.js";
import { WeixinNetworkError } from "./weixin-network-error.js";
import { WEIXIN_PROTOCOL_VERSION } from "./weixin-types.js";
import { chatCodexVersion } from "../../runtime/package-info.js";
import type {
  WeixinBaseInfo,
  WeixinGetConfigRequest,
  WeixinGetConfigResponse,
  WeixinGetUpdatesResponse,
  WeixinGetUploadUrlRequest,
  WeixinGetUploadUrlResponse,
  WeixinQrStartResponse,
  WeixinQrStatusResponse,
  WeixinSendMessageRequest,
  WeixinSendMessageResponse,
  WeixinSendTypingRequest,
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
    this.channelVersion = options.channelVersion ?? WEIXIN_PROTOCOL_VERSION;
    this.botAgent = options.botAgent ?? `Chat-Codex/${chatCodexVersion()}`;
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
    baseUrl?: string;
    getUpdatesBuf?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<WeixinGetUpdatesResponse> {
    try {
      return await this.postJson<WeixinGetUpdatesResponse>({
        endpoint: "ilink/bot/getupdates",
        baseUrl: params.baseUrl,
        token: params.token,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        body: {
          get_updates_buf: params.getUpdatesBuf ?? "",
          base_info: this.baseInfo(),
        },
      });
    } catch (error) {
      if (!isAbortError(error) || params.signal?.aborted) throw error;
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: params.getUpdatesBuf,
      };
    }
  }

  async sendMessage(params: {
    token: string;
    baseUrl?: string;
    body: WeixinSendMessageRequest;
    timeoutMs?: number;
  }): Promise<WeixinSendMessageResponse> {
    const response = await this.postJson<WeixinSendMessageResponse>({
      endpoint: "ilink/bot/sendmessage",
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        ...params.body,
        base_info: this.baseInfo(),
      },
    });
    assertWeixinApiSuccess(response, "sendmessage");
    return response;
  }

  async getUploadUrl(params: {
    token: string;
    baseUrl?: string;
    body: WeixinGetUploadUrlRequest;
    timeoutMs?: number;
  }): Promise<WeixinGetUploadUrlResponse> {
    const response = await this.postJson<WeixinGetUploadUrlResponse & WeixinApiResponse>({
      endpoint: "ilink/bot/getuploadurl",
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        ...params.body,
        base_info: this.baseInfo(),
      },
    });
    assertWeixinApiSuccess(response, "getuploadurl");
    return response;
  }

  async getConfig(params: {
    token: string;
    baseUrl?: string;
    body: WeixinGetConfigRequest;
    timeoutMs?: number;
  }): Promise<WeixinGetConfigResponse> {
    const response = await this.postJson<WeixinGetConfigResponse>({
      endpoint: "ilink/bot/getconfig",
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        ...params.body,
        base_info: this.baseInfo(),
      },
    });
    assertWeixinApiSuccess(response, "getconfig");
    return response;
  }

  async sendTyping(params: {
    token: string;
    baseUrl?: string;
    body: WeixinSendTypingRequest;
    timeoutMs?: number;
  }): Promise<void> {
    const response = await this.postJson<WeixinGetConfigResponse>({
      endpoint: "ilink/bot/sendtyping",
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        ...params.body,
        base_info: this.baseInfo(),
      },
    });
    assertWeixinApiSuccess(response, "sendtyping");
  }

  async uploadCdnBuffer(params: {
    url: string;
    body: Buffer;
    timeoutMs?: number;
  }): Promise<{ downloadParam: string }> {
    const response = await this.fetchWithTimeout(params.url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(params.body),
    }, params.timeoutMs);
    if (response.status >= 400) {
      const text = await response.text();
      throw new Error(`cdn upload ${response.status}: ${text}`);
    }
    const downloadParam = response.headers.get("x-encrypted-param");
    if (!downloadParam) {
      throw new Error("cdn upload response missing x-encrypted-param header");
    }
    return { downloadParam };
  }

  async fetchBinary(params: {
    url: string;
    timeoutMs?: number;
  }): Promise<{ body: Buffer; contentType?: string }> {
    const response = await this.fetchWithTimeout(params.url, {
      method: "GET",
    }, params.timeoutMs);
    if (!response.ok) {
      throw new Error(`fetch binary ${response.status}: ${await response.text()}`);
    }
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async notifyStart(params: { token: string; baseUrl?: string; timeoutMs?: number }): Promise<void> {
    await this.postJson<unknown>({
      endpoint: "ilink/bot/msg/notifystart",
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: { base_info: this.baseInfo() },
    });
  }

  async notifyStop(params: { token: string; baseUrl?: string; timeoutMs?: number }): Promise<void> {
    await this.postJson<unknown>({
      endpoint: "ilink/bot/msg/notifystop",
      baseUrl: params.baseUrl,
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
    baseUrl?: string;
    body: unknown;
    token?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    const response = await this.fetchWithTimeout(this.url(params.endpoint, params.baseUrl), {
      method: "POST",
      headers: this.jsonHeaders(params.token),
      body: JSON.stringify(params.body),
    }, params.timeoutMs, params.signal);
    return this.parseJson<T>(response, params.endpoint);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs?: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutController = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
    const timer = timeoutController ? setTimeout(() => timeoutController.abort(), timeoutMs) : undefined;
    const { signal, cleanup } = combineAbortSignals(timeoutController, externalSignal ?? init.signal ?? undefined);
    try {
      return await this.fetchImpl(url, {
        ...init,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new WeixinNetworkError(error);
    } finally {
      if (timer) clearTimeout(timer);
      cleanup();
    }
  }

  private async parseJson<T>(response: Response, label: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${text}`);
    }
    return text ? parseWeixinApiJson<T>(text) : {} as T;
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

function combineAbortSignals(
  timeoutController: AbortController | undefined,
  externalSignal: AbortSignal | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  if (!timeoutController) {
    return { signal: externalSignal, cleanup: () => undefined };
  }
  if (!externalSignal) {
    return { signal: timeoutController.signal, cleanup: () => undefined };
  }
  if (externalSignal.aborted) {
    timeoutController.abort();
    return { signal: timeoutController.signal, cleanup: () => undefined };
  }
  const abort = () => timeoutController.abort();
  externalSignal.addEventListener("abort", abort, { once: true });
  return {
    signal: timeoutController.signal,
    cleanup: () => externalSignal.removeEventListener("abort", abort),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

interface WeixinApiResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

function assertWeixinApiSuccess(response: WeixinApiResponse | undefined, label: string): void {
  const ret = response?.ret ?? 0;
  const errcode = response?.errcode ?? 0;
  if (ret !== 0 || errcode !== 0) {
    throw new Error(`${label} failed: ret=${ret} errcode=${errcode} ${response?.errmsg ?? ""}`.trim());
  }
}
