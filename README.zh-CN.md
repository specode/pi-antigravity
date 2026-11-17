# pi-antigravity

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个 [Pi](https://github.com/earendil-works/pi-mono) 扩展：接入 Google Antigravity（`antigravity`）订阅，在 Pi 中使用 Gemini、Claude 和 GPT-OSS 模型。

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

如果之前装过其他同样注册 `antigravity` 的包（例如 `pi-antigravity`），请先执行 `pi remove npm:pi-antigravity` 卸载，不要同时安装两个 `antigravity` 提供商。`~/.pi/agent/auth.json` 里已有的 Antigravity 登录凭据可直接沿用，无需重新登录。

## 使用说明

1. 输入 `/login`，选择 `Sign in with an account` → `Antigravity`，在浏览器中打开终端给出的授权链接。
2. 完成 Google 账号登录后，点击 Antigravity 回调页面上的 **Copy to Clipboard**，把复制出来的 `4/...` 授权码粘贴回 Pi。（不要复制浏览器地址栏里的 URL，页面加载后会清掉地址栏里的查询参数；如果粘贴的是包含 `code` 和 `state` 的完整回调 URL 也同样支持。）
3. 输入 `/model` 选择 `antigravity` 下的模型，并按需调整推理档位（thinking effort）。

### 可用模型

模型列表从当前账号的 Google Cloud Code 接口动态拉取，并缓存在 `~/.pi/agent/models-store.json` 中（每 4 小时刷新一次，离线启动 Pi 时会直接从缓存恢复）。

| 模型 ID | 名称 | 推理档位 | 上下文 | 最大输出 | 图片输入 |
| --- | --- | --- | --- | --- | --- |
| `gemini-4-argon` | Gemini 4 Argon | `low`、`medium`、`high` | 1M | 65.5K | 支持 |
| `gemini-4-hydrogen` | Gemini 4 Hydrogen | `low`、`medium`、`high`、`xhigh` | 1M | 262.1K | 支持 |
| `gemini-3.8-flash` | Gemini 3.8 Flash | `low`、`medium`、`high` | 1M | 65.5K | 支持 |
| `claude-opus-5-5` | Claude Opus 5.5 | `low`、`medium`、`high` | 1M | 128K | 支持 |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | `low`、`medium`、`high` | 1M | 128K | 支持 |
| `gpt-oss-120b` | GPT-OSS 120B | `medium` | 131.1K | 32.8K | 不支持 |

### 注意事项

- **仅提供对话与工具调用**：本扩展只注册 `antigravity` 聊天提供商，不包含图片生成、内置网页搜索/抓取工具、多账号轮换或额度状态栏。
- **Token 用量与费用显示**：每轮记录输入、缓存命中、输出和思考 token；分帧更新保留此前有效计数，非法计数忽略而不强制转换。当缓存数超过上报的 prompt 总数时，按未缓存输入为 0、缓存输入不超过该总数记账，不中断生成。单条有界 `antigravity.usage_anomaly` 诊断保留有效数字计数及非法字段名，不保存原始载荷；异常期间的统计是近似值，后续有效统计会覆盖。订阅费用字段仍固定为 `0`。
- **Claude 思考续轮**：连续 thinking 分片累计到签名到达为止，兼容签名随正文或独立无正文尾帧到达。旧同模型会话的碎片只在出站请求中重组，不改写会话文件；正文、工具调用和已签名块仍是边界。Gemini 各个带签名 part 的边界保持不变。
- **默认系统提示词兼容**：Google 服务端会对 Pi 内置系统提示词中的部分文案返回 `429 RESOURCE_EXHAUSTED`（已确认默认开头和内置文档指引中的一行）。扩展在发送请求时，会把 Pi 内置的提示词文案（开头、内置工具简介与规则、文档指引、项目规则和技能列表标题）改写为不提及 Pi 的等义文案。只改写与 Pi 1.5.2 原文完全一致的部分；文件路径、环境变量名、工具名与 schema、技能条目、其他扩展的区块、你的 `AGENTS.md`、自定义系统提示词、用户消息和会话文件都原样保留。Google 可能将此视为规避其对第三方客户端的识别，账号风险需自行承担。
- **需要已有 Cloud Code 项目**：登录的 Google 账号需要已有可用的 Antigravity / Cloud Code Assist 项目，不支持自动创建 GCP 项目或企业版接口路由。

### 配套扩展

- **[`@specode/pi-subscription-usage`](https://github.com/specode/pi-subscription-usage)**：在底部状态栏和 `/usage` 中查看 Antigravity 的三个订阅额度池（Gemini、Claude 与 GPT、Gemini 4 Argon），直接复用本扩展的 `antigravity` 登录。
- **[`@specode/pi-last-model-effort`](https://github.com/specode/pi-last-model-effort)**：记住每个模型上次选择的推理档位，切换模型或新开 TUI 会话时自动恢复。

## 隐私与安全

- 凭据仅通过 Pi 自身的 `~/.pi/agent/auth.json` 存储和刷新，不读取官方 CLI 的登录文件或系统钥匙串。
- 请求仅发往 Google Cloud Code 官方接口（默认 `https://daily-cloudcode-pa.googleapis.com`），并禁用 HTTP 重定向。
- 访问令牌和刷新令牌不会写入模型缓存、会话文件或报错信息。
- Claude 模型直接收到各工具的原始 JSON Schema（包括 `anyOf` 联合类型）；Gemini 与 GPT-OSS 模型使用从官方 CLI 观测到的旧编码。
- 当请求的模型、推理档位或工具 Schema（Gemini 与 GPT-OSS 模型上的 `$ref` / `$dynamicRef`，或 `strict: "require"`）不被服务端支持时，直接报错提示，不会暗中降级模型档位或丢弃工具。

## 本地开发

```bash
# 安装依赖
npm ci

# 运行测试
npm test

# 运行类型检查、测试、隔离打包加载检查和打包文件列表检查
npm run check

# 不安装直接加载扩展验证
pi --no-extensions --offline -e ./src/index.ts --list-models
```

## 许可证

[MIT](./LICENSE)。协议参考与第三方声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
