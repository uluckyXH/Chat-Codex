import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelMedia } from "../../protocol/channel.js";
import { WeixinMessageItemType, WeixinUploadMediaType, type WeixinCdnMedia, type WeixinMessageItem } from "./weixin-types.js";
import type { WeixinApiClient } from "./weixin-api.js";

export const DEFAULT_WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".log": "text/plain",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "text/html": ".html",
  "application/xml": ".xml",
  "application/rtf": ".rtf",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/x-7z-compressed": ".7z",
  "application/vnd.rar": ".rar",
};

export interface UploadedWeixinMedia {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

export async function materializeChannelMedia(params: {
  media: ChannelMedia;
  api: WeixinApiClient;
  tempDir?: string;
  timeoutMs?: number;
}): Promise<string> {
  if (params.media.path) return params.media.path;
  if (!params.media.url) throw new Error("media path or url is required");

  const url = params.media.url;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`unsupported media url: ${url}`);
  }
  const downloaded = await params.api.fetchBinary({ url, timeoutMs: params.timeoutMs });
  const tempDir = params.tempDir ?? path.join(os.tmpdir(), "codex-weixin-media");
  await fs.mkdir(tempDir, { recursive: true });
  const ext = extensionFromContentTypeOrUrl(downloaded.contentType, url);
  const filePath = path.join(tempDir, `weixin-media-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  await fs.writeFile(filePath, downloaded.body);
  return filePath;
}

export async function uploadLocalMediaToWeixin(params: {
  api: WeixinApiClient;
  token: string;
  baseUrl?: string;
  filePath: string;
  toUserId: string;
  cdnBaseUrl: string;
  mediaType: keyof typeof WeixinUploadMediaType;
  timeoutMs?: number;
}): Promise<UploadedWeixinMedia> {
  const plaintext = await fs.readFile(params.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const upload = await params.api.getUploadUrl({
    token: params.token,
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    body: {
      filekey,
      media_type: WeixinUploadMediaType[params.mediaType],
      to_user_id: params.toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    },
  });
  const uploadUrl = upload.upload_full_url?.trim() || (upload.upload_param
    ? buildCdnUploadUrl({ cdnBaseUrl: params.cdnBaseUrl, uploadParam: upload.upload_param, filekey })
    : undefined);
  if (!uploadUrl) {
    throw new Error("getuploadurl response missing upload URL");
  }
  const encrypted = encryptAesEcb(plaintext, aeskey);
  const { downloadParam } = await params.api.uploadCdnBuffer({ url: uploadUrl, body: encrypted, timeoutMs: params.timeoutMs });
  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export function buildWeixinImageItem(uploaded: UploadedWeixinMedia): WeixinMessageItem {
  return {
    type: WeixinMessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

export function buildWeixinFileItem(uploaded: UploadedWeixinMedia, fileName: string): WeixinMessageItem {
  return {
    type: WeixinMessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
}

export function mediaTypeForPath(filePath: string): keyof typeof WeixinUploadMediaType {
  const mimeType = mimeFromFilename(filePath);
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  return "FILE";
}

export async function downloadWeixinCdnMedia(params: {
  api: WeixinApiClient;
  media?: WeixinCdnMedia;
  cdnBaseUrl: string;
  aesKey?: string;
  fallbackUrl?: string;
  timeoutMs?: number;
}): Promise<{ body: Buffer; contentType?: string; url: string }> {
  const media = params.media;
  const url = media?.full_url?.trim()
    || params.fallbackUrl?.trim()
    || (media?.encrypt_query_param
      ? buildCdnDownloadUrl({
          cdnBaseUrl: params.cdnBaseUrl,
          encryptedQueryParam: media.encrypt_query_param,
        })
      : undefined);
  if (!url) throw new Error("weixin media missing download url");
  const downloaded = await params.api.fetchBinary({ url, timeoutMs: params.timeoutMs });
  const aesKey = params.aesKey ?? media?.aes_key;
  const shouldDecrypt = Boolean(aesKey) && media?.encrypt_type !== 0;
  const body = shouldDecrypt ? decryptAesEcb(downloaded.body, parseWeixinAesKey(aesKey ?? "")) : downloaded.body;
  return {
    body,
    contentType: downloaded.contentType,
    url,
  };
}

function mimeFromFilename(filename: string): string {
  return EXTENSION_TO_MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function extensionFromContentTypeOrUrl(contentType: string | undefined, url: string): string {
  if (contentType) {
    const normalized = contentType.split(";")[0].trim().toLowerCase();
    const ext = MIME_TO_EXTENSION[normalized];
    if (ext) return ext;
  }
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return EXTENSION_TO_MIME[ext] ? ext : ".bin";
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildCdnUploadUrl(params: { cdnBaseUrl: string; uploadParam: string; filekey: string }): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

function buildCdnDownloadUrl(params: { cdnBaseUrl: string; encryptedQueryParam: string }): string {
  return `${params.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(params.encryptedQueryParam)}`;
}

function parseWeixinAesKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 16) return decoded;
  const decodedText = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }
  throw new Error(`weixin aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`);
}
