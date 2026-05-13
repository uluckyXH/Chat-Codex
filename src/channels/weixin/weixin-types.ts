export interface WeixinBaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export const WeixinMessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const WeixinMessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const WeixinMessageState = {
  FINISH: 2,
} as const;

export interface WeixinTextItem {
  text?: string;
}

export interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: WeixinTextItem;
  voice_item?: { text?: string };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

export interface WeixinGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeixinQrStartResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface WeixinQrStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface WeixinSendMessageRequest {
  msg?: WeixinMessage;
}
