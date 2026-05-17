# Codex 进度噪声控制验证

## 背景

Codex app-server 在执行命令时会通过 `item/commandExecution/outputDelta` 发送大量 stdout/stderr 增量。Chat-Codex 之前会把这些 delta 逐条转成聊天进度，长命令、等待输出、进度条和转圈状态会造成微信、飞书和 TUI 日志刷屏。

## 实现范围

- 新增 `src/codex/app-server/command-output-summary.ts`。
  - 按命令 `itemId` 聚合输出 delta。
  - 清理 ANSI/control 控制字符。
  - 对长输出生成 bounded summary。
  - 成功命令保留较短摘要，失败命令保留更多尾部错误上下文。
- `AppServerTurnController` 不再直接投递 `item/commandExecution/outputDelta`。
  - `item/started + commandExecution` 只生成“正在执行命令”摘要。
  - `item/completed + commandExecution` 生成一次命令完成/失败摘要。
- `progressFromThreadItem()` 对 `aggregatedOutput` 做摘要，不再拼接完整输出。
- 新增 `src/bridge/progress-delivery.ts`。
  - 同一路由进度去重。
  - 同一路由短时间进度合并，turn 结束前 flush。
  - `/progress brief` 继续抑制 command 进度。
  - `/progress detailed` 可以看到命令摘要，但不会看到 raw delta。
  - 微信类 `progress: suppress` 渠道仍只写本地 transcript，不发聊天进度。
- `BridgeRouteQueue` 和 `BridgeBackgroundTurns` 统一接入 `BridgeProgressDelivery`。

## 覆盖测试

- `tests/unit/app-server-mappers.test.ts`
  - 命令完成输出被摘要。
  - ANSI/control 控制字符会被清理并标注。
  - 长输出带省略说明。
- `tests/unit/app-server-codex-adapter.test.ts`
  - 多个 `item/commandExecution/outputDelta` 不再生成逐条 raw progress。
  - 命令完成只输出 bounded summary。
  - 失败命令摘要保留尾部错误内容。
- `tests/unit/bridge-progress-delivery.test.ts`
  - brief 模式抑制 command 进度。
  - detailed/send 策略下同 route 高频进度被合并。
  - 重复进度去重。
  - suppress 策略只写本地 transcript。
- `tests/integration/bridge-mock.test.ts`
  - 现有 `/progress brief|detailed|silent`、微信 suppress、后台 Goal 和发送失败 cooldown 行为保持兼容。

## 已执行验证

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js
node --test dist/tests/unit/bridge-progress-delivery.test.js
node --test dist/tests/unit/app-server-codex-adapter.test.js
node --test dist/tests/integration/bridge-mock.test.js
npm test
git diff --check
```

## 结果

- 构建通过。
- app-server 命令输出 delta 不再刷屏。
- Bridge 进度投递具备 route 级去重和合并保护。
- 默认 brief 仍不展示命令细节；detailed 展示命令摘要；silent 不发进度。
- 微信类渠道仍不发送进度，只记录本地 transcript。
- 全量 `npm test` 通过，`310 passed, 0 failed`。
