# TUI app.tsx 模块化拆分计划

## 背景

当前 `src/cli/tui/app.tsx` 已增长到 1000 行以上。展示组件已经拆到 `views.tsx`，通用 UI 组件、类型和 session 分页也已有独立模块，但 `app.tsx` 仍同时承担以下职责：

- TUI 全局状态：当前页面、dashboard、loading、选中项、分页、flash、confirm、输入框值。
- 生命周期副作用：首次加载 dashboard、微信登录自动轮询、刷新状态。
- 全局导航：返回、退出、启动、页面切换、最大可选项计算。
- 键盘输入分发：全局快捷键、上下移动、分页、各页面输入 handler。
- 业务动作编排：添加微信、添加飞书、渠道启停/删除/备注、微信主聊天绑定、route/session 绑定、配对信任、权限、上下文刷新、工作目录。
- 当前页面渲染分支：按 screen 组装各 View 的 props。

这导致单文件承担“controller + router + action orchestration + render composition”多重职责，后续再加 TUI 功能会继续变大，也会增加回归风险。

## 目标

- 保留 TUI 当前全部功能、快捷键、页面流转和测试语义。
- 把 `app.tsx` 从 1000 行级别降到约 250-350 行，只保留入口 glue。
- 拆分后每个模块职责明确，便于单测和后续维护。
- 不重写 TUI 架构，不更换 Ink，不改变 `LauncherActions` 公共接口。
- 不把业务逻辑移动到 view 组件里；view 仍只负责展示和输入框局部 submit。

## 非目标

- 不做视觉重设计。
- 不调整页面信息架构。
- 不新增 TUI 功能。
- 不重构 `LauncherActions`、状态存储或渠道配置服务。
- 不改变现有聊天/运行期逻辑。

## 当前功能清单

拆分必须保持以下功能稳定：

- 首页：
  - 首次配置页：添加微信、添加飞书、权限设置、默认上下文刷新、工作目录、退出。
  - 已配置页：管理渠道、聊天绑定、配对管理、权限设置、上下文刷新、工作目录、状态详情、启动服务。
- 渠道管理：
  - 渠道列表、渠道 cursor、添加微信、添加飞书、修改备注、启停、删除、详情页。
  - 飞书渠道详情支持群聊接收开关。
  - 微信渠道详情支持进入主聊天绑定。
- 微信登录：
  - 发起扫码登录。
  - 自动轮询登录结果。
  - Enter 立即检查。
  - `c` 复制备用链接。
  - Esc 取消登录并返回渠道页。
- 飞书添加：
  - `appId -> appSecret -> accountId` 三步输入。
  - 默认 domain 回填。
  - 保存成功后刷新 dashboard 并回到渠道页。
- 聊天绑定：
  - route 绑定列表和待生效微信主聊天绑定。
  - 未配对 route 阻止绑定修改，引导到配对详情。
  - 新建并绑定 session。
  - 手动输入 session id。
  - 选择已有 session。
  - 解绑确认。
  - session 权限入口。
- 微信主聊天绑定：
  - 绑定新 session。
  - 手动输入 session id。
  - 绑定已有 session。
  - 清除主聊天绑定。
  - session 列表分页。
- 配对管理：
  - 配对列表、详情页。
  - 手动信任确认。
  - 撤销信任确认。
  - 撤销信任并解绑确认。
- 权限设置：
  - 默认权限和当前 session 权限。
  - `full` 权限二次确认。
  - `approval/workspace-write` 回切。
- 上下文刷新：
  - 默认策略 `off/detect/reload`。
  - route 策略 `inherit/off/detect/reload`。
  - 保存后刷新 dashboard。
- 工作目录：
  - 使用当前进程目录。
  - 手动输入目录。
  - 目录不存在时确认创建并使用。
- 全局输入：
  - `?` 打开帮助。
  - `r` 刷新，配对页面除外。
  - Esc / `q` 返回。
  - 上下方向键移动 selection。
  - 左右方向键 / PageUp / PageDown 翻 session 页。
  - Enter 执行当前选中项。
  - 数字快捷选择。
- 启动：
  - 配置可启动时进入启动确认页。
  - 不可启动时跳转到需要处理的页面。
  - Enter 启动并返回 `onDone({ start: true })`。

## 拆分方案

### 1. 保留 `app.tsx` 作为薄入口

`app.tsx` 最终只保留：

- `ChatCodexTui` 组件。
- 调用 controller hook。
- 注册 `useInput`。
- 调用 screen renderer。
- 渲染 `ConfirmBar` / `Footer`。

目标职责：

```text
ChatCodexTui
  -> useChatCodexTuiController(...)
  -> useTuiKeyboard(controller)
  -> renderTuiScreen(controller)
```

### 2. 新增 controller hook

建议新增：

```text
src/cli/tui/use-chat-codex-tui-controller.ts
```

职责：

- 管理现有 `useState` / `useRef`。
- 暴露只读派生状态：
  - `channels`
  - `bindings`
  - `pendingBindings`
  - `pairings`
  - `currentChannel`
  - `currentBinding`
  - `currentPairing`
  - `bindingItems`
  - `footerContext`
- 暴露状态 setter 或窄动作：
  - `setScreen`
  - `setSelected`
  - `setFlash`
  - `setConfirm`
  - `refresh`
  - `back`
  - `start`
  - `quit`
  - `moveSessionPage`
  - `getMaxSelectableIndex`
- 保留 lifecycle：
  - 首次 `refresh()`。
  - screen 切换时重置 selection/session page/manual value/confirm。
  - channel cursor 跟随 selected。
  - 微信登录自动检查定时器。

控制器返回值使用显式接口，避免后续把 `actions` 和所有 setter 裸传到各处。

### 3. 新增输入分发模块

建议新增：

```text
src/cli/tui/input-handlers.ts
```

职责：

- 提供 `handleTuiInput(controller, input, key)`。
- 保留全局输入优先级：
  1. 文本输入页只处理 Esc，由 view 内部输入框处理文本。
  2. confirm 模式优先处理 `y/n/是/否/Esc`。
  3. Esc 返回。
  4. `?` 帮助。
  5. `r` 刷新，配对页除外。
  6. 左右/PageUp/PageDown session 翻页。
  7. 上下移动 selection。
  8. `q` 返回。
  9. 按当前 screen 分发到页面 handler。
- 页面级 handler 先按现有函数迁移，保持行为不变。

拆分后 `useInput` 内只调用：

```ts
useInput((input, key) => {
  void handleTuiInput(controller, input, key);
});
```

### 4. 新增 action orchestration 模块

建议新增：

```text
src/cli/tui/tui-actions.ts
```

职责：

- 承载会修改状态或调用 `LauncherActions` 的业务动作：
  - `openAddWeixinLogin`
  - `checkWeixinLoginResult`
  - `handleWeixinPrimaryResult`
  - `submitFeishuValue`
  - `savePermission`
  - `saveWorkdir`
  - `createAndBind`
  - `saveChannelName`
  - `bindSessionTarget`
- 承载确认框动作构造：
  - `confirmToggleGroupReceive`
  - `confirmRemoveChannel`
  - `confirmUnbind`
  - `confirmManualTrust`
  - `confirmRevokeTrust`
- 这些函数通过 controller context 操作状态，不直接依赖 React 组件树。

### 5. 新增 navigation/helpers 模块

建议新增：

```text
src/cli/tui/navigation.ts
```

职责：

- `back`
- `openNeedsAttention`
- `maxSelectableIndex`
- `numericPick`
- `contextRefreshModeForIndex`
- `formatCurrentContextRefresh`
- `nextFeishuStep`
- `defaultForFeishuStep`
- `weixinAutoCheckIntervalMs`

其中纯函数优先独立导出并补单测；依赖 controller 的导航函数通过参数传入当前状态和窄动作。

### 6. 新增 screen renderer 模块

建议新增：

```text
src/cli/tui/screen-renderer.tsx
```

职责：

- 承载当前 `body = useMemo(...)` 的 screen -> View 映射。
- 不包含业务判断之外的副作用。
- 只从 controller 读取状态和动作，把 props 传给现有 `views.tsx`。

拆分后，`views.tsx` 不做大改，避免同时改展示和控制逻辑。

## 迁移步骤

### 第一步：抽纯 helper，低风险

- 从 `app.tsx` 移出纯函数：
  - `maxSelectableIndex`
  - `numericPick`
  - `contextRefreshModeForIndex`
  - `formatCurrentContextRefresh`
  - `nextFeishuStep`
  - `defaultForFeishuStep`
  - `weixinAutoCheckIntervalMs`
- 新增单测覆盖这些函数的关键输入输出。
- `app.tsx` 行数预计下降 50-80 行。

### 第二步：抽 screen renderer

- 新建 `screen-renderer.tsx`。
- 把 `body = useMemo(...)` 的分支迁移为 `renderTuiScreen(controller)` 或 `<TuiScreen controller={controller} />`。
- 保持 `views.tsx` props 不变。
- 这一步只移动渲染组合，不移动 handler 逻辑。
- `app.tsx` 行数预计下降 120-160 行。

### 第三步：抽 controller hook

- 新建 `use-chat-codex-tui-controller.ts`。
- 迁移 state/ref、派生状态和 lifecycle effects。
- `app.tsx` 改为消费 controller。
- 这一步要保持 screen 切换时 selection 重置、微信绑定页默认 selected、channel cursor 更新等细节完全一致。
- `app.tsx` 行数预计下降 180-250 行。

### 第四步：抽 action orchestration

- 新建 `tui-actions.ts`。
- 迁移异步业务动作和确认框构造。
- controller 暴露 action context，避免循环依赖。
- 这一步要重点测试微信登录、飞书添加、渠道删除、绑定、权限、工作目录确认。
- `app.tsx` 行数预计下降 200-280 行。

### 第五步：抽 input handlers

- 新建 `input-handlers.ts`。
- 迁移全局输入分发和页面级 handler。
- 保持输入优先级不变。
- `app.tsx` 最终只保留 `useInput((input, key) => handleTuiInput(controller, input, key))`。
- `app.tsx` 目标行数约 250-350 行。

## 模块边界约定

- `views.tsx` 只展示，不调用 `LauncherActions`。
- `input-handlers.ts` 只解释按键和调用 controller actions，不直接写复杂业务。
- `tui-actions.ts` 负责业务动作编排和确认框内容。
- `navigation.ts` 优先放纯函数和轻量导航规则。
- `use-chat-codex-tui-controller.ts` 管状态、生命周期和派生数据。
- `app.tsx` 管装配。

避免：

- 把所有状态 setter 裸传给多个模块，导致边界失控。
- 在 `views.tsx` 里新增业务副作用。
- 一次性重写全部输入处理，导致快捷键回归难定位。
- 为了降行数把强相关逻辑拆得过碎。

## 测试计划

每一步拆分后都必须运行：

```bash
npm run build
node --test dist/tests/unit/ink-tui.test.js
```

最终合并前运行：

```bash
npm test
```

需要新增或强化的 TUI 测试：

- 首页：
  - 首次配置页数字快捷键、微信/飞书入口、退出。
  - 已配置页管理渠道、绑定、配对、权限、上下文刷新、工作目录、启动入口。
- 渠道：
  - 渠道列表 selection/cursor 不回退。
  - 渠道启停、删除确认、备注修改。
  - 飞书群聊接收开关确认。
- 微信：
  - 添加微信时自动检查定时器仍工作。
  - `c` 复制备用链接。
  - Esc 取消登录并返回渠道页。
  - 微信主聊天绑定新建、手动、已有、清除。
  - session 分页时 action row 位置保持稳定。
- 飞书：
  - 三步输入仍按顺序推进。
  - 空输入报错。
  - 成功后刷新并回到渠道页。
- 绑定：
  - 未配对 route 阻止绑定修改。
  - 绑定详情页新建、选择、权限、上下文刷新、解绑确认。
  - pending 微信主绑定入口。
- 配对：
  - 手动信任、撤销信任、撤销并解绑。
- 权限：
  - `full` 权限必须弹确认。
  - `approval` 不弹确认并保存。
- 工作目录：
  - 当前目录、手动目录、缺失目录创建确认。
- 全局输入：
  - `?`、`r`、Esc、`q`、方向键、PageUp/PageDown、数字快捷选择。
  - 文本输入页由输入框接管普通字符，外层只处理 Esc。

## 验收标准

- `app.tsx` 降到 350 行以内。
- 单个新增模块尽量控制在 400 行以内；超过时必须重新评估边界。
- `npm test` 通过。
- `tests/unit/ink-tui.test.tsx` 覆盖拆分中迁移的关键快捷键和页面流转。
- 拆分后用户可见 TUI 行为不变。
- 新增中文测试报告到 `reports/tests/`，记录执行命令、结果和未覆盖的真实交互边界。

## 风险与控制

- 风险：输入优先级变化导致快捷键回归。
  - 控制：先抽 helper/render，再抽 controller/actions，最后抽 input handlers；每步跑 TUI 测试。
- 风险：微信登录定时器和 loading 状态迁移后产生重复检查。
  - 控制：`weixinLoginRequest` 和 `weixinLoginCheckInFlight` 必须留在同一 controller hook 内。
- 风险：session 分页 action row 选中位置变化。
  - 控制：保留 `moveSessionPage` 行为并加回归测试。
- 风险：confirm 状态和 screen 切换交错。
  - 控制：screen 切换重置 confirm 的 effect 保持不变；confirm 输入优先级保持最高。

## 建议实施顺序

按“低风险纯移动 -> 高风险输入迁移”的顺序执行：

1. `navigation.ts` 纯 helper。
2. `screen-renderer.tsx`。
3. `use-chat-codex-tui-controller.ts`。
4. `tui-actions.ts`。
5. `input-handlers.ts`。

每完成一步就提交或至少保留清晰 diff，避免 1000 行文件一次性大搬迁导致问题难定位。
