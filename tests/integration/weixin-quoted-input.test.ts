import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../../src/bridge/bridge.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import { weixinMessageToChannelMessage } from "../../src/channels/weixin/weixin-adapter.js";

test("Bridge gives Codex the quoted context but executes commands using only current text", async (t) => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  await bridge.start();
  t.after(() => bridge.stop());
  const message = (text: string) => weixinMessageToChannelMessage(channel.id, "mock-account", { from_user_id: "u", item_list: [{ type: 1, text_item: { text }, ref_msg: { svr_id: "18446744073709551615", message_item: { type: 1, text_item: { text: "原始设计" } } } }] });
  await bridge.handleMessage(message("按这个修改"));
  await bridge.waitForIdle();
  assert.match(codex.runs[0]?.prompt ?? "", /按这个修改/);
  assert.match(codex.runs[0]?.prompt ?? "", /原始设计/);
  assert.match(codex.runs[0]?.prompt ?? "", /18446744073709551615/);
  const before = codex.runs.length;
  await bridge.handleMessage(message("/help"));
  await bridge.waitForIdle();
  assert.equal(codex.runs.length, before);
  assert.ok(channel.sentMessages.some((m) => m.text.includes("/help")));
});
