import type { ChannelMessage } from "../../protocol/channel.js";
import type { Readable } from "node:stream";

export interface FeishuCredentials {
  appId?: string;
  appSecret?: string;
  domain?: string;
  accountId?: string;
  verificationToken?: string;
  encryptKey?: string;
}

export interface FeishuAdapterOptions extends FeishuCredentials {
  id?: string;
  sourceVersion?: string;
  connectOnStart?: boolean;
  probeOnStart?: boolean;
  staleMessageMs?: number;
  dedupTtlMs?: number;
  groupEnabled?: boolean;
  transportFactory?: FeishuTransportFactory;
  now?: () => number;
  inboundMediaRootDir?: string;
  stateDir?: string;
}

export interface FeishuBotIdentity {
  appId?: string;
  botOpenId?: string;
  botName?: string;
}

export interface FeishuProbeResult extends FeishuBotIdentity {
  ok: boolean;
  error?: string;
}

export interface FeishuApiResponse<TData = unknown> {
  code?: number;
  msg?: string;
  data?: TData;
}

export interface FeishuSentMessageData {
  message_id?: string;
  chat_id?: string;
  create_time?: string;
}

export interface FeishuReactionData {
  reaction_id?: string;
}

export interface FeishuImageUploadData {
  image_key?: string;
}

export interface FeishuFileUploadData {
  file_key?: string;
}

export interface FeishuResourceDownload {
  writeFile?: (filePath: string) => Promise<unknown>;
  getReadableStream: () => Readable;
  headers?: unknown;
}

export interface FeishuSdkClient {
  im: {
    message: {
      reply(payload: {
        data: {
          content: string;
          msg_type: string;
          reply_in_thread?: boolean;
          uuid?: string;
        };
        path: {
          message_id: string;
        };
      }): Promise<FeishuApiResponse<FeishuSentMessageData>>;
      create(payload: {
        data: {
          receive_id: string;
          msg_type: string;
          content: string;
          uuid?: string;
        };
        params: {
          receive_id_type: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
        };
      }): Promise<FeishuApiResponse<FeishuSentMessageData>>;
    };
    image: {
      create(payload: {
        data: {
          image_type: "message" | "avatar";
          image: Buffer;
        };
      }): Promise<FeishuImageUploadData | FeishuApiResponse<FeishuImageUploadData> | null>;
    };
    file: {
      create(payload: {
        data: {
          file_type: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
          file_name: string;
          duration?: number;
          file: Buffer;
        };
      }): Promise<FeishuFileUploadData | FeishuApiResponse<FeishuFileUploadData> | null>;
    };
    messageResource: {
      get(payload: {
        params: {
          type: string;
        };
        path: {
          message_id: string;
          file_key: string;
        };
      }): Promise<FeishuResourceDownload>;
    };
    messageReaction: {
      create(payload: {
        path: {
          message_id: string;
        };
        data: {
          reaction_type: {
            emoji_type: string;
          };
        };
      }): Promise<FeishuApiResponse<FeishuReactionData>>;
      delete(payload: {
        path: {
          message_id: string;
          reaction_id: string;
        };
      }): Promise<FeishuApiResponse>;
    };
  };
  request?<T = FeishuApiResponse>(payload: {
    method: string;
    url: string;
    data?: unknown;
  }): Promise<T>;
}

export interface FeishuEventDispatcher {
  register(handles: FeishuEventHandlers): unknown;
}

export interface FeishuWsConnectionStatus {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  lastConnectTime?: number;
  nextConnectTime?: number;
  reconnectAttempts: number;
}

export interface FeishuWsClient {
  start(params: { eventDispatcher: FeishuEventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
  getConnectionStatus?(): FeishuWsConnectionStatus;
}

export interface FeishuWsCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
}

export interface FeishuTransportFactory {
  createClient(credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials): FeishuSdkClient;
  createDispatcher(credentials: FeishuCredentials): FeishuEventDispatcher;
  createWsClient(
    credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials,
    callbacks: FeishuWsCallbacks,
  ): FeishuWsClient;
}

export interface FeishuMessageReceiveEvent {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    sender_name?: string;
    name?: string;
    user_name?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

export type FeishuEventHandlers = Record<string, (data: FeishuMessageReceiveEvent) => Promise<unknown> | unknown>;

export type FeishuMessageMappingResult =
  | { ok: true; message: ChannelMessage }
  | { ok: false; reason: string };

export interface FeishuMessageMappingOptions {
  channelId: string;
  accountId: string;
  botOpenId?: string;
  expectedAppId?: string;
  now?: number;
  staleMessageMs?: number;
}
