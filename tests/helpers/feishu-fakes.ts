import type {
  FeishuApiResponse,
  FeishuCredentials,
  FeishuEventDispatcher,
  FeishuEventHandlers,
  FeishuMessageReceiveEvent,
  FeishuReactionData,
  FeishuSdkClient,
  FeishuSentMessageData,
  FeishuTransportFactory,
  FeishuWsCallbacks,
  FeishuWsClient,
  FeishuWsConnectionStatus,
} from "../../src/channels/feishu/feishu-types.js";
import { Readable } from "node:stream";

export class FakeFeishuClient implements FeishuSdkClient {
  readonly replyPayloads: Array<Parameters<FeishuSdkClient["im"]["message"]["reply"]>[0]> = [];
  readonly createPayloads: Array<Parameters<FeishuSdkClient["im"]["message"]["create"]>[0]> = [];
  readonly imageCreatePayloads: Array<Parameters<FeishuSdkClient["im"]["image"]["create"]>[0]> = [];
  readonly fileCreatePayloads: Array<Parameters<FeishuSdkClient["im"]["file"]["create"]>[0]> = [];
  readonly messageResourceGetPayloads: Array<Parameters<FeishuSdkClient["im"]["messageResource"]["get"]>[0]> = [];
  readonly reactionCreatePayloads: Array<Parameters<FeishuSdkClient["im"]["messageReaction"]["create"]>[0]> = [];
  readonly reactionDeletePayloads: Array<Parameters<FeishuSdkClient["im"]["messageReaction"]["delete"]>[0]> = [];
  readonly userGetPayloads: unknown[] = [];
  probeResponse: FeishuApiResponse<{ pingBotInfo?: { botID?: string; botName?: string } }> = {
    code: 0,
    data: {
      pingBotInfo: {
        botID: "ou_bot",
        botName: "Codex Bot",
      },
    },
  };
  replyResponse: FeishuApiResponse<FeishuSentMessageData> = {
    code: 0,
    data: { message_id: "om_reply", chat_id: "oc_direct" },
  };
  createResponse: FeishuApiResponse<FeishuSentMessageData> = {
    code: 0,
    data: { message_id: "om_create", chat_id: "oc_direct" },
  };
  reactionCreateResponse: FeishuApiResponse<FeishuReactionData> = {
    code: 0,
    data: { reaction_id: "react_typing_1" },
  };
  reactionDeleteResponse: FeishuApiResponse = {
    code: 0,
  };
  imageCreateResponse = {
    image_key: "img_upload",
  };
  fileCreateResponse = {
    file_key: "file_upload",
  };
  resourceBuffers = new Map<string, Buffer>();
  resourceHeaders = new Map<string, Record<string, string>>();
  replyError?: Error;
  imageCreateError?: Error;
  fileCreateError?: Error;
  messageResourceError?: Error;
  reactionCreateError?: Error;
  reactionDeleteError?: Error;

  im = {
    message: {
      reply: async (payload: Parameters<FeishuSdkClient["im"]["message"]["reply"]>[0]): Promise<FeishuApiResponse<FeishuSentMessageData>> => {
        this.replyPayloads.push(payload);
        if (this.replyError) throw this.replyError;
        return this.replyResponse;
      },
      create: async (payload: Parameters<FeishuSdkClient["im"]["message"]["create"]>[0]): Promise<FeishuApiResponse<FeishuSentMessageData>> => {
        this.createPayloads.push(payload);
        return this.createResponse;
      },
    },
    image: {
      create: async (payload: Parameters<FeishuSdkClient["im"]["image"]["create"]>[0]) => {
        this.imageCreatePayloads.push(payload);
        if (this.imageCreateError) throw this.imageCreateError;
        return this.imageCreateResponse;
      },
    },
    file: {
      create: async (payload: Parameters<FeishuSdkClient["im"]["file"]["create"]>[0]) => {
        this.fileCreatePayloads.push(payload);
        if (this.fileCreateError) throw this.fileCreateError;
        return this.fileCreateResponse;
      },
    },
    messageResource: {
      get: async (payload: Parameters<FeishuSdkClient["im"]["messageResource"]["get"]>[0]) => {
        this.messageResourceGetPayloads.push(payload);
        if (this.messageResourceError) throw this.messageResourceError;
        const key = payload.path.file_key;
        const buffer = this.resourceBuffers.get(key) ?? Buffer.from("feishu-resource");
        const headers = this.resourceHeaders.get(key) ?? {};
        return {
          getReadableStream: () => Readable.from(buffer),
          headers,
        };
      },
    },
    messageReaction: {
      create: async (payload: Parameters<FeishuSdkClient["im"]["messageReaction"]["create"]>[0]): Promise<FeishuApiResponse<FeishuReactionData>> => {
        this.reactionCreatePayloads.push(payload);
        if (this.reactionCreateError) throw this.reactionCreateError;
        return this.reactionCreateResponse;
      },
      delete: async (payload: Parameters<FeishuSdkClient["im"]["messageReaction"]["delete"]>[0]): Promise<FeishuApiResponse> => {
        this.reactionDeletePayloads.push(payload);
        if (this.reactionDeleteError) throw this.reactionDeleteError;
        return this.reactionDeleteResponse;
      },
    },
  };

  async request<T = FeishuApiResponse>(): Promise<T> {
    return this.probeResponse as T;
  }

  sentTexts(): string[] {
    return [...this.replyPayloads, ...this.createPayloads].map((payload) => decodeFeishuPostText(payload.data.content));
  }
}

export class FakeFeishuDispatcher implements FeishuEventDispatcher {
  handlers: FeishuEventHandlers = {};

  register(handles: FeishuEventHandlers): this {
    this.handlers = { ...this.handlers, ...handles };
    return this;
  }

  async emitReceive(event: FeishuMessageReceiveEvent): Promise<void> {
    await this.handlers["im.message.receive_v1"]?.(event);
  }
}

export class FakeFeishuWsClient implements FeishuWsClient {
  status: FeishuWsConnectionStatus = {
    state: "idle",
    reconnectAttempts: 0,
  };
  starts = 0;
  closes = 0;

  constructor(private readonly callbacks: FeishuWsCallbacks, private readonly autoReady = true) {}

  async start(_params: { eventDispatcher: FeishuEventDispatcher }): Promise<void> {
    this.starts += 1;
    this.status = {
      state: "connecting",
      reconnectAttempts: 0,
      lastConnectTime: Date.now(),
    };
    if (this.autoReady) {
      this.status = {
        ...this.status,
        state: "connected",
      };
      this.callbacks.onReady?.();
    }
  }

  close(_params?: { force?: boolean }): void {
    this.closes += 1;
    this.status = {
      state: "idle",
      reconnectAttempts: 0,
    };
  }

  getConnectionStatus(): FeishuWsConnectionStatus {
    return this.status;
  }
}

export class FakeFeishuTransportFactory implements FeishuTransportFactory {
  readonly client = new FakeFeishuClient();
  readonly dispatcher = new FakeFeishuDispatcher();
  wsClient?: FakeFeishuWsClient;
  autoReady = true;

  createClient(_credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials): FeishuSdkClient {
    return this.client;
  }

  createDispatcher(_credentials: FeishuCredentials): FeishuEventDispatcher {
    return this.dispatcher;
  }

  createWsClient(
    _credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials,
    callbacks: FeishuWsCallbacks,
  ): FeishuWsClient {
    this.wsClient = new FakeFeishuWsClient(callbacks, this.autoReady);
    return this.wsClient;
  }
}

type FeishuEventOverrides = Omit<Partial<FeishuMessageReceiveEvent>, "sender" | "message"> & {
  sender?: Partial<FeishuMessageReceiveEvent["sender"]>;
  message?: Partial<FeishuMessageReceiveEvent["message"]>;
};

export function sampleFeishuTextEvent(overrides: FeishuEventOverrides = {}): FeishuMessageReceiveEvent {
  const base: FeishuMessageReceiveEvent = {
    event_id: "ev_1",
    event_type: "im.message.receive_v1",
    app_id: "cli_1234567890abcdef",
    sender: {
      sender_id: { open_id: "ou_user" },
      sender_type: "user",
      tenant_key: "tenant",
    },
    message: {
      message_id: "om_in_1",
      create_time: String(Date.now()),
      chat_id: "oc_direct",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "你好 Codex" }),
    },
  };
  return {
    ...base,
    ...overrides,
    sender: {
      ...base.sender,
      ...overrides.sender,
    },
    message: {
      ...base.message,
      ...overrides.message,
    },
  };
}

export function decodeFeishuPostText(content: string): string {
  const parsed = JSON.parse(content) as {
    zh_cn?: {
      content?: Array<Array<{ text?: string }>>;
    };
  };
  return parsed.zh_cn?.content?.flat().map((item) => item.text ?? "").join("") ?? "";
}
