import fs from "node:fs/promises";
import path from "node:path";
import { saveInboundMedia } from "../../bridge/inbound-media-store.js";
import type { ChannelAttachment, ChannelMedia, ChannelMessage } from "../../protocol/channel.js";
import type { FeishuResourceDownload, FeishuSdkClient } from "./feishu-types.js";

export interface FeishuInboundAttachmentRaw {
  source: "feishu";
  fileKey: string;
  resourceType: "image" | "file";
}

export interface MaterializedFeishuMedia {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
}

export type FeishuUploadFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

export async function downloadFeishuInboundAttachments(params: {
  client: FeishuSdkClient;
  message: ChannelMessage;
  rootDir?: string;
  authorize?: () => boolean;
}): Promise<void> {
  if (!params.message.attachments || params.message.attachments.length === 0) return;
  const nextAttachments: ChannelAttachment[] = [];
  for (const attachment of params.message.attachments) {
    if (params.authorize && !params.authorize()) break;
    nextAttachments.push(await downloadFeishuInboundAttachment(params.client, params.message, attachment, params.rootDir, params.authorize));
  }
  params.message.attachments = nextAttachments;
}

export async function materializeFeishuChannelMedia(media: ChannelMedia): Promise<MaterializedFeishuMedia> {
  if (media.path) {
    return {
      buffer: await fs.readFile(media.path),
      fileName: media.name ?? path.basename(media.path),
      mimeType: media.mimeType,
    };
  }
  if (!media.url) throw new Error("media path or url is required");
  if (!/^https?:\/\//i.test(media.url)) throw new Error(`unsupported media url: ${media.url}`);
  const response = await fetch(media.url);
  if (!response.ok) {
    throw new Error(`fetch media ${response.status}: ${await response.text()}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    fileName: (media.name ?? path.basename(new URL(media.url).pathname)) || "file",
    mimeType: media.mimeType ?? response.headers.get("content-type") ?? undefined,
  };
}

export function feishuFileTypeForName(fileName: string, mimeType?: string): FeishuUploadFileType {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".opus") return "opus";
  if (ext === ".mp4" || mimeType === "video/mp4") return "mp4";
  if (ext === ".pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx") return "doc";
  if (ext === ".xls" || ext === ".xlsx") return "xls";
  if (ext === ".ppt" || ext === ".pptx") return "ppt";
  return "stream";
}

/**
 * Reads the movie-header duration from a normal ISO BMFF/MP4 container.
 * This keeps video delivery self-contained: no ffmpeg or ffprobe process is
 * required just to satisfy Feishu's MP4 upload metadata.
 */
export function parseMp4DurationMs(buffer: Buffer): number | undefined {
  const moov = findIsoBmffBox(buffer, 0, buffer.length, "moov");
  if (!moov) return undefined;
  const mvhd = findIsoBmffBox(buffer, moov.payloadStart, moov.end, "mvhd");
  if (!mvhd || mvhd.payloadStart + 4 > mvhd.end) return undefined;

  const version = buffer.readUInt8(mvhd.payloadStart);
  const base = mvhd.payloadStart + 4; // version + flags
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (base + 28 > mvhd.end) return undefined;
    timescale = buffer.readUInt32BE(base + 16);
    const rawDuration = buffer.readBigUInt64BE(base + 20);
    if (rawDuration > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    duration = Number(rawDuration);
  } else if (version === 0) {
    if (base + 16 > mvhd.end) return undefined;
    timescale = buffer.readUInt32BE(base + 8);
    duration = buffer.readUInt32BE(base + 12);
  } else {
    return undefined;
  }

  if (!Number.isFinite(timescale) || timescale <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return undefined;
  }
  const milliseconds = Math.round((duration / timescale) * 1000);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

export function feishuUploadKey(response: unknown, key: "image_key" | "file_key"): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.trim()) return direct;
  const data = record.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return undefined;
}

interface IsoBmffBox {
  payloadStart: number;
  end: number;
}

function findIsoBmffBox(
  buffer: Buffer,
  start: number,
  end: number,
  expectedType: string,
): IsoBmffBox | undefined {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) return undefined;
      const size64 = buffer.readBigUInt64BE(offset + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      size = Number(size64);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return undefined;
    const box: IsoBmffBox = {
      payloadStart: offset + headerSize,
      end: offset + size,
    };
    if (type === expectedType) return box;
    offset += size;
  }
  return undefined;
}

async function downloadFeishuInboundAttachment(
  client: FeishuSdkClient,
  message: ChannelMessage,
  attachment: ChannelAttachment,
  rootDir?: string,
  authorize?: () => boolean,
): Promise<ChannelAttachment> {
  if (attachment.type !== "image" && attachment.type !== "file") return attachment;
  const raw = feishuAttachmentRaw(attachment);
  if (!raw) {
    return {
      ...attachment,
      downloadState: "unsupported",
      error: "feishu media missing file_key",
    };
  }
  try {
    const resource = await client.im.messageResource.get({
      params: { type: raw.resourceType },
      path: {
        message_id: message.id,
        file_key: raw.fileKey,
      },
    });
    const data = await resourceToBuffer(resource);
    const contentType = headerValue(resource.headers, "content-type");
    if (authorize && !authorize()) throw new Error("群附件接收权限已撤销");
    const saved = await saveInboundMedia({
      message,
      attachment: {
        ...attachment,
        mimeType: attachment.mimeType ?? contentType,
      },
      data,
      rootDir,
    });
    return {
      ...attachment,
      mimeType: saved.mimeType ?? attachment.mimeType ?? contentType,
      sizeBytes: attachment.sizeBytes ?? saved.sizeBytes,
      localPath: saved.localPath,
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

function feishuAttachmentRaw(attachment: ChannelAttachment): FeishuInboundAttachmentRaw | undefined {
  if (!attachment.raw || typeof attachment.raw !== "object") return undefined;
  const raw = attachment.raw as Partial<FeishuInboundAttachmentRaw>;
  if (raw.source !== "feishu") return undefined;
  if (raw.resourceType !== "image" && raw.resourceType !== "file") return undefined;
  if (!raw.fileKey?.trim()) return undefined;
  return {
    source: "feishu",
    fileKey: raw.fileKey,
    resourceType: raw.resourceType,
  };
}

async function resourceToBuffer(resource: FeishuResourceDownload): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of resource.getReadableStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function headerValue(headers: unknown, key: string): string | undefined {
  if (!headers) return undefined;
  const getter = (headers as { get?: (name: string) => string | null | undefined }).get;
  if (typeof getter === "function") return getter.call(headers, key) ?? undefined;
  if (typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const direct = record[key] ?? record[key.toLowerCase()];
  return typeof direct === "string" && direct.trim() ? direct : undefined;
}
