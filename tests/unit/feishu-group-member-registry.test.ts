import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuGroupMemberRegistry, validateFeishuGroupDisplayName } from "../../src/channels/feishu/group/group-member-registry.js";

test("FeishuGroupMemberRegistry stores display names per channel account and group", () => {
  const stateRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-group-members-"));
  const registry = new FeishuGroupMemberRegistry({
    stateRootDir,
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });

  registry.setDisplayName({
    channelId: "feishu-main",
    accountId: "default",
    chatId: "oc_group_a",
    openId: "ou_user",
    displayName: "小黄",
  });
  registry.setDisplayName({
    channelId: "feishu-main",
    accountId: "default",
    chatId: "oc_group_b",
    openId: "ou_user",
    displayName: "小黄 B",
  });

  assert.equal(registry.getMember({
    channelId: "feishu-main",
    accountId: "default",
    chatId: "oc_group_a",
    openId: "ou_user",
  })?.displayName, "小黄");
  assert.equal(registry.getMember({
    channelId: "feishu-main",
    accountId: "default",
    chatId: "oc_group_b",
    openId: "ou_user",
  })?.displayName, "小黄 B");
  assert.equal(fs.existsSync(path.join(stateRootDir, "channels", "feishu", "feishu-main", "accounts", "default", "groups", "oc_group_a", "members.json")), true);
});

test("validateFeishuGroupDisplayName rejects empty multiline and long names", () => {
  assert.equal(validateFeishuGroupDisplayName(""), "名称不能为空。");
  assert.equal(validateFeishuGroupDisplayName("小黄\n管理员"), "名称不能包含换行。");
  assert.equal(validateFeishuGroupDisplayName("一".repeat(25)), "名称不能超过 24 个字符。");
  assert.equal(validateFeishuGroupDisplayName("小黄"), undefined);
});
