import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeixinAdapter } from "../../src/channels/weixin/weixin-adapter.js";

test("WeixinAdapter shell implements channel contract and reports login_required", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-adapter-shell-"));
  const adapter = new WeixinAdapter({ sourceVersion: "2.4.4", stateDir });
  await adapter.start();

  assert.equal(adapter.id, "weixin");
  assert.equal(adapter.getCapabilities().login, "qr");
  assert.equal((await adapter.getStatus()).state, "login_required");
  assert.equal(adapter.hasMessageHandler(), false);
});
