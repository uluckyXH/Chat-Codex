import fs from "node:fs";
import path from "node:path";
import type { ChannelMedia } from "../protocol/channel.js";

export const BRIDGE_SEND_FILE_PREFIX = "BRIDGE_SEND_FILE:";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg"]);
const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
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

interface MediaCandidate {
  value: string;
  caption?: string;
  explicit?: boolean;
  markdownLink?: boolean;
}

export interface BridgeSendFileExtraction {
  requestedCount: number;
  media: ChannelMedia[];
  invalidRefs: string[];
  overflowCount: number;
}

export function extractMediaRefs(text: string, cwd = process.cwd()): ChannelMedia[] {
  const candidates = [
    ...markdownMediaRefs(text),
    ...mediaDirectiveRefs(text),
    ...labeledFileRefs(text),
    ...bareImageRefs(text),
  ];
  const media: ChannelMedia[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const item = mediaFromCandidate(candidate, cwd);
    if (!item) continue;
    const key = item.path ?? item.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    media.push(item);
  }
  return media;
}

export function extractLocalImageMedia(text: string, cwd: string): ChannelMedia[] {
  return extractMediaRefs(text, cwd).filter((media) => media.type === "image" && Boolean(media.path));
}

export function extractBridgeSendFileRefs(text: string, cwd: string, maxFiles: number): BridgeSendFileExtraction {
  const refs = bridgeSendFileRefs(text);
  const media: ChannelMedia[] = [];
  const invalidRefs: string[] = [];
  let overflowCount = 0;
  const seen = new Set<string>();

  for (const ref of refs) {
    if (media.length >= maxFiles) {
      overflowCount += 1;
      continue;
    }
    if (!path.isAbsolute(ref)) {
      invalidRefs.push(ref);
      continue;
    }
    const item = mediaFromCandidate({ value: ref, explicit: true }, cwd);
    if (!item?.path || !path.isAbsolute(item.path)) {
      invalidRefs.push(ref);
      continue;
    }
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    media.push(item);
  }

  return {
    requestedCount: refs.length,
    media,
    invalidRefs,
    overflowCount,
  };
}

export function stripBridgeSendFileRefs(text: string): string {
  const pattern = new RegExp(`^${BRIDGE_SEND_FILE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
  return text
    .split(/\r?\n/)
    .filter((line) => !pattern.test(line.trimStart()))
    .join("\n")
    .trim();
}

function markdownMediaRefs(text: string): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  const pattern = /(!?)\[([^\]]*)]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[3]);
    const isImage = match[1] === "!";
    if (cleaned) refs.push({
      value: cleaned,
      caption: match[2]?.trim() || undefined,
      explicit: isImage,
      markdownLink: !isImage,
    });
  }
  return refs;
}

function bridgeSendFileRefs(text: string): string[] {
  const refs: string[] = [];
  const pattern = /^\s*BRIDGE_SEND_FILE:\s*(.+?)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) refs.push(cleaned);
  }
  return refs;
}

function mediaDirectiveRefs(text: string): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  const pattern = /^\s*(?:MEDIA|FILE)\s*:\s*(.+?)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) refs.push({ value: cleaned, explicit: true });
  }
  return refs;
}

function labeledFileRefs(text: string): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  const extensionPattern = "pdf|docx?|xlsx?|pptx?|txt|md|csv|json|html?|xml|log|rtf|zip|tar|gz|tgz|7z|rar";
  const pattern = new RegExp(`(?:文件|附件|下载|File|Attachment|Download)\\s*[:：]\\s*(<[^>]+>|[^\\s"'<>]+?\\.(?:${extensionPattern})\\b)`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) refs.push({ value: cleaned, explicit: true });
  }
  return refs;
}

function bareImageRefs(text: string): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  const extensionPattern = "png|jpe?g|gif|webp|bmp|tiff?|svg";
  const pattern = new RegExp([
    `https?://[^\\s"'<>)]*?\\.(?:${extensionPattern})(?:\\?[^\\s"'<>)]*)?`,
    `file://[^\\s"'<>)]*?\\.(?:${extensionPattern})\\b`,
    `/(?:[^\\s"'<>)]*?/)*[^\\s"'<>)]*?\\.(?:${extensionPattern})\\b`,
    `\\.\\.?/(?:[^\\s"'<>)]*?/)*[^\\s"'<>)]*?\\.(?:${extensionPattern})\\b`,
    `(?:[A-Za-z0-9_@%+=:,.-]+/)+[A-Za-z0-9_@%+=:,.-]+\\.(?:${extensionPattern})\\b`,
  ].join("|"), "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[0]);
    if (cleaned) refs.push({ value: cleaned });
  }
  return refs;
}

function cleanRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
    .replace(/^<|>$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/[),.;!?]+$/g, "");
  if (!trimmed) return undefined;
  if (trimmed.startsWith("file://")) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function mediaFromCandidate(candidate: MediaCandidate, cwd: string): ChannelMedia | undefined {
  if (/^https?:\/\//i.test(candidate.value)) {
    return remoteMediaFromUrl(candidate);
  }
  const filePath = resolveMediaPath(candidate.value, cwd);
  if (!filePath) return undefined;
  const ext = path.extname(filePath).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const knownFile = Boolean(EXTENSION_MIME[ext]);
  if (!isImage && !candidate.explicit && !(candidate.markdownLink && knownFile)) return undefined;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    return {
      type: isImage ? "image" : "file",
      path: filePath,
      name: path.basename(filePath),
      mimeType: EXTENSION_MIME[ext] ?? "application/octet-stream",
      sizeBytes: stat.size,
      caption: candidate.caption,
    };
  } catch {
    return undefined;
  }
}

function remoteMediaFromUrl(candidate: MediaCandidate): ChannelMedia | undefined {
  try {
    const url = new URL(candidate.value);
    const ext = path.extname(url.pathname).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const knownFile = Boolean(EXTENSION_MIME[ext]);
    if (!isImage && !candidate.explicit) return undefined;
    if (!isImage && !knownFile) return undefined;
    return {
      type: isImage ? "image" : "file",
      url: url.toString(),
      name: decodeURIComponent(path.basename(url.pathname)),
      mimeType: EXTENSION_MIME[ext] ?? "application/octet-stream",
      caption: candidate.caption,
    };
  } catch {
    return undefined;
  }
}

function resolveMediaPath(value: string, cwd: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return path.isAbsolute(decoded) ? path.normalize(decoded) : path.resolve(cwd, decoded);
  } catch {
    return undefined;
  }
}
