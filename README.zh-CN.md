# pi-antigravity

[English](./README.md) | [简体中文](./README.zh-CN.md)

独立维护的 Pi Antigravity 订阅 provider。适配官方 **agy CLI 的 HTTP 协议**，运行时不启动官方 CLI、ACP bridge 或另一套 agent。

**状态：公开源码的聊天 provider，已安装到本机并获用户实测确认。** 基于 Pi **1.5.2** 完成合成 HTTP 测试和受限真实对照；验收边界见下文。

## 安装

需要 Node.js >= 22.19.0，以及本实现使用的 Pi 1.5.2 provider API。

从 npm 安装：

```sh
pi install npm:@specode/pi-antigravity
```

也可以从 GitHub 安装：

```sh
pi install git:github.com/specode/pi-antigravity
```

如果已安装旧 `pi-antigravity` 包，先执行 `pi remove npm:pi-antigravity`。不要同时加载两个注册 `antigravity` 的实现。保留现有 Pi OAuth 凭据，无需迁移 CLI 登录存储。

安装后执行 `/reload` 或重启 Pi。需要登录时运行 `/login`，选择 Antigravity，并按提示粘贴完整回调 URL；通过 `/model` 选择聊天模型。

本地开发也可以直接安装源码目录：

```sh
pi install /path/to/pi-antigravity
```

## 开发验证

```sh
npm ci
npm run check
```

`check` 包含严格类型检查、离线测试、真实 Pi 扩展加载的隔离冒烟测试及打包预检。冒烟测试使用临时配置目录并阻止网络 fetch，不触碰用户已安装扩展或凭据。

扩展入口为 `src/index.ts`。不要与另一个注册 `antigravity` 的 provider 同时加载。切换用户安装、真实账号测试和发布均为独立步骤，不会由开发测试执行。

## 发布

scoped npm 包配置为公开访问。GitHub Actions 验证 push 和 pull request。首次发布需要已认证的 npm 维护者；之后在 npm 为本仓库和 `npm-publish.yml` 配置 trusted publisher，未来创建 GitHub Release 时通过 OIDC 发布，工作流不使用长期 npm token。发布和创建 Release 属于外部操作，仍须明确授权。

## 请求主流程

1. **认证**：Pi 原生 OAuth 注册，Google 手动粘贴完整回调 URL 登录，校验 PKCE／state，支持 token 刷新。凭据保存和刷新锁由 Pi 管理。保留现有 OAuth 的 `access`、`refresh`、`expires`、`projectId` 及可选 `email`。
2. **目录**：初始化 consumer 账号并拉取精选聊天目录。公开模型 id 与 runtime id、明确发现的思考档位分离。Pi 标准模型存储保留账号隔离的最后成功快照，支持离线启动；刷新失败不清空快照。
3. **转换**：复用 Pi 公开 Google 转换器和标准 transcript。仅在序列化系统提示词时精确替换 Pi 已知开头两句，保留规则、工具、用户文本和会话记录。
4. **流式处理**：只向批准的官方 HTTPS origin 发送一次 HTTP 请求，增量解析 SSE，保留 Pi 观测钩子、签名、工具调用与用量，支持取消、独立的响应头／流空闲超时及唯一终止事件。不内置重试，不暗中切换 endpoint 或模型。

默认 endpoint 为交接中 consumer 账号实际使用的 `https://daily-cloudcode-pa.googleapis.com`，不宣称适用于所有企业账号。CLI 身份固定为 **1.5.9／构建 1021519450**，平台与架构取当前主机实际值。

## 功能边界

- 仅维护聊天／编码 provider。Antigravity 生图／编辑计划已取消，不再列为待开发或待测试任务。
- 仅公开精选聊天模型和明确支持的思考变体。不猜测未知思考协议；不支持的显式档位直接报错。
- 尚无订阅按 token 计费依据。Pi 成本元数据中的零表示**未定价**，不表示免费，也不是账单估算。请求 token 用量与订阅额度分开。
- 保留工具 schema 属性名和字面值。不支持的引用或必须严格采样的契约明确失败，不静默删除工具。
- 请求 UUID 与 transcript 计数属于本 provider 的本地记账，不声称还原了 CLI 所有重试／恢复规则。Pi session id 让普通恢复保持标识稳定、fork 相互隔离；无 session id 的直接调用按临时会话处理。
- 不实现账号切换、超额 credits、后台预热、额度 UI、搜索／网页工具、CLI 登录存储迁移或 Pi 私有运行时依赖。

## 独立插件协作

- **[pi-subscription-usage](https://github.com/specode/pi-subscription-usage)**：负责额度查询和展示。JSON 凭据桥接保留 `token`、`projectId` 及可选 `email`。无 email 的账号额外携带不透明的 `ownershipId`（由 Pi 以 `antigravityOwnershipId` 保存），避免 token 轮换破坏目录归属；既有消费者可忽略此字段。本次开发不修改该插件。
- **[pi-subscription-image](https://github.com/specode/pi-subscription-image)**：已有 Codex/Grok 功能保持不变，原计划的 Antigravity 后端已取消；本 provider 不注册生图 API 或工具。早期生图证据仅作为历史调研记录保留。

## 证据与待完成验收

此前 **2026-11-15** 协议调研共执行 17 次生成请求，覆盖原生 read 工具可行性、严格的提示词开头对照及一次参考图请求。[证据清单](./test/fixtures/agy-cli-1.5.9/manifest.json) 区分官方抓包和直接探测。脱敏记录仅用于结构取证，不能重放。

当前离线测试覆盖 Pi 原生模型／认证集成，使用 mock Gemini／Claude 响应执行真实的本地 Pi read 工具，并覆盖异常流、取消、超时、签名、并发和缓存隔离。OAuth 应用参数已对照固定版本官方 CLI 归档静态核实；**这不等于真实浏览器登录已验收**。

本机部署另外验证了真实账号初始化和目录发现，6 个公开模型的持久化及已安装 CLI 的离线恢复。既有凭据保持不变。

另经独立授权执行 6 次 Argon High 对照，定位到本仓库自身注入的项目规则：真正的开头虽已适配，文档却又逐字引用了原始 Pi 开头。严格保持请求其他字段相同，仅把该文档段落改为源码引用，结果从 429 变为 200。已移除 `AGENTS.md` 的这一逐字示例并增加回归测试，不改写任意用户规则或历史。测试限制了输出且未执行工具，不能视为完整工具闭环验收。受影响会话应先重载 Pi 的项目规则再重试。

用户随后反馈修复后实际测试正常，记为本机部署及该修复的用户验收；不据此宣称所有模型、工具续轮、登录、恢复或取消流程均已验证。

仍未单独验收的范围：经授权的 `/login`、真实完整工具闭环与会话 UI，以及更广泛的账号／模型覆盖。Antigravity 生图不在范围内，不是未完成待办。精确契约和限制统一见唯一开发／交接入口 [AGENTS.md](./AGENTS.md)。
