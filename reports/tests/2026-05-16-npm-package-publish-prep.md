# npm 发包准备验证

## 背景

项目准备以 `chat-codex` 名称发布到 npm，让用户可以通过全局安装后直接执行 `chat-codex` 启动 TUI。

## 改动

- 移除 `private: true`，补齐 npm 包元数据：
  - `description`
  - `homepage`
  - `repository`
  - `bugs`
  - `keywords`
  - `publishConfig.access=public`
- 保留一个全局可执行入口：

```json
{
  "bin": {
    "chat-codex": "dist/src/cli.js"
  }
}
```

- 增加 `files` 白名单，只发布运行所需的构建产物、README、LICENSE 和 shrinkwrap。
- 用 `npm-shrinkwrap.json` 替代 `package-lock.json`，用于发布包的依赖锁定。
- 增加发布相关脚本：
  - `pack:dry-run`
  - `prepack`
  - `prepublishOnly`
- 将 `ink-testing-library` 移到 `devDependencies`，避免作为运行依赖发布。
- 对飞书 SDK 做发布前处理：
  - 保持 `@larksuiteoapi/node-sdk@^1.64.0`。
  - 使用 `overrides` 将本地和打包依赖中的 `axios` 固定到 `^1.16.1`。
  - 通过 `scripts/patch-bundled-lark-sdk.mjs` 在 `prepack` 阶段修正 bundled SDK 元数据，避免用户安装 tarball 后出现 `axios@1.16.1 invalid`。

## 验证

```bash
npm test
```

结果：

```text
239 passed
0 failed
```

```bash
npm audit --omit=dev
```

结果：

```text
found 0 vulnerabilities
```

```bash
npm whoami
```

结果：

```text
uluckyxh
```

```bash
npm view chat-codex version
```

结果：

```text
404 Not Found
```

说明 npm registry 当前未发现同名包。

```bash
npm pack --dry-run --json
```

结果：

```text
package size: 3.6 MB
unpacked size: 36.8 MB
entryCount: 892
bundled deps: 53
```

```bash
npm install -g --prefix <tmp>/prefix <tmp>/chat-codex-0.1.0.tgz
<tmp>/prefix/bin/chat-codex --help
npm ls -g --prefix <tmp>/prefix axios --all
```

结果：

```text
chat-codex --help 正常输出统一入口帮助。
@larksuiteoapi/node-sdk@1.64.0
axios@1.16.1
```

```bash
npm publish --dry-run
```

结果：

```text
+ chat-codex@0.1.0
```

## 结论

当前版本已经具备 npm 发布条件。真实发布前只需要再次确认版本号，然后执行：

```bash
npm publish
```

注意：为了规避飞书 SDK 传递依赖中的 `axios` 审计问题，当前包会 bundle 飞书 SDK 及其依赖，包体积约 `3.6 MB`，解包约 `36.8 MB`。
