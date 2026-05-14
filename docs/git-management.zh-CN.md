# Git 管理规范

本文档说明本项目的 Git 管理方式。

## 1. 仓库边界

当前目录 `codex-openclaw-wechat/` 是独立 Git 仓库。

本仓库提交：

- 项目源码。
- 项目配置。
- 中文需求、设计、开发规范文档。
- 中文测试报告。
- 轻量参考源码索引文件。

本仓库不提交：

- `node_modules/`。
- `dist/`、`coverage/` 等构建和测试产物。
- 运行日志和运行态数据。
- `.env`、token、cookie、微信登录态、session 文件。
- `openclaw-weixin-npm/` npm 包下载和解包目录。
- `references/` 下除 `README.md` 外的本地参考源码目录。

## 2. 本地参考源码

本项目只提交 `references/README.md` 作为参考源码索引。实际下载的微信插件 npm 包、解包源码和 Codex 协议参考仓库都只保留在本地，不提交。

微信通道只需要参考 `@tencent-weixin/openclaw-weixin` npm 包，不需要下载完整 OpenClaw 源码。如果需要重新获取参考源码，按 `references/README.md` 里的命令执行。

## 3. 提交要求

每个功能提交前必须：

- 运行相关测试。
- 更新或新增中文测试报告到 `reports/tests/`。
- 检查 `git status --short`，确认没有登录态、token、日志和构建产物进入暂存区。
- 确认文档与实际实现一致。

## 3.1 忽略规则重点

`.gitignore` 中运行态状态目录必须使用根路径忽略，例如：

```gitignore
/state/
```

不能写成裸 `state/`，否则会误伤源码目录 `src/state/`。`src/state/` 是中间件状态存储源码，必须被 Git 追踪。

## 4. 建议提交粒度

- 文档和规范调整可以单独提交。
- 通用协议、Codex Adapter、Channel Adapter、命令、审批、状态存储应按功能分批提交。
- 每个实现提交应包含对应测试或测试报告。
