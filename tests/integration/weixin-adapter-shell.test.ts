import test from "node:test";
import assert from "node:assert/strict";
import { WeixinAdapter } from "../../src/channels/weixin/weixin-adapter.js";

test("WeixinAdapter shell implements channel contract and reports login_required", async () => {
  const adapter = new WeixinAdapter({ sourceVersion: "2.4.3" });
  await adapter.start();

  assert.equal(adapter.id, "weixin");
  assert.equal(adapter.getCapabilities().login, "qr");
  assert.equal((await adapter.getStatus()).state, "login_required");
  assert.equal(adapter.hasMessageHandler(), false);
});
