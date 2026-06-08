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
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

export const WeixinMessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const WeixinMessageState = {
  FINISH: 2,
} as const;

export const WeixinUploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export interface WeixinTextItem {
  text?: string;
}

export interface WeixinCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface WeixinImageItem {
  media?: WeixinCdnMedia;
  thumb_media?: WeixinCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface WeixinFileItem {
  media?: WeixinCdnMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface WeixinVideoItem {
  media?: WeixinCdnMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: WeixinCdnMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface WeixinToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}

export interface WeixinToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: "completed" | "failed" | "blocked" | "unknown";
}

export interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  text_item?: WeixinTextItem;
  image_item?: WeixinImageItem;
  voice_item?: { text?: string };
  file_item?: WeixinFileItem;
  video_item?: WeixinVideoItem;
  tool_call_start_item?: WeixinToolCallStartItem;
  tool_call_result_item?: WeixinToolCallResultItem;
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
  run_id?: string;
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

export interface WeixinGetConfigRequest {
  ilink_user_id?: string;
  context_token?: string;
}

export interface WeixinGetConfigResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface WeixinSendTypingRequest {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}

export interface WeixinGetUploadUrlRequest {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface WeixinGetUploadUrlResponse {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}
