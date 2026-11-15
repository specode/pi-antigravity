# pi-antigravity

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个 [Pi](https://github.com/earendil-works/pi-mono) 扩展：对齐官方 agy CLI 的 HTTP 协议，在 Pi 中注册 Antigravity（`antigravity`）订阅聊天提供商。

直接使用 Antigravity 订阅连接 Google Cloud Code 接口，复用 Pi 原生的 OAuth 凭据存储、模型目录、工具执行与会话管理，无需运行官方 CLI 二进制、ACP 桥接进程或另一套 Agent 循环。

## 安装

需要 Node.js >= 22.19.0，以及 Pi >= 1.5.2。

从 npm 安装：

```bash
pi install npm:@specode/pi-antigravity
```

从 GitHub 安装：

```bash
pi install git:github.com/specode/pi-antigravity
```

从本地目录安装（开发调试）：

```bash
pi install /path/to/pi-antigravity
```

安装后执行 `/reload` 或重启 Pi 生效。

如果已安装其他同样注册 `antigravity` provider ID 的包（例如 `pi-antigravity`），请先执行 `pi remove npm:pi-antigravity` 卸载，不要同时加载两个 `antigravity` 提供商。`~/.pi/agent/auth.json` 中已有的 Pi OAuth 登录凭据可直接复用。

## 使用说明

1. 执行 `/login`，依次选择 `Sign in with an account` → `Antigravity`（`Sign in with Google (Antigravity subscription)`），在浏览器中打开终端提示的授权链接。
2. 完成 Google 账号授权后，在 Antigravity 页面点击 **Copy to Clipboard**，将授权码粘贴回 Pi。请使用本次登录产生的授权码，不要复制地址栏 URL——页面会主动移除其中的查询参数。同时兼容包含 `code` 和 `state` 的完整回调 URL。
3. 执行 `/model` 选择 `antigravity` 下的模型，并按需切换推理档位（thinking effort）。

### 模型发现与路由规则

| 环节 | 行为 |
| --- | --- |
| 目录拉取 | 调用 `loadCodeAssist` 与 `fetchAvailableModels`，仅公开精选聊天模型（`agentModelSorts` / `recommended`），过滤内部占位符与生图模型 |
| 推理档位 | 将带 `-low`、`-medium`、`-high` 后缀的运行时模型归并到同一公开模型 ID 下，并映射为 `generationConfig.thinkingConfig`；不支持的档位直接报错，不暗中降级 |
| 离线缓存 | 按账号将最近一次成功的模型目录保存在 Pi 的 `models-store.json` 中（刷新周期 4 小时）；支持离线启动恢复，刷新失败时保留已有目录 |
| 账号隔离 | 目录缓存绑定当前登录账号（`email` 或派生的 `ownershipId`）、`projectId` 与官方接口地址；切换账号时自动隐藏旧账号目录 |
| 用量与成本 | 从流式元数据记录输入、缓存命中、输出与思考 token 用量；成本字段固定记为 `0`（表示订阅未按 token 定价，而非免费 API 额度） |

### 配套扩展

- **[`@specode/pi-subscription-usage`](https://github.com/specode/pi-subscription-usage)**：在底部状态栏和 `/usage` 中显示 Antigravity 订阅额度池（Gemini、Claude 与 GPT、Gemini 4 Argon）。本扩展保持相同的 `antigravity` provider ID、官方 Google 接口地址与 `{ token, projectId, email }` 凭据桥接格式，无需额外配置即可配合使用。
- **[`@specode/pi-last-model-effort`](https://github.com/specode/pi-last-model-effort)**：记住每个 Antigravity 模型上次选择的推理档位，并在切换模型或新开 TUI 会话时自动恢复。

## 协议适配与边界

- **对齐官方 CLI HTTP 协议**：面向个人订阅（默认连接 `https://daily-cloudcode-pa.googleapis.com`；账号需具备已初始化的 Cloud Code Assist 项目，不包含企业版路由或自动 GCP 项目开通）。聊天请求发往 `/v1internal:streamGenerateContent?alt=sse`，携带 `antigravity/cli/1.5.9`（构建号 `1021519450`）客户端标识、当前主机系统平台与架构、`agent` 外层请求结构、会话轨迹标签以及空种子 64 位 FNV-1a `sessionId`。
- **复用公开转换器与工具闭环**：通过宿主公开的包导出加载 `@earendil-works/pi-ai` 的 Google 消息与工具转换器，完整保留 `thoughtSignature`（含空文本块上的签名）、多工具调用 ID 配对及已验证的 `gemini-3.8-flash-low` 函数结果角色调整；仅在 JSON Schema 关键字位置将类型转为大写，不改动工具属性名或字面值，遇到不支持的 `$ref` / `$dynamicRef` 引用或 `strict: "require"` 约束时直接报错，不静默丢弃工具。
- **精确改写默认系统提示词开头**：仅在序列化发往后端的请求时，将 Pi 默认的两句固定开头替换为 `You are a coding agent helping the user with their project.`，避免后端对该固定开头返回 `429 RESOURCE_EXHAUSTED`；不修改用户消息、会话文件、项目规则或自定义提示词。
- **聚焦核心范围**：仅提供文本对话、编码与工具调用能力；不包含图片生成／编辑、网页搜索／抓取工具、多账号轮换、超额 credits、后台预热或内置额度 UI。
- **单次受控传输**：每轮请求仅发起一次 HTTP 调用，分别设置响应头超时（30 秒）与流空闲超时（120 秒）；不内置隐式重试，不在失败或部分输出后暗中切换模型、降级推理档位或切换接口地址。

## 隐私与安全

- 仅通过 Pi 原生的 OAuth 存储（`auth.json`）管理凭据，不读取、复制或迁移官方 CLI 登录文件或系统钥匙串。
- 请求仅发往白名单内的官方 HTTPS 域名（默认为 `https://daily-cloudcode-pa.googleapis.com`，以及 `https://cloudcode-pa.googleapis.com` 和 `https://daily-cloudcode-pa.sandbox.googleapis.com`），并禁用重定向（`redirect: "error"`）。
- OAuth 登录接受官方页面复制的授权码，并携带本次登录独立生成的 S256 PKCE verifier 交换令牌。复制的授权码不含 `state`，此路径依靠令牌端点的 PKCE 校验。仍兼容完整的 `https://antigravity.google/oauth-callback` URL，严格校验 origin／path 并进行常量时间的 `state` 校验；无效 URL 不会退回裸授权码解析。
- OAuth 与流式传输报错仅保留白名单错误码或受限诊断元数据，绝不在异常消息、日志或模型目录缓存中写入访问令牌或刷新令牌。

## 本地开发

```bash
# 安装依赖
npm ci

# 运行类型检查、离线测试、隔离打包加载测试和打包文件检查
npm run check

# 仅运行离线单元与集成测试
npm test

# 在禁网的隔离 Pi 环境中验证已发布的 npm 包
npm run smoke -- @specode/pi-antigravity@0.1.2
```

当前验证覆盖严格类型检查、离线单元与集成测试（含基于 mock Gemini／Claude 流的本地 Pi `read` 工具闭环）、官方 agy CLI `1.5.9` 参数静态核对，以及基于 Pi `1.5.2` 的个人订阅账号实测；首次浏览器 `/login` 及跨账号／全模型组合尚未逐一单独验收。详细架构说明与验收边界见 [AGENTS.md](./AGENTS.md)，脱敏协议研究样本见 [`test/fixtures/agy-cli-1.5.9/manifest.json`](./test/fixtures/agy-cli-1.5.9/manifest.json)。

## 许可证

[MIT](./LICENSE)。协议参考与第三方声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
