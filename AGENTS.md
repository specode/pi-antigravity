# 开发入口与交接

## 1. 目标、边界与当前状态

用户希望独立维护 `@specode/pi-antigravity`：**对 Pi 低侵入，对官方 agy CLI 的订阅 HTTP 协议准确对齐**。不是完整移植 Rahularya01/pi-antigravity，也不是把另一个 agent 放进 Pi，更不是 ACP bridge。

已确认的选择：

- 独立 npm 包，目录为 `pi-plugins/pi-antigravity`，provider id 保留 `antigravity`。代码仓库为 `https://github.com/specode/pi-antigravity`，origin 使用用户提供的 `git@github.com:specode/pi-antigravity.git`；首次提交及推送已获明确授权。
- Pi 继续管理工具执行、会话、凭据保存、UI 和主循环；本包只提供必要的认证与协议适配。
- 范围收敛为文本聊天／编码及工具调用 provider；额度由相邻的 `pi-subscription-usage` 负责。用户已明确取消 Antigravity 生图计划，不在本包或相邻 image 插件新增 Antigravity 生图／编辑后端，也不继续生图测试。现有 Codex/Grok 生图插件不在本次修改范围。
- 允许在发往后端的请求中精确改写 Pi 默认开头两句；不改写会话记录、用户消息、规则文件或任意包含 `pi` 的文本。
- 不需要搜索、网页读取、多账号切换、企业版路由、额度 UI、静默降级、自动超额 credits、后台预热和其他 harness/fork 兼容层。

**当前状态：聊天 provider 已替换本机旧包并获用户实测确认；GitHub 与 npm 均公开，0.1.0 已发布，0.1.1 正在修复并验收发布包的宿主导入解析。** `src/index.ts` 注册 Pi 原生 provider；`auth.ts`、`catalog.ts`、`request.ts`、`stream.ts` 与 `client.ts` 分别负责认证、目录、转换、流及受控 HTTP。已安装本项目开发依赖，`npm run check` 覆盖严格类型检查、136 项离线测试、隔离的真实 Pi 扩展加载和打包预检。mock Gemini／Claude 响应驱动了真实本地 Pi read 工具闭环；这些不是新的真实后端调用。已通过 `pi remove npm:pi-antigravity` 卸载旧 0.14.0，并通过 `pi install` 将本项目目录加入全局 packages；修改前已备份 settings，登录凭据和旧账号数据保持字节不变。GitHub 仓库已完成首次提交及推送，CI 通过。npm 包已移除 `private` 标记并以 `publishConfig.access: public` 配置，0.1.0 的 npm 公开发布及匿名访问已验证，Trusted Publishing 已绑定本仓库与 `npm-publish.yml`。随后发现 0.1.0 在不带开发依赖的新安装中无法解析部分 Pi 子路径，0.1.1 修复只通过公开 Node／Pi API 及宿主 package exports 加载 Google 转换器；使用 root 导出的 transcript／事件流辅助函数，不修改 Pi loader、不捆绑或复制 Pi。以 registry 实际版本和脱离源码依赖的 tarball 加载结果作为修订版完成依据。真实 `loadCodeAssist`／`fetchAvailableModels` 查询成功并以 Pi 标准模型存储持久化 6 个公开模型，安装后的 CLI 已验证离线恢复；安装切换本身未发起生成请求；后续经独立授权完成了本节 6.2 所述 6 次 429 对照。已打开的 Pi 会话需 `/reload` 才更新扩展和项目规则。用户随后反馈实际测试无问题，本机切换及 429 修复记为用户实测通过；反馈未明确覆盖具体模型、工具续轮、首次登录、恢复或取消，不扩张为这些场景均已验收。首次浏览器登录及真实完整工具闭环／会话 UI 的逐项验收仍未单独确认；Antigravity 生图已取消，不再列为待办；不能把目录查询或小输出对照写成完整生成验收。Astra（`gpt-6-astra`）已独立审查并复审：无 email 凭据自动刷新导致目录失效的 P2 已修复，133 项测试及隔离 smoke 重跑通过，未发现其他具体问题；这不是线上稳定性保证。

本文件是本项目唯一开发入口。用户说明维护中英文 README 并顶部互链；后续以实现和测试更新这里，不新增分散的设计过程／历史流水账。

## 2. 主流程与模块边界

建议先按下面流程实现；文件数量只是建议，不为模块化而机械拆分：

1. **入口装配**：通过 Pi 标准 provider API 注册 `antigravity`，不注册重复工具或常驻 UI。
2. **OAuth**：登录／刷新／凭据解析 → 交由 Pi 保存；保留已有账号格式。
3. **模型目录**：账号初始化与 endpoint 选择 → 拉取目录 → 公开模型 id 与实际 runtime id／思考档位映射 → Pi 标准模型持久化。
4. **请求适配**：读取 Pi 标准 transcript → 使用可复用的公开转换器 → 加上经验证的 CLI 差异和外层元数据。
5. **传输与响应**：受控 HTTP 请求 → SSE 解析 → Pi 事件流、签名、用量和错误。
6. **独立插件协作**：usage 通过 provider 凭据查询；不增加 Antigravity 生图能力，不改动现有 Codex/Grok 生图行为。

可按职责组织为 `src/index.ts`、`auth.ts`、`catalog.ts`、`request.ts`、`stream.ts`，必要时单独放置客户端版本与请求标识逻辑。不承诺代码行数，不复制上游整个实现。身份参数、模型路由、生命周期状态不是同一职责，不能都塞进一个“profile”配置框架。

生产实现只依赖 Pi 公开契约。`src/google-shared.ts` 通过公开 `getPackageDir()`、Node `findPackageJSON()` 和宿主的公开 exports 定位 Google 转换器，解决 Pi 1.5.2 未别名映射全部 `api/*` 子路径的问题；不依赖开发目录的 node_modules，不修改全局 resolver，不访问私有 API。验证阶段曾为生成真实系统提示词／执行原生 read 而引用本机 Pi 的内部模块，这些测试手法**不是生产依赖的许可**。

## 3. 证据入口与可信度

验证日期：**2026-11-15**。基线：Pi **1.5.2**、Node **26.13.1**、官方 agy CLI **1.5.9**、构建号 **1021519450**、macOS arm64、个人订阅账号。

证据统一在 `test/fixtures/agy-cli-1.5.9/`，先读 `manifest.json`：

| 文件 | 含义 |
| --- | --- |
| `official-observations.json` | 第一批官方 CLI 观测摘要；其中 limitations 是当时的范围，部分已由后续验证补齐 |
| `official-capture.json` | 5 次官方 CLI 请求：Flash 单轮、Flash 工具续轮、Sonnet 工具续轮，均 200 |
| `verification.json` | 第二批结论：12 次请求，包含 2 次预期的 429 对照和 1 次生图 |
| `verification-capture.json` | 第二批请求／响应结构；其中 1 次是官方 CLI 基线，11 次是验证脚本请求，不要统称为官方 CLI 抓包 |
| `image-result.jpg` | 合成参考图变换后的测试结果，无用户图片 |

两批共 **17 次生成请求**；模型目录／额度／登录初始化查询不计入这个数字。第二批 `results` 有 11 个命名结果，另有 1 次官方 CLI 基线，完整 12 次见对应 capture。

这些 JSON 是**脱敏观测记录**。任意字符串常被替换为 `{redacted, length, sha256}`，某些标识另有 `shape`。`sha256` 在捕获记录中通常是截短的关联摘要，不是原值；只能比较结构和同一标识的关联。不能作为带有效签名的重放 payload，也不能直接当作生产 API 类型的 fixture。后续应基于它们构造独立的合成单元测试输入。

不保存或恢复真实 token、授权码、账号标识、项目原值、原始提示词、官方二进制和提取源码。原始日志、临时凭据、抓包代理和二进制已经清理；本目录不依赖 `/tmp` 存活。

## 4. 认证、客户端身份和 endpoint

### 4.1 OAuth 与现有登录兼容

- Pi 既有凭据包含 `type: oauth`、`access`、`refresh`、`expires`，以及 `projectId`、`email`。
- 既有 `getApiKey` 契约为 JSON 字符串，至少含 `token` 和 `projectId`。usage 可解析该格式；不要改成另一种私有 token 协议。为无 email 的既有账号，开发实现增加可忽略的 `ownershipId`：首次从原 refresh token 做域分离 SHA-256 派生，刷新前固定为凭据扩展字段 `antigravityOwnershipId`，由 Pi 随轮换凭据保存。目录和会话身份使用该稳定标识，不依赖易变 access token，不退化为仅凭 projectId 判断账号；账号切换仍隔离。原有 JSON 消费者可继续只读取 token／projectId。
- 官方 CLI 成功复用了 Pi OAuth，并在隔离文件存储中自行刷新。验证没有回写 Pi 原始凭据。
- **重要字段陷阱**：CLI 自己的 `StoredToken.project_id` 是显式 GCP project；不能把 Pi 的 `projectId`（Cloud Code Assist 的 project）直接塞进去。这样曾触发 `serviceusage.services.use` 的 403；去掉这个误映射后初始化正常。
- 复用认证测试本身不等于新包 `/login` 验收。开发阶段另对证据 manifest 固定的官方 1.5.9 darwin-arm 归档核对 SHA-512，并静态检查 consumer `backend/auth`（非 `acpauth`）：OAuth client、scopes、HTTPS redirect、独立 state、S256 PKCE、表单 token exchange／refresh。具体公开应用参数与函数出处见 `src/auth.ts`。下载与静态分析临时目录已清理，未保存二进制或提取源码。
- 不照搬 ACP 的 scope／回调结论。此次 CLI 浏览器流程使用了 `https://antigravity.google/oauth-callback` 并可粘贴授权码；旧 pi-antigravity 用 localhost 回调，两者不是同一已验证流程。新实现采用该 HTTPS 回调，但要求粘贴包含 code 和 state 的完整 URL，严格校验 origin／path／单一 code／state；不接受无法校验 state 的裸授权码。登录、取消、超时、刷新及 Pi 原生刷新锁已有 mock 测试，真实浏览器流程仍未验收。
- 验证时曾临时复制凭据到 CLI 存储，这只是隔离测试手段。生产插件**不复制、迁移或维护 CLI 登录存储**，不访问系统钥匙串；通过 Pi 管理凭据。

### 4.2 客户端身份

捕获到的 User-Agent：

```text
antigravity/cli/1.5.9 (aidev_client; os_type=darwin; arch=arm64; cl=1021519450; auth_method=consumer)
```

这是实际 CLI 观测，不是 ACP 的 `antigravity/acp/...`。平台与架构应按实际环境映射，不在 Mac 上硬写 `linux/amd64`。版本号与 `cl` 是配套事实；升级身份时核对对应发布包，不只随意提高版本号。

已观察到 `Authorization`、`Content-Type: application/json` 和上述 UA。HTTP 编码／分块传输等会被记录代理改变，不把这些观测宣称为 TLS 指纹或逐字节等价。

### 4.3 初始化与 endpoint

- `loadCodeAssist` 用于账号／项目／订阅状态，`fetchAvailableModels` 用于目录。
- 不设置 `CLOUD_CODE_URL` 时，官方 CLI 通过只记录 CONNECT 目标的代理，实际连接了 `daily-cloudcode-pa.googleapis.com`，模型目录查询成功。这只验证当前 consumer 账号，不证明所有账号都应使用同一 host。
- endpoint 与 project 解析必须依据实际初始化契约。不要把“依次尝试 production/daily/sandbox”当成官方必需行为。
- 不凭猜测制造 project UUID，不把 consumer 凭据发给任意 `baseUrl`，不自动跨域跟随携带认证的重定向。对凭据目标做明确的 HTTPS 官方 origin 限制。

## 5. 模型发现与路由

- 使用 `fetchAvailableModels`，保留公开选择 id 与实际请求 runtime id 的分离。例如 `gemini-3.8-flash` 对应本次验证的 `gemini-3.8-flash-low`。
- 从目录读取实际模型 id、档位、`model` enum、输入能力和 token 上限。`model_enum` 不是发往请求顶层 `model` 的 id。开发阶段静态确认目录 `thinkingLevel` 为 int32，仅保留数值，不猜测其枚举语义；当前路由只归并明确的 `-low/-medium/-high` runtime 后缀。无后缀但声明思考能力的未知协议不公开，未声明的 proto3 boolean 按 false 处理。
- 后端目录存在 `agentModelSorts`、`imageGenerationModelIds` 等信息；不要把内部 `MODEL_PLACEHOLDER_*`、image 模型或内部占位模型全部暴露成聊天模型。
- 通过当前 Pi 的 `refreshModels`／publish 和模型存储契约工作。离线启动应可恢复最后成功目录；刷新失败不能清空可用列表。账号更换后的缓存隔离与取消需要测试。
- 不能在失败后悄悄更换模型代际、思考档位或账号。不得把 API 成功、速度或费用当成所选模型实际被服务的证明；响应 `modelVersion` 可能不同，例如本次 Argon 返回 `gemini-4-argon-trial`。
- 订阅额度与请求 token 用量分离。不根据模型家族猜测价格，不把公开 API 标价当成订阅实际账单；成本元数据必须有依据。

## 6. 聊天请求：已验证的转换规则

### 6.1 外层与内层

聊天路径为 `/v1internal:streamGenerateContent?alt=sse`。官方外层包括 `project`、`model`、`requestId`、`requestType: agent`、`userAgent: antigravity`、`request`。

内层包含 `contents`、`systemInstruction`、`tools`、`labels`、`generationConfig`、`sessionId`。官方不是 ACP 的仅三个字段包装；不要为了“轻量”去掉已观察到的 CLI 协议字段。

本次 Flash/Sonnet Low 使用 `thinkingConfig: {includeThoughts: true, thinkingLevel: LOW}`；后续 Argon High、Opus High 在验证脚本中使用 `HIGH` 也成功。不要照搬旧上游对所有模型发 `thinkingBudget` 的做法，但也不把已测档位推广成所有模型支持 `off/xhigh/max`。

### 6.2 Pi 提示词与 429 对照

Pi 1.5.2 的默认开头以 `src/request.ts` 中的 `PI_OPENING` 常量为准；此处不逐字引用，避免该示例随项目规则再次进入请求。

已验证替换成：

```text
You are a coding agent helping the user with their project.
```

两组对照均为原版 429、替换后 200。最后一组保持请求 ID、工具及其他所有字段完全相同，唯一变化是 `request.systemInstruction.parts[0].text` 中上述开头。后面的全局／项目规则被保留；随后带 Pi 完整原生工具描述和规则也正常。

因此：只锚定已知的默认开头整句改写，其他内容原样保留；未知自定义开头不做泛化替换。不把 system prompt 移到 user 轮，不删除技能，不注入另一套官方 agent 指令。只修改本次序列化请求，不能污染持久化 transcript。

这证明当前样本的 429 与开头差异相关，不证明后端内部分类器的具体实现，也不意味着任意 `RESOURCE_EXHAUSTED` 都是提示词问题或都应标为不可重试。真实额度、限流、容量和格式错误须区分。

本机安装后的 Argon High 排查另获授权执行 6 次受控请求，每次输出上限 256、无自动重试、不执行工具，共 3 次 429、3 次 200。当时 Argon 周额度剩余约 99.94%。完整系统提示词含 13 个工具时返回 429；保留全部工具，仅去掉项目规则则 200；中性开头加项目规则仍 429。最后一对保持请求 ID 和其他所有字段一致，仅将本节原来的逐字开头示例改为上面的源码引用，得到 429 → 200。由此修复文档自身经 `project_context` 注入已知触发文本的问题，不扩大 provider 对规则或历史的改写范围。`test/request.test.ts` 防止本文件重新嵌入该完整原句。最后一次 200 因小输出上限以 length 终止，只证明请求获接收，不等于完整回答／工具验收；也不证明后端具体检测机制。

### 6.3 工具与 Pi 公开转换器

已实际使用 Pi 1.5.2 的公开模块 `@earendil-works/pi-ai/api/google-shared` 中 `convertMessages`、`convertTools`，配合标准 transcript normalization，完成两个模型的原生 `read` 闭环：模型调用 → 执行 Pi read → 回传结果 → 输出 `AGY_PI_TOOL_OK`。

验证原型的适配：

- `convertTools(tools, true, false)` 采用 `parameters` 而非 `parametersJsonSchema`，再把 schema **关键字位置**的类型转成大写。不要把用户属性名、描述或 enum 内容统一大写。
- 官方样本中每个 `tools[]` 元素只有一个 `functionDeclarations` 项；原型按此排列成功。这里记录的是兼容方案，不是已证明其他排列全部无效。
- Gemini 3.8 Flash 和 Claude Sonnet 5.5 都保留 function-call ID；结果 ID 与调用 ID 配对。
- 官方 Gemini 3.8 Flash 续轮的 function-response-only content 使用 `role: model`；Claude Sonnet 使用 `role: user`。原型在公共转换器之后只针对已验证 Gemini 路由调整结果轮角色，并验证成功。不要未经测试推广到所有 Gemini/Vertex/其他 provider。
- Gemini 的 `thoughtSignature` 必须跟随正确调用保留；最终签名可能随**空文本 part**到达，不能一概丢掉空文本。
- 当前公开转换器本身已支持 Gemini 3+ 的 tool-call ID；不要把上游遗漏误归因到 Pi，重复写一整套 converter。

仅验证了原生 read 闭环以及四个原生工具的声明。复杂 MCP schema、引用／联合／递归、并发多工具、图片工具结果、跨 provider 历史仍需针对性测试。不可因为转换困难就静默移除工具或大规模扁平化会话。

### 6.4 请求标识与 sessionId

官方 labels 包含 `cascade_id`、`root_cascade_id`、`trajectory_id`、`request_id`、`last_step_index`、`model_enum`、`used_claude`、`used_claude_conservative`、`used_non_gemini_model`。同一官方对话的 cascade／trajectory 在续轮中稳定；本次 `last_step_index` 从 `0` 变为 `2`。

`requestId` 形状为 `agent/<uuid>/<13-digit timestamp>/<uuid>/<step>`；label `request_id` 为 `<uuid>-<index>`。脱敏记录没有保留所有原始数值，不能仅凭形状断言每一个重试／恢复计数规则。原型使用内容轮数量作为 step、请求序号作为 index 的方案已通过普通工具续轮，但恢复／失败／并发仍要测试。

**本次所有官方样本（包括工具续轮）均没有 `last_execution_id`。** 不能直接抄上游用上一轮 step 计算虚构 execution UUID 的逻辑。

静态核对官方 `genairequest.hashToSessionID`，算法为 FNV-1a 64 位，对种子字节逐个 xor／乘法（模 2^64），最后按有符号 int64 转十进制。offset basis 为 `0xcbf29ce484222325`，prime 为 `0x100000001b3`。空种子得到：

```text
-3750763034362895579
```

该数值的 SHA-256 前 16 位 `cfca81ad0e596bc7` 与第一批所有官方 sessionId 摘要一致。**这只证明被测普通 CLI 路径的空种子行为，不证明其他模式都用空种子。** 不要沿用上游的 SHA-256 + Pi session seed 方案并声称与官方一致，也不要把 sessionId 与 cascade／trajectory 视为同一个标识。

## 7. 传输、SSE、错误与生命周期

- 使用 Pi 标准注册和事件流 API。新实现优先核对当前 native Provider 形式；不要为过时版本另建全局 compat registry。
- 从 normalized transcript 的 system 消息读取当前提示词和工具，不能只看旧 `Context.systemPrompt/tools` 字段。
- Honor `onPayload` 的替换结果、`onResponse`、`onProviderStreamEvent`、abort signal 和 provider-scoped env。保持 Pi 的观测与其他扩展钩子正常。
- SSE 观测中外层包含 `response`、`traceId`、`metadata`；保留 response id／实际 modelVersion 的来源，不把 requested runtime 当作后端确认值。
- 一次 start、平衡的内容事件、一个 terminal 事件；保留工具参数及签名，区分 STOP 中含 functionCall 的 `toolUse`。解析错误不能静默跳过后当成功。
- 请求头超时与中途静默超时分开；取消应终止读流／网络并清理资源。部分输出后不偷偷换 endpoint 重放。
- 优先保留结构化错误和 `ErrorInfo` 证据；不要仅按 “quota” 字样推断额度用完，也不要改写数字／错误词来操纵 Pi 重试而丢失真实原因。避免插件内部重试与 Pi 重试叠加。
- 本次没有真实触发额度墙、取消、断流、并发或重试；上述是实现要求，不是已有验证结果。

## 8. 额度插件协作与生图边界

### 8.1 usage

相邻 `../pi-subscription-usage/` 版本 **1.5.0**：

- 核查 `src/providers/antigravity.ts` 与 `src/query.ts` 的 `resolveUsageAuth`、`adapterForProvider`。
- 通过满足未来 provider 契约的 registry stub 传入 JSON `{token, projectId}`，**未修改的现有 adapter** 实际请求额度成功：三个 group、五个 bucket，计划和项目元数据存在。
- 这验证的是凭据解析与真实查询，不是新 provider 已安装、真实 footer／跨 session 已验收。测试没有确认 email 展示，结果 metrics 只有 plan、project。
- 保留 `antigravity` id、官方 HTTPS model baseUrl、上述 credential 格式；OAuth 中保留 email。不要在新 provider 再实现 quota polling 或重复请求。
- usage 目前自带旧版本 UA，原样查询在本次可用；如未来要统一身份，应显式改其适配器并测试，不通过全局 fetch／env 副作用操控它。

### 8.2 已取消 Antigravity 生图

用户明确选择仅维护文本聊天 provider，取消向相邻 `../pi-subscription-image/` 添加 Antigravity 后端的计划。不注册生图／编辑工具、slash command 或原生 image API，也不再发起 Antigravity 生图测试。现有 image 插件的 Codex/Grok 能力保持不变。

早期一次合成参考图变换的 JPEG 结果及接口观测仍作为历史证据保留在 `test/fixtures/agy-cli-1.5.9/`；它们不是当前功能、待实现任务或继续生图的授权。保留既有聊天转换器的输入兼容行为，不把取消图片生成扩张为无关的 transcript 重写。

## 9. 实施顺序与验收

当前开发验证入口为 `npm ci && npm run check`。测试位于 `test/*.test.ts`，使用独立合成输入；`scripts/smoke.mjs` 先 npm pack，再将 tarball 解压到源码树外，不带扩展开发依赖，用临时 Pi 配置与合成凭据验证真实加载和磁盘目录恢复，并禁用网络 fetch；发布后用 `npm run smoke -- @specode/pi-antigravity@<version>` 验证实际 registry 包。README 中英同步说明边界。后续继续遵循以下顺序，已完成的离线步骤不替代第 7 步的真实授权验收。

1. **先读契约**：本文件、证据 manifest、当前 Pi provider/extension 文档、现有两个插件入口和测试。核实本机接口后再写代码。
2. **建工程**：增加真正存在的入口、依赖、typecheck、离线测试与包检查。无实现前不声明可安装扩展；公开发布按用户明确授权执行。
3. **先做纯函数测试**：精确提示词改写、FNV、目录归并、schema 关键字处理、消息边界、ID／签名保留、错误分类。脱敏记录转成合成测试，不能直接重放。
4. **最小 provider 闭环**：标准 OAuth／目录／流式注册，先做 mock HTTP，再做隔离的离线 Pi 加载，不触碰用户安装。
5. **稳定性回归**：空响应、分块 UTF-8、多行／残缺 SSE、错误后部分输出、取消、超时、工具并发、恢复／fork／模型切换、缓存账号隔离、钩子及用量口径。
6. **usage 兼容**：只有凭据接口确有变化才修改 usage 代码或用户说明；Antigravity 生图已取消，不实施 image 插件扩展。
7. **授权后真实验收**：实际 Pi `/login`、原生工具、全量插件／skills、会话恢复、取消和 UI。过去的请求预算不是未来无限测试授权；新的真实聊天模型调用先确认范围，不进行已取消的生图测试。
8. **最后部署／发布**：用户决定切换时间。同一进程不要同时加载两个 `antigravity` provider。不得擅自卸载上游、改用户 settings、迁移会话、创建远端或发布包。

验收不能只看 HTTP 200：还要验证工具确实执行、结果正确、签名跨轮保留、取消生效、终止事件唯一、用量与记录一致。不要把少量成功样本写成“所有模型／所有账号／所有版本稳定”。

## 10. 参考资料与工程约束

- 仓库约定与相邻插件一致：MIT（Specode）、完整 package 元数据、中英 README 顶部互链、GitHub CI，以及基于 Release 的 npm OIDC 工作流。npm 包为公开访问，不保留 private 标记或隐藏发布的 job 条件。用户已明确授权 npm 公开发布；首次 0.1.0 经 npm 维护者网页二次认证发布，trusted publisher 已绑定 `specode/pi-antigravity`／`npm-publish.yml`，后续修订版可走 Release 的 OIDC 发布。不得把 GitHub 仓库公开误写成 npm 已发布，也不得在 registry 验证前声称发布成功。运行时只使用 host peer，不打包 Pi、本机凭据或脱敏研究之外的原始抓包。保留 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
- GitHub Push Protection 会标记 `src/auth.ts` 的两条公开 OAuth 应用参数；首次推送的这两条例外已由用户逐项明确授权，以 `false_positive` 处理。不得把这扩大为用户 token 的例外、关闭仓库整体保护，或编码混淆参数以隐藏扫描结果。
- 协议参考：[Rahularya01/pi-antigravity](https://github.com/Rahularya01/pi-antigravity)，当时安装版 **0.14.0**。只作为线索，已知若干转换／元数据策略与 CLI 1.5.9 不同。若复制 MIT 代码，保留授权和署名；不把运行时依赖指向上游包。
- 官方安装入口：`https://antigravity.google/cli/install.sh`。只读安装脚本即可找官方 updater manifest，不要直接 pipe 到 shell。
- 本次 macOS arm64 manifest：`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json`。版本对应下载地址和 SHA-512 在证据 manifest 中；后续不能把 latest 当作仍是 1.5.9。
- 本机 Pi 文档基线：`~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/` 下 `custom-provider.md`、`extensions.md`、`packages.md`、`models.md`；实现前完整阅读相关文档与示例。
- 生产转换参考：`@earendil-works/pi-ai/api/google-shared` 和公开 transcript utilities；先检查当前 package exports 和实际行为。
- 默认中文沟通；代码注释、命令描述、运行提示、测试名称用英文；README 中英同步。保留其他人的未提交修改，只做当前范围工作。
- 不提交 token／授权码／钥匙串导出／原始抓包／账号缓存，不把任何已脱敏摘要当作可恢复凭据。真实模型测试只用无敏感内容的临时工作区。
