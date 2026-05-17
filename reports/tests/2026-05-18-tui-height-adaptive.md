# 测试报告：TUI 高度自适应与视口滚动

## 概述

在 TUI 视觉重设计基础上，新增终端高度自适应支持。解决了 `alternateScreen` 模式下内容超出终端高度被裁切的问题。

本次补充修复运行日志页滚动：原实现按“日志条目数量”滚动，遇到多行日志或长日志自动换行时，会出现屏幕内容超出但滚动没有明显变化。现在运行日志页按实际渲染行滚动，并按终端宽度预先折行。

## 核心机制

- `useViewportRows(fixedRows)` — 调用 Ink v7 `useWindowSize().rows`，减去固定行数，返回可用列表行数，最少保证 3 行
- `visibleWindow(items, selected, maxVisible)` — 以 `selected` 为中心滑动窗口，越界时对齐边界，返回切片及上下剩余计数
- `ScrollHint({ above, below })` — 在列表上方/下方显示 `↑ 还有 N 项` / `↓ 还有 N 项` 提示
- 终端 resize 时 `useWindowSize()` 自动触发重渲染，无需手动刷新

## 受影响文件

| 文件 | 变更内容 |
| --- | --- |
| `src/cli/tui/ui-components.tsx` | 新增 `useViewportRows`、`visibleWindow`、`ScrollHint`；增加 `useWindowSize` import |
| `src/cli/tui/views.tsx` | `ChannelsView`、`BindingsView`、`WeixinBindingView`、`SessionSelectView` 增加视口窗口逻辑 |
| `src/cli/tui/runtime-log.tsx` | `visibleCount` 从硬编码 12 改为 `max(5, rows - 22)` 动态值；运行日志从按条目滚动改为按实际渲染行滚动，并按终端宽度折行 |
| `docs/tui-visual-redesign.zh-CN.md` | 新增 16.4 节：高度自适应与视口滚动（含 fixedRows 参考表、渲染行为说明） |

## 各 View 视口配置

| View | fixedRows | 弹性区域 |
| --- | --- | --- |
| `ChannelsView` | 19 | 渠道列表（操作 7 项固定展示） |
| `BindingsView` | 8 | 绑定 + 待生效列表（合并窗口） |
| `SessionSelectView` | 10 | 可选 session 列表 |
| `WeixinBindingView` | 11 | 可选 session 列表 |
| `RuntimeLogView` | 22 | 日志显示行（动态 visibleRows，支持 ↑↓/j/k、PgUp/PgDn、Home/End） |

## 运行日志滚动修复

- 日志正文保留完整内容，不截断。
- 多行日志会按终端宽度折行后参与滚动计算。
- `↑↓` 每次滚动一行，`PgUp/PgDn` 按当前可视行数翻页。
- `Home` 跳到最早日志，`End` 回到最新日志。
- 增加 `j/k` 作为滚动备选键，避免部分终端环境方向键事件不稳定。
- 日志区显示 `↑ 还有 N 行` / `↓ 还有 N 行`，明确当前是否还有隐藏内容。

## 测试结果

```
测试套件：单元测试 + 集成测试
测试总数：324
通过：324
失败：0
跳过：0
耗时：约 11.6 秒
```

所有测试通过，无回归。
