import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuAdapter } from "../../src/channels/feishu/feishu-adapter.js";
import type { ChannelApprovalRequest } from "../../src/protocol/channel.js";
import {
  FakeFeishuTransportFactory,
  sampleFeishuCardActionEvent,
  sampleFeishuTextEvent,
} from "../helpers/feishu-fakes.js";

const credentials = {
  appId: "cli_1234567890abcdef",
  appSecret: "test-secret",
  accountId: "work",
};

test("FeishuAdapter reports login_required when credentials are missing", async () => {
  const adapter = new FeishuAdapter({ transportFactory: new FakeFeishuTransportFactory() });

  await adapter.start();
  const status = await adapter.getStatus();

  assert.equal(status.state, "login_required");
  assert.match(status.lastError ?? "", /FEISHU_APP_ID/);
  assert.equal(status.details?.appSecret, "未配置");
});

test("FeishuAdapter starts websocket and declares private media capabilities", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });

  await adapter.start();

  assert.equal((await adapter.getStatus()).state, "connected");
  assert.equal(factory.wsClient?.starts, 1);
  assert.deepEqual(adapter.getDeliveryPolicy().allowedProgressModes, ["realtime", "silent", "brief", "actions"]);
  assert.equal(adapter.getDeliveryPolicy().realtimeProgress, "send");
  assert.equal(adapter.getDeliveryPolicy().toolProgress, "send");
  assert.equal(adapter.getDeliveryPolicy().defaultProgressMode, "brief");
  assert.deepEqual(adapter.getCapabilities(), {
    text: true,
    media: true,
    receiveMedia: true,
    typing: true,
    direct: true,
    group: false,
    thread: false,
    login: "token",
    messageUpdate: false,
    streamingHint: true,
  });
});

test("FeishuAdapter downloads inbound image resources before emitting ChannelMessage", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: uploadRoot });
  const received: Array<{ localPath?: string; downloadState?: string }> = [];
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  factory.client.resourceBuffers.set("img_in_1", imageBytes);
  factory.client.resourceHeaders.set("img_in_1", { "content-type": "image/png" });
  adapter.onMessage(async (message) => {
    const attachment = message.attachments?.[0];
    received.push({
      localPath: attachment?.localPath,
      downloadState: attachment?.downloadState,
    });
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_img",
      chat_id: "oc_user",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_in_1" }),
    },
  }));

  assert.equal(factory.client.messageResourceGetPayloads.length, 1);
  assert.deepEqual(factory.client.messageResourceGetPayloads[0], {
    params: { type: "image" },
    path: { message_id: "om_img", file_key: "img_in_1" },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].downloadState, "available");
  assert.ok(received[0].localPath?.startsWith(uploadRoot));
  assert.deepEqual(fs.readFileSync(received[0].localPath ?? ""), imageBytes);
});

test("FeishuAdapter downloads inbound file resources before emitting ChannelMessage", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: uploadRoot });
  const fileBytes = Buffer.from("report");
  factory.client.resourceBuffers.set("file_in_1", fileBytes);
  factory.client.resourceHeaders.set("file_in_1", { "content-type": "application/pdf" });
  let localPath = "";
  let downloadState = "";
  adapter.onMessage(async (message) => {
    const attachment = message.attachments?.[0];
    localPath = attachment?.localPath ?? "";
    downloadState = attachment?.downloadState ?? "";
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_file",
      chat_id: "oc_user",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_in_1", file_name: "report.pdf", file_size: fileBytes.length }),
    },
  }));

  assert.deepEqual(factory.client.messageResourceGetPayloads[0], {
    params: { type: "file" },
    path: { message_id: "om_file", file_key: "file_in_1" },
  });
  assert.equal(downloadState, "available");
  assert.ok(localPath.startsWith(uploadRoot));
  assert.deepEqual(fs.readFileSync(localPath), fileBytes);
});

test("FeishuAdapter marks inbound resource download failures on attachment", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.messageResourceError = new Error("resource denied");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: tempDir("codex-feishu-upload-") });
  let downloadState = "";
  let error = "";
  adapter.onMessage(async (message) => {
    downloadState = message.attachments?.[0]?.downloadState ?? "";
    error = message.attachments?.[0]?.error ?? "";
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_img_failed",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_failed" }),
    },
  }));

  assert.equal(downloadState, "failed");
  assert.match(error, /resource denied/);
});

test("FeishuAdapter uploads and sends image and file media", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  const dir = tempDir("codex-feishu-send-");
  const imagePath = path.join(dir, "shot.png");
  const filePath = path.join(dir, "report.pdf");
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  fs.writeFileSync(filePath, Buffer.from("pdf"));
  await adapter.start();
  const target = {
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" as const },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  };

  await adapter.sendMedia(target, { type: "image", path: imagePath, name: "shot.png", caption: "截图" });
  await adapter.sendMedia(target, { type: "file", path: filePath, name: "report.pdf", mimeType: "application/pdf" });

  assert.equal(factory.client.imageCreatePayloads.length, 1);
  assert.deepEqual(factory.client.imageCreatePayloads[0].data.image, Buffer.from([1, 2, 3]));
  assert.equal(factory.client.fileCreatePayloads.length, 1);
  assert.equal(factory.client.fileCreatePayloads[0].data.file_type, "pdf");
  assert.equal(factory.client.fileCreatePayloads[0].data.file_name, "report.pdf");
  const msgTypes = factory.client.replyPayloads.map((payload) => payload.data.msg_type);
  assert.deepEqual(msgTypes, ["post", "image", "file"]);
  assert.deepEqual(factory.client.replyPayloads.map((payload) => JSON.parse(payload.data.content)), [
    { zh_cn: { content: [[{ tag: "md", text: "截图" }]] } },
    { image_key: "img_upload" },
    { file_key: "file_upload" },
  ]);
});

test("FeishuAdapter sends a direct-chat MP4 as Feishu media with its parsed duration", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  const dir = tempDir("codex-feishu-video-send-");
  const videoPath = path.join(dir, "demo.mp4");
  const video = mp4WithDuration(5_000);
  fs.writeFileSync(videoPath, video);
  await adapter.start();

  await adapter.sendMedia({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, {
    type: "file",
    path: videoPath,
    name: "demo.mp4",
    mimeType: "video/mp4",
  });

  assert.equal(factory.client.fileCreatePayloads.length, 1);
  assert.equal(factory.client.fileCreatePayloads[0]?.data.file_type, "mp4");
  assert.equal(factory.client.fileCreatePayloads[0]?.data.file_name, "demo.mp4");
  assert.equal(factory.client.fileCreatePayloads[0]?.data.duration, 5_000);
  assert.deepEqual(factory.client.fileCreatePayloads[0]?.data.file, video);
  assert.deepEqual(factory.client.replyPayloads.map((payload) => payload.data.msg_type), ["media"]);
  assert.deepEqual(factory.client.replyPayloads.map((payload) => JSON.parse(payload.data.content)), [
    { file_key: "file_upload" },
  ]);
});

test("FeishuAdapter falls back to a normal attachment when an MP4 duration is unreadable", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  const dir = tempDir("codex-feishu-video-fallback-");
  const videoPath = path.join(dir, "broken.mp4");
  fs.writeFileSync(videoPath, Buffer.from("not an mp4 container"));
  await adapter.start();

  await adapter.sendMedia({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, {
    type: "file",
    path: videoPath,
    name: "broken.mp4",
    mimeType: "video/mp4",
  });

  assert.equal(factory.client.fileCreatePayloads[0]?.data.file_type, "stream");
  assert.equal(factory.client.fileCreatePayloads[0]?.data.duration, undefined);
  assert.deepEqual(factory.client.replyPayloads.map((payload) => payload.data.msg_type), ["file"]);
});

test("FeishuAdapter emits ChannelMessage for p2p text events and deduplicates message_id", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const received: string[] = [];
  adapter.onMessage(async (message) => {
    received.push(message.text ?? "");
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_once",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "/help" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_once",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "/help" }),
    },
  }));

  assert.deepEqual(received, ["/help"]);
  const status = await adapter.getStatus();
  assert.equal(status.lastInboundAt !== undefined, true);
  assert.equal(status.details?.lastSkipReason, "duplicate_message");
});

test("FeishuAdapter does not resolve private sender names through Feishu user API", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let senderId = "";
  let senderDisplayName: string | undefined;
  adapter.onMessage(async (message) => {
    senderId = message.sender.id;
    senderDisplayName = message.sender.displayName;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_resolve_name",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "hello" }),
    },
  }));

  assert.equal(senderId, "ou_user");
  assert.equal(senderDisplayName, undefined);
  assert.equal(factory.client.userGetPayloads.length, 0);
});

test("FeishuAdapter ignores private sender display names from event fields without API lookup", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let senderDisplayName: string | undefined;
  adapter.onMessage(async (message) => {
    senderDisplayName = message.sender.displayName;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    sender: { sender_name: "李四" },
    message: {
      message_id: "om_event_name",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "event name" }),
    },
  }));

  assert.equal(senderDisplayName, undefined);
  assert.equal(factory.client.userGetPayloads.length, 0);
});

test("FeishuAdapter keeps group receive disabled for the 0.1.5 public release", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, groupEnabled: true });
  let received = 0;
  adapter.onMessage(async (message) => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_once",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 看一下" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(received, 0);
  assert.equal(adapter.getCapabilities().group, false);
  assert.equal((await adapter.getStatus()).details?.lastSkipReason, "group_disabled");
});

test("FeishuAdapter does not download group file resources while group receive is not public", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-group-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, groupEnabled: true, inboundMediaRootDir: uploadRoot });
  const fileBytes = Buffer.from("group report");
  factory.client.resourceBuffers.set("file_group_in_1", fileBytes);
  factory.client.resourceHeaders.set("file_group_in_1", { "content-type": "application/pdf" });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_file",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_group_in_1", file_name: "group-report.pdf", file_size: fileBytes.length }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(received, 0);
  assert.equal(factory.client.messageResourceGetPayloads.length, 0);
  assert.equal((await adapter.getStatus()).details?.lastSkipReason, "group_disabled");
});

test("FeishuAdapter short-circuits group messages before mention checks while group receive is not public", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-group-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, groupEnabled: true, inboundMediaRootDir: uploadRoot });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_no_mention",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "只是群里普通聊天" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_at_all",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_all 看一下" }),
      mentions: [{
        key: "@_all",
        id: {},
        name: "所有人",
      }],
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_file_no_mention",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_group_ignored", file_name: "ignored.pdf" }),
    },
  }));

  assert.equal(received, 0);
  assert.equal(factory.client.messageResourceGetPayloads.length, 0);
  assert.equal((await adapter.getStatus()).details?.lastSkipReason, "group_disabled");
});

test("FeishuAdapter skips group receive events while group capability is disabled", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_disabled",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 看一下" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(received, 0);
  assert.equal((await adapter.getStatus()).details?.lastSkipReason, "group_disabled");

  adapter.setGroupEnabled(true);
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_enabled",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 再看一下" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(received, 0);
  assert.equal(adapter.getCapabilities().group, false);
  assert.equal((await adapter.getStatus()).details?.lastSkipReason, "group_disabled");
});

test("FeishuAdapter sendText replies to source message first", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  const result = await adapter.sendText({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, "回复内容");

  assert.equal(result.messageId, "om_reply");
  assert.equal(factory.client.replyPayloads.length, 1);
  assert.equal(factory.client.replyPayloads[0].path.message_id, "om_source");
  assert.equal(factory.client.createPayloads.length, 0);
  assert.match(factory.client.sentTexts()[0], /回复内容/);
});

test("FeishuAdapter sends direct approval cards and returns a resolved card callback", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const actions: Array<{ approvalKey: string; decision: string; senderId: string }> = [];
  adapter.onApprovalAction(async (action) => {
    actions.push({
      approvalKey: action.approvalKey,
      decision: action.decision,
      senderId: action.message.sender.id,
    });
    return {
      status: "resolved",
      text: "审批已处理: 已通过",
      decision: action.decision,
    };
  });

  await adapter.start();
  const result = await adapter.sendApprovalRequest(approvalTarget(), approvalRequest());
  const payload = factory.client.replyPayloads.at(-1);
  assert.equal(result.messageId, "om_reply");
  assert.equal(payload?.data.msg_type, "interactive");
  const card = JSON.parse(payload?.data.content ?? "{}") as {
    elements?: Array<{ tag?: string; actions?: Array<{ value: Record<string, unknown> }> }>;
  };
  const approveAction = card.elements?.find((element) => element.tag === "action")?.actions?.[0];
  assert.deepEqual(approveAction?.value, {
    action: "chat_codex_approval",
    approvalKey: "a001",
    decision: "approve",
  });

  const response = await factory.dispatcher.emitCardAction(sampleFeishuCardActionEvent({
    context: { open_message_id: "om_reply", open_chat_id: "oc_user" },
    operator: { open_id: "ou_user" },
    action: { value: approveAction?.value },
  })) as {
    toast?: { type?: string; content?: string };
    card?: { type?: string };
  };

  assert.deepEqual(actions, [{ approvalKey: "a001", decision: "approve", senderId: "ou_user" }]);
  assert.equal(response.toast?.type, "success");
  assert.match(response.toast?.content ?? "", /已通过/);
  assert.equal(response.card?.type, "raw");
  await adapter.stop();
});

test("FeishuAdapter sends terminal-input cards and forwards cancel", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const actions: Array<{ approvalKey: string; decision: string }> = [];
  adapter.onApprovalAction(async (action) => {
    actions.push({ approvalKey: action.approvalKey, decision: action.decision });
    return {
      status: "resolved",
      text: "审批已处理: 已取消本次终端输入，Codex 将中止当前任务。",
      decision: action.decision,
    };
  });

  await adapter.start();
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest({
    kind: "terminal_input",
    command: "write_stdin --session-id 42 'confirm\n'",
    terminalId: "42",
    terminalInput: "confirm\n",
    availableDecisions: ["approve", "cancel"],
  }));
  const payload = factory.client.replyPayloads.at(-1);
  const card = JSON.parse(payload?.data.content ?? "{}") as {
    header?: { title?: { content?: string } };
    elements?: Array<{
      tag?: string;
      actions?: Array<{ text: { content: string }; value: Record<string, unknown> }>;
    }>;
  };
  const actionsElement = card.elements?.find((element) => element.tag === "action");
  const cancelAction = actionsElement?.actions?.[1];

  assert.equal(card.header?.title?.content, "Codex 请求终端输入审批");
  assert.deepEqual(actionsElement?.actions?.map((action) => action.text.content), ["本次允许", "取消并中止任务"]);
  assert.deepEqual(cancelAction?.value, {
    action: "chat_codex_approval",
    approvalKey: "a001",
    decision: "cancel",
  });

  const response = await factory.dispatcher.emitCardAction(sampleFeishuCardActionEvent({
    context: { open_message_id: "om_reply", open_chat_id: "oc_user" },
    operator: { open_id: "ou_user" },
    action: { value: cancelAction?.value },
  })) as {
    toast?: { type?: string; content?: string };
    card?: { type?: string; data?: { header?: { title?: { content?: string } } } };
  };

  assert.deepEqual(actions, [{ approvalKey: "a001", decision: "cancel" }]);
  assert.equal(response.toast?.type, "success");
  assert.match(response.toast?.content ?? "", /已取消本次终端输入/);
  assert.equal(response.card?.type, "raw");
  assert.equal(response.card?.data?.header?.title?.content, "Codex 终端输入已取消");
  await adapter.stop();
});

test("FeishuAdapter rejects cancel injected into an ordinary approval card", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let handled = 0;
  adapter.onApprovalAction(async () => {
    handled += 1;
    return { status: "resolved", text: "不应进入处理器", decision: "cancel" };
  });

  await adapter.start();
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest());
  const response = await factory.dispatcher.emitCardAction(sampleFeishuCardActionEvent({
    context: { open_message_id: "om_reply", open_chat_id: "oc_user" },
    operator: { open_id: "ou_user" },
    action: {
      value: { action: "chat_codex_approval", approvalKey: "a001", decision: "cancel" },
    },
  })) as { toast?: { type?: string; content?: string } };

  assert.equal(handled, 0);
  assert.equal(response.toast?.type, "warning");
  assert.match(response.toast?.content ?? "", /审批动作无效/);
  await adapter.stop();
});

test("FeishuAdapter rejects approval card actions from another private user", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let handled = 0;
  adapter.onApprovalAction(async () => {
    handled += 1;
    return { status: "resolved", text: "审批已处理: 已通过", decision: "approve" };
  });

  await adapter.start();
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest());
  const response = await factory.dispatcher.emitCardAction(sampleFeishuCardActionEvent({
    context: { open_message_id: "om_reply", open_chat_id: "oc_user" },
    operator: { open_id: "ou_other" },
  })) as { toast?: { type?: string; content?: string } };

  assert.equal(handled, 0);
  assert.equal(response.toast?.type, "warning");
  assert.match(response.toast?.content ?? "", /只有发起该审批/);
  await adapter.stop();
});

test("FeishuAdapter keeps multiple direct approval cards independent", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const actions: Array<{ approvalKey: string; decision: string }> = [];
  adapter.onApprovalAction(async (action) => {
    actions.push({ approvalKey: action.approvalKey, decision: action.decision });
    return {
      status: "resolved",
      text: `审批已处理: ${action.decision}`,
      decision: action.decision,
    };
  });

  await adapter.start();
  factory.client.replyResponse = {
    code: 0,
    data: { message_id: "om_card_1", chat_id: "oc_user" },
  };
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest());
  factory.client.replyResponse = {
    code: 0,
    data: { message_id: "om_card_2", chat_id: "oc_user" },
  };
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest({
    approvalKey: "a002",
    turnId: "turn-2",
    itemId: "item-2",
  }));

  const secondResponse = await factory.dispatcher.emitCardAction(sampleFeishuCardActionEvent({
    context: { open_message_id: "om_card_2", open_chat_id: "oc_user" },
    operator: { open_id: "ou_user" },
    action: {
      value: { action: "chat_codex_approval", approvalKey: "a002", decision: "deny" },
    },
  })) as { toast?: { type?: string }; card?: { type?: string } };
  const firstResponse = await factory.dispatcher.emitCardAction(sampleFeishuCardActionEvent({
    context: { open_message_id: "om_card_1", open_chat_id: "oc_user" },
    operator: { open_id: "ou_user" },
    action: {
      value: { action: "chat_codex_approval", approvalKey: "a001", decision: "approve" },
    },
  })) as { toast?: { type?: string }; card?: { type?: string } };

  assert.deepEqual(actions, [
    { approvalKey: "a002", decision: "deny" },
    { approvalKey: "a001", decision: "approve" },
  ]);
  assert.equal(secondResponse.toast?.type, "success");
  assert.equal(secondResponse.card?.type, "raw");
  assert.equal(firstResponse.toast?.type, "success");
  assert.equal(firstResponse.card?.type, "raw");
  await adapter.stop();
});

test("FeishuAdapter rejects an approval action copied from another card", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let handled = 0;
  adapter.onApprovalAction(async (action) => {
    handled += 1;
    return {
      status: "resolved",
      text: "审批已处理: 已通过",
      decision: action.decision,
    };
  });

  await adapter.start();
  factory.client.replyResponse = {
    code: 0,
    data: { message_id: "om_card_1", chat_id: "oc_user" },
  };
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest());
  factory.client.replyResponse = {
    code: 0,
    data: { message_id: "om_card_2", chat_id: "oc_user" },
  };
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest({
    approvalKey: "a002",
    turnId: "turn-2",
    itemId: "item-2",
  }));

  const response = await factory.dispatcher.emitCardAction(sampleFeishuCardActionEvent({
    context: { open_message_id: "om_card_1", open_chat_id: "oc_user" },
    operator: { open_id: "ou_user" },
    action: {
      value: { action: "chat_codex_approval", approvalKey: "a002", decision: "approve" },
    },
  })) as { toast?: { type?: string; content?: string } };

  assert.equal(handled, 0);
  assert.equal(response.toast?.type, "warning");
  assert.match(response.toast?.content ?? "", /审批动作无效/);
  await adapter.stop();
});

test("FeishuAdapter allows retrying an approval card after a transient handler failure", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let attempts = 0;
  adapter.onApprovalAction(async (action) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary Bridge failure");
    return {
      status: "resolved",
      text: "审批已处理: 已通过",
      decision: action.decision,
    };
  });

  await adapter.start();
  await adapter.sendApprovalRequest(approvalTarget(), approvalRequest());
  const event = sampleFeishuCardActionEvent({
    context: { open_message_id: "om_reply", open_chat_id: "oc_user" },
    operator: { open_id: "ou_user" },
  });
  const firstResponse = await factory.dispatcher.emitCardAction(event) as {
    toast?: { type?: string; content?: string };
  };
  const secondResponse = await factory.dispatcher.emitCardAction(event) as {
    toast?: { type?: string; content?: string };
    card?: { type?: string };
  };

  assert.equal(attempts, 2);
  assert.equal(firstResponse.toast?.type, "error");
  assert.match(firstResponse.toast?.content ?? "", /审批处理失败/);
  assert.equal(secondResponse.toast?.type, "success");
  assert.equal(secondResponse.card?.type, "raw");
  await adapter.stop();
});

test("FeishuAdapter does not send approval cards to non-direct conversations", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  await assert.rejects(
    () => adapter.sendApprovalRequest({
      ...approvalTarget(),
      routeKey: "feishu:work:group:oc_group",
      conversation: { id: "oc_group", kind: "group" },
    }, approvalRequest()),
    /仅支持私聊/,
  );
  assert.equal(factory.client.replyPayloads.length, 0);
  await adapter.stop();
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mp4WithDuration(durationMs: number): Buffer {
  const movieHeader = Buffer.alloc(20);
  movieHeader.writeUInt32BE(1_000, 12);
  movieHeader.writeUInt32BE(durationMs, 16);
  return isoBmffBox("moov", isoBmffBox("mvhd", movieHeader));
}

function isoBmffBox(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

function approvalTarget() {
  return {
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" as const },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  };
}

function approvalRequest(overrides: Partial<ChannelApprovalRequest> = {}): ChannelApprovalRequest {
  return {
    approvalKey: "a001",
    routeKey: "feishu:work:direct:oc_user",
    requestedBy: "ou_user",
    kind: "command",
    sessionId: "session-1234567890",
    turnId: "turn-1234567890",
    itemId: "item-1",
    command: "npm test",
    availableDecisions: ["approve", "approve-session", "deny"],
    ...overrides,
  };
}

test("FeishuAdapter sendText falls back to chat_id create when reply fails", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.replyError = new Error("reply unavailable");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  const result = await adapter.sendText({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, "回退发送");

  assert.equal(result.messageId, "om_create");
  assert.equal(factory.client.replyPayloads.length, 1);
  assert.equal(factory.client.createPayloads.length, 1);
  assert.equal(factory.client.createPayloads[0].params.receive_id_type, "chat_id");
  assert.equal(factory.client.createPayloads[0].data.receive_id, "oc_user");
  assert.match(factory.client.sentTexts().at(-1) ?? "", /回退发送/);
});

test("FeishuAdapter uses Typing reaction as typing indicator", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();
  const target = {
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" as const },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  };

  await adapter.sendTyping(target, true);
  await adapter.sendTyping(target, true);
  await adapter.sendTyping(target, false);

  assert.equal(factory.client.reactionCreatePayloads.length, 1);
  assert.equal(factory.client.reactionCreatePayloads[0].path.message_id, "om_source");
  assert.equal(factory.client.reactionCreatePayloads[0].data.reaction_type.emoji_type, "Typing");
  assert.deepEqual(factory.client.reactionDeletePayloads, [{
    path: {
      message_id: "om_source",
      reaction_id: "react_typing_1",
    },
  }]);
});

test("FeishuAdapter typing reaction failure does not degrade channel", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.reactionCreateError = new Error("reaction permission denied");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  await adapter.sendTyping({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, true);

  const status = await adapter.getStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.lastError, undefined);
  assert.match(String(status.details?.lastTypingError), /reaction permission denied/);
});
