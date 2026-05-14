import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractBridgeSendFileRefs, extractMediaRefs, stripBridgeSendFileRefs } from "../../src/bridge/media-extractor.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "media-extractor-test-"));
}

test("extractMediaRefs extracts local images from markdown, absolute, relative, and file URL refs", () => {
  const root = tempDir();
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested, { recursive: true });
  const markdownImage = path.join(root, "markdown.png");
  const absoluteImage = path.join(root, "absolute.jpg");
  const relativeImage = path.join(nested, "relative.webp");
  const fileUrlImage = path.join(root, "file-url.gif");
  fs.writeFileSync(markdownImage, "png");
  fs.writeFileSync(absoluteImage, "jpg");
  fs.writeFileSync(relativeImage, "webp");
  fs.writeFileSync(fileUrlImage, "gif");

  const media = extractMediaRefs([
    "最终截图如下：![结果](./markdown.png)",
    `绝对路径: ${absoluteImage}`,
    "相对路径: nested/relative.webp",
    `file url: ${pathToFileURL(fileUrlImage).toString()}`,
    "不存在文件: ./missing.png",
    `重复引用: ${absoluteImage}`,
  ].join("\n"), root);

  assert.deepEqual(media.map((item) => item.path).sort(), [
    absoluteImage,
    fileUrlImage,
    markdownImage,
    relativeImage,
  ].sort());
  assert.equal(media.find((item) => item.path === markdownImage)?.caption, "结果");
  assert.equal(media.find((item) => item.path === absoluteImage)?.mimeType, "image/jpeg");
  assert.equal(media.find((item) => item.path === markdownImage)?.sizeBytes, 3);
});

test("extractMediaRefs keeps remote markdown image URLs as media URLs", () => {
  const media = extractMediaRefs("远程图：![chart](https://example.com/chart.png?width=800)", process.cwd());

  assert.equal(media.length, 1);
  assert.equal(media[0].url, "https://example.com/chart.png?width=800");
  assert.equal(media[0].name, "chart.png");
  assert.equal(media[0].mimeType, "image/png");
  assert.equal(media[0].caption, "chart");
});

test("extractMediaRefs does not treat ordinary remote markdown links as files", () => {
  const media = extractMediaRefs([
    "普通仓库链接：[ts-rs](https://github.com/Aleph-Alpha/ts-rs)",
    "普通下载链接：[报告](https://example.com/report.pdf)",
  ].join("\n"), process.cwd());

  assert.equal(media.length, 0);
});

test("extractMediaRefs extracts explicitly labeled remote files with known file suffixes", () => {
  const media = extractMediaRefs([
    "FILE: https://example.com/report.pdf",
    "附件：https://example.com/archive.zip",
    "FILE: https://github.com/Aleph-Alpha/ts-rs",
  ].join("\n"), process.cwd());

  assert.deepEqual(media.map((item) => ({ type: item.type, url: item.url, mimeType: item.mimeType, name: item.name })), [
    { type: "file", url: "https://example.com/report.pdf", mimeType: "application/pdf", name: "report.pdf" },
    { type: "file", url: "https://example.com/archive.zip", mimeType: "application/zip", name: "archive.zip" },
  ]);
});

test("extractMediaRefs extracts explicit file attachments without treating bare code paths as files", () => {
  const root = tempDir();
  const reportPath = path.join(root, "report.pdf");
  const dataPath = path.join(root, "data.json");
  const sourcePath = path.join(root, "src", "index.ts");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(reportPath, "pdf");
  fs.writeFileSync(dataPath, "{}");
  fs.writeFileSync(sourcePath, "console.log('not an attachment');");

  const media = extractMediaRefs([
    `报告：[最终报告](./report.pdf)`,
    `FILE:${dataPath}`,
    "普通文件变更摘要: src/index.ts",
  ].join("\n"), root);

  assert.deepEqual(media.map((item) => ({ type: item.type, path: item.path, mimeType: item.mimeType, caption: item.caption })), [
    { type: "file", path: reportPath, mimeType: "application/pdf", caption: "最终报告" },
    { type: "file", path: dataPath, mimeType: "application/json", caption: undefined },
  ]);
});

test("extractBridgeSendFileRefs only extracts explicit bridge send-file markers", () => {
  const root = tempDir();
  const first = path.join(root, "first.png");
  const second = path.join(root, "second.pdf");
  fs.writeFileSync(first, "png");
  fs.writeFileSync(second, "pdf");

  const text = [
    `普通路径不算发送请求: ${first}`,
    `BRIDGE_SEND_FILE: ${first}`,
    `bridge_send_file: ${second}`,
    "BRIDGE_SEND_FILE: ./relative.png",
    "BRIDGE_SEND_FILE: /missing/file.png",
  ].join("\n");

  const extraction = extractBridgeSendFileRefs(text, root, 3);

  assert.equal(extraction.requestedCount, 4);
  assert.deepEqual(extraction.media.map((item) => item.path), [first, second]);
  assert.equal(extraction.invalidRefs.length, 2);
});

test("extractBridgeSendFileRefs caps requested files and strips protocol lines", () => {
  const root = tempDir();
  const files = ["one.png", "two.png", "three.png", "four.png"].map((name) => path.join(root, name));
  for (const file of files) fs.writeFileSync(file, "png");

  const text = [
    "文件如下：",
    ...files.map((file) => `BRIDGE_SEND_FILE: ${file}`),
    "已完成。",
  ].join("\n");

  const extraction = extractBridgeSendFileRefs(text, root, 3);

  assert.equal(extraction.media.length, 3);
  assert.equal(extraction.overflowCount, 1);
  assert.equal(stripBridgeSendFileRefs(text), "文件如下：\n已完成。");
});
