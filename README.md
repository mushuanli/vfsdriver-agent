# @itookit/nestos-node-driver

连接 [nestos-node](https://github.com/mushuanli/nestos-node) 的平台无关客户端。nestos-node 是 NestOS 的个人智能节点，将设备上的文件、项目和执行环境接入 NestOS；本包统一封装文件访问、项目管理、同步、进程与原生 AI harness 会话。源码仓库：[nestos-node-driver](https://github.com/mushuanli/nestos-node-driver)。

Web、Tauri、CLI 创建 `createNestOSNodeDriver()`，共用连接和运行期凭据。原 vfsdriver-agent 的文件与进程实现已并入 `src/files`，保留 revision、条件写入、流传输与隔离语义，发布包不再依赖旧驱动。HTTP 同步客户端通过 `/sync` 导出；harness 通过 `/harness` 导出并使用 MCP SDK 2.0.0、协议 2026-07-28。Codex app-server 和 Claude Code SDK 的原生协议留在服务端。

```sh
pnpm add @itookit/nestos-node-driver
```

```ts
import { createNestOSNodeDriver } from '@itookit/nestos-node-driver';

const adapter = createNestOSNodeDriver();
adapter.setCredential('workstation', password);
const connection = { endpoint: 'http://127.0.0.1:8787', username: 'owner', credentialRef: 'workstation' };
const harness = adapter.harness(connection);
const { profiles } = await harness.profiles();
const sessions = await harness.list(profiles[0].id);
await harness.close();
await adapter.dispose();
```

`setCredential` 返回恢复先前凭据的函数；密码不进入持久连接记录。凭据解析器可以异步注入；工厂第二个参数为 harness 的 fetch 注入点。三个能力分别管理生命周期；`sync()` 返回句柄由消费者关闭，`dispose()` 释放文件 provider 和尚未关闭的 harness 客户端。关闭控制面板不会中断服务端 turn，中断必须显式调用 `interrupt()`。

`ProjectClient.remount(project, access)` 调用 `project_remount`，携带现有项目 ID 和 revision，仅调整项目根的 `ro/rw` 权限。服务端验证导出授权和目录身份、拒绝在途执行并递增 revision；项目文件和原生会话保持保留。此方法为新增可选能力，旧服务返回不支持时由宿主保留原绑定。响应丢失后先 `read` 核对当前权限与版本，不盲目重复提交。

文件 stat 在同一微任务批次按路径去重，响应分发给各订阅者；重复的 VFS 祖先路径校验不会在同一 HTTP 批次重复提交。每个订阅者保留独立取消与期限，最后一个订阅者取消才中断共享请求。不跨批次缓存属性或不存在结果，外部文件更新仍在后续读取重新查询。

修改请求携带服务 epoch 和唯一 requestId。断网、超时或失去响应均不自动重放，错误保留 requestId，可用 `operation()` 确认收据。收据和接管关系为服务进程内状态，重启后必须重新发现 profile，不能跨 epoch 重放。每个 profile 保留至多 1024 条收据，不淘汰仍可能被查询的记录；达到上限拒绝新的修改。

当前支持 Codex 与 Claude Code 的会话分页、历史、新建、继续、消息、增量输出、中断、命令/文件审批和用户问题；Codex 另外声明分支、重命名和归档能力。其他 harness 通过服务端 HarnessPlugin/HarnessDriver 扩展，不改变宿主连接入口。配置和使用见 [nestos-node README](https://github.com/mushuanli/nestos-node#readme)。

验证：`pnpm --filter @itookit/nestos-node-driver test`、`typecheck`；`NESTOS_NODE_HARNESS_TEST=1 pnpm --filter @itookit/nestos-node-driver test tests/network.test.ts` 启动本地 Rust 服务和模拟 Codex，验证真实 MCP 网络链路，不调用模型。

客户端配置入口统一为“工具箱 → MCP”。通用管理器完成标准发现后，由 app-core 注册的 nestos-node 扩展验证 `server/discover._meta['itookit/nestos-node']`（兼容旧 `itookit/pi-agent`），获得同源文件 HTTP 端点、fileProtocol、serverId 和 harness 能力；旧服务只调用已声明的能力工具，普通 MCP 不发专用探测。测试、保存和改名复用验证结果，连接身份变化重新验证。原服务根地址只作为发现结果供文件/同步访问，用户填写完整 `/mcp` 地址。认证解析器也注入通用 MCP 客户端，每次请求读取当前凭据；API Key 使用 MCP 配置存储，项目只保存引用。

driver 独立使用 `discover()` 时也优先消费 SDK 已连接的标准发现元数据，避免额外能力调用；无元数据时依次尝试 nestos_node_capabilities、piagent_capabilities、fsagent_capabilities，仅工具缺失时尝试下一个名称。元数据不合法时拒绝，不绕过校验。


`projects(connection)` 提供服务端目录项目的 roots/list/read/register/configure/exec。`register({alias,path,name,access,createDirectory:true})` 在已有父目录下创建一个目录并注册；不创建所有父目录。项目客户端的 `harness(project,{readOnly})` 继承项目 ID/revision，开放对应 profile 的项目 workspace。`projectProcess` 复用原进程取消与回收逻辑，启动时改走服务端项目授权。文件 open 传入 serverProjectId/serverProjectRevision/access 后添加项目上下文 headers；普通文件与旧服务访问保持兼容。

方案及部署见 [项目模型](https://github.com/mushuanli/nestos/blob/v5.3/doc/design/nestos-node-project-model.md)。

Directory materialization is available when discovery returns `directorySync: true`.
Use `projects.directorySync()` to bind a published files dataset to an existing
writable project directory, preview, then execute the returned plan ID. Keep the
binding ID stable. Upload completion and directory application are separate
outcomes. On timeout or partial failure, query `status` and resume the retained
plan; never replace an `applying` plan. Deletes and project mounts are excluded.

目录同步客户端提供目录浏览、方向 CAS 配置、带来源／目标的计划、冲突正文比较与选侧后重新预览。旧服务器只能执行其声明支持的单向能力。nestos_node_capabilities 是主发现工具；旧 piagent_capabilities、fsagent_capabilities 与旧 MCP 扩展继续兼容读取。共享 vfs-sync manifest 和文件 HTTP 协议保持已有编码。

## 文件与进程接口

包根保留 `HttpFSBackend`、`openHttpFileSource`、`createHttpSourceProvider`、`HttpTransport`、`HttpProcessSession` 和 `HttpSeqClient`。迁移旧 npm 引用时将 `@itookit/vfsdriver-agent` 改为 `@itookit/nestos-node-driver`；这些接口的所有权和文件协议保持一致。统一装配优先使用 `createNestOSNodeDriver()`。

`HttpFSBackend` 实现 `FileStorageBackend`，由 `FileStorageAdapter` 接入 VFS。文件来源按 endpoint、身份和 alias 共享初始化，每次 `open()` 返回独立释放句柄。订阅者取消不会中断其他读取，最后一个引用释放后关闭来源。进程 owner 由执行上下文显式 `release()`，关闭文件视图不表示命令已结束；无法确认退出时保留进程 ID 供重试清理。

`src/files/protocol` 负责响应校验，`transport` 负责认证、预算、取消和错误映射，`provider/source-pool` 负责共享生命周期。网络错误不转成不存在；损坏的写入响应属于未知结果，携带 operation ID，不自动重放写入。内部模块不作为发布子路径导出。

原生历史支持 `read(profile, session, {cursor})` 分页，`inspect` 只读元信息。`HarnessConversation.loadEarlier` 加载更早消息，`branches` 按原生父会话链接列出同一项目中的分支，`fork(name)` 创建原生分支并返回新会话身份，交给宿主切换。只读、空历史、活动或待确认会话不能创建分支；未知结果先查询 receipt，不重复创建。创建与切换不产生本地 Session 或复制历史。

`HarnessSession.createdAt` 与 `updatedAt` 分别表示创建及最后修改的 Unix 毫秒时间，缺失为 null；createdAt 为可选字段以兼容旧服务。驱动统一转换旧服务的秒时间，从 native.createdAt 恢复缺失的创建时间，不用修改时间冒充创建时间。空标题可回退 native.name/preview，展示层使用未命名会话兜底，原生 ID 继续用于路由与操作。

会话消息保留原生 `turnId` 和毫秒 `timestamp`，内容数组中的所有请求、回复均按顺序展开；用户文字项还通过 contentParts 保留边界，展示层在项间插入 Markdown 分隔线，plain-text 预览保持原格式。服务提供 `contentItemKinds` 时，驱动校验数量和类型后按文本展平规则映射为 `contentPartKinds`，不推断缺失来源、不改变原文，由宿主决定上下文折叠。`branchName` 独立于会话标题，根分支使用 main。`HarnessConversation` 为历史和事件请求 `toolDetail: 'summary'`，工具仅保留名称、操作、首个非空命令行（最多 240 个字符）和目标路径，忽略工具输出增量；旧服务的详细工具数据也在驱动内转换为摘要。`loadEarlier` 合并稳定 ID 并拒绝循环游标，刷新和事件恢复保留已加载的早期页面。itookit 在历史顶部提供按需分页入口，点击才读取更早记录，保留加载进度及失败重试入口。总容量为 10,000 条/32 MiB，超过时明确失败并保留现有内容与游标，不静默裁剪。宿主按轮次把请求与该轮全部响应分别投影为一个 Markdown 编辑器。驱动不生成产品界面或改写原生历史。

## 独立开发与发布

```sh
git clone https://github.com/mushuanli/nestos-node-driver.git nestos-node-driver
cd nestos-node-driver
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

TypeScript 配置与依赖独立于 itookit。发布仅包含 `dist`、README 和许可证，根、`/harness`、`/sync` 均提供 ESM、CommonJS 与类型声明。`publishConfig` 使用构建入口；仓库内源码入口用于开发，不进入发布 manifest。

纯单元测试不要求 Rust。Linux 下可指定独立服务器 checkout 进行真实文件与 harness 验证：

```sh
NESTOS_NODE_MANIFEST=/path/to/nestos-node/Cargo.toml pnpm exec vitest run tests/files/network.test.ts
NESTOS_NODE_MANIFEST=/path/to/nestos-node/Cargo.toml NESTOS_NODE_HARNESS_TEST=1 pnpm exec vitest run tests/network.test.ts
```

itookit 内自动发现 `tools/nestos-node`。文件进程隔离测试还需 `NESTOS_NODE_PROCESS_TEST=1`；harness 网络测试使用模拟 Codex，不调用模型。旧协议标识和历史数据保持兼容，旧包的已发布版本不会被覆盖。


## 只读状态与搜索

交互请求保留选项说明、多选、自由回答与密码输入语义，未知结构显式投影为 unsupported。初次 read 会取得未解决请求，重新打开网页仍显示待答框。respond 有独立于 turn/command 的回执记录，允许在启动响应返回前回答审批；未知结果只核对原 requestId，恢复记录不存回答正文。应用宿主应让事件读取和回复穿过等待中的启动调用，普通写操作仍保持串行。

原生历史可携带 `eventCursor: {after, eventEpoch}`，表示快照已包含的事件边界。HarnessConversation 从该边界读取后续增量，事件缺口修复后不倒退游标；旧服务未提供该字段时沿用原有兼容路径。执行中的 Codex 快照由服务端读取原生运行状态，避免只读取尚未写入完整回答的历史文件。

已接纳队首缺少精确 turn 终态时，即使事件读取失败，也会独立尝试原生历史核对（最多每 15 秒一次）；不以缓存的 active 状态阻止重启后的核对。核对成功仍保留事件故障提示并阻止新派发，仅持久结算原 turn 的已确认终态；无终态、其他 turn 或读取失败均保留队列，不重放输入。`turn.history.reconcile` 的 `events_fallback` 阶段记录 confirmed/unconfirmed/failure、安全错误码及耗时。

多关键字查询以空格/制表符分隔，按不区分大小写、顺序不限的字面 AND 匹配；文件内容以命中行为单位，原生会话内容以消息为单位。文件 discovery metadata 与原生 profile 分别用 `searchKeywords: true` 声明该语义；driver 在含分词空白的查询发送前核对能力，避免旧节点静默按整段短语搜索。显式换行保留原有字面多行语义。

`adapter.observeHarness(projects.harness(project, {readOnly: true}), false)` 创建共享 `HarnessStatusObserver`，subscribe 接收更新通知，refresh 返回 profile/session 的 `HarnessObservation`；仅使用有界列表和事件，不读取每行历史、不 resume。execution、最近结果、连接、时效和控制能力分别返回。`close()` 释放底层客户端，关闭界面不停止原生 turn。

第三个参数 `{watchFiles: false}` 可关闭文件目录观察，让会话状态读取与文件刷新独立。目录版本只返回服务端真实版本；覆盖不足不再拼接随时间变化的版本号。是否继续轮询由应用层按活动轮次和展示订阅决定，本驱动不启动定时器。

目录监听故障只保留最近目录版本，不改变会话在线状态。各 profile 的观察错误独立隔离；状态解析、权限或超时错误以 `stale` 和 `refreshError: {stage, code}` 返回，连接失败证据或原生断开事件才标记 `offline`。成功的空事件响应也能恢复传输状态；原生进程断开仍需原生状态或权威快照确认恢复。错误期间不开放中断/响应控制；诊断只记录阶段、身份和安全错误码，并按阶段去重。

服务描述 `fileSearch` 为 true 时可调用 `projects.search(project, {query, mode: 'name' | 'path' | 'content', directory?})`。profile.capabilities.search 为 true 时可调用 `harness.search(profileId, {query, mode: 'title' | 'content' | 'prompt', archived})`。两者返回 matches/truncated/nextCursor；当前 nextCursor=null，超限明确部分结果。原生命中保留 sessionId/turnId/itemId；文件命中使用相对路径和行号。查询只读、默认字面匹配，调用方继续核验授权身份、取消及结果时效。


### 原生管理与附件

Codex profile 声明 rename/archive/unarchive 与 attachments 能力。`harness.rename` 修改原生标题，`harness.archive(profile, session, true|false)` 归档或恢复；均使用修改回执，未知结果不自动重发。归档要求本服务持有且明确 idle，恢复不会获取控制权。`HarnessConversation` 输出管理可用性、归档标记及标题通知。

`turn` options 可传 `attachments`（kind/name/content/mimeType）：文本为 UTF-8 内容，图片为 PNG/JPEG/WebP data URL。最多 5 个，文本每个 64 KiB、图片解码每个 256 KiB、编码内容合计 512 KiB；不传宿主路径或 HTTP URL。会话 journal 保存未发送附件草稿，确认 turn 回执后清空，未知结果保留但禁止重发。`HarnessStatusRow.fileVersion` 只在文件变更完成、turn 完成及重连快照修复时推进，供宿主合并目录刷新。


`HarnessClient.subscribeDirectory()` 通过共享 SSE 接收目录失效，`directorySnapshot()` 只读取本地最近版本；`subscribe(profile, listener)` 和 `eventSnapshot(profile, cursor)` 同样分离通知与本地回放。真实网络订阅按节点、凭据引用和授权版本共享；增加或移除主题会携带当前游标重新建立流，不重放任何修改。传输断线退避重连，错误按主题隔离；旧节点明确提示升级，0.4 不保留事件或目录轮询 RPC。文件覆盖不足以 truncated 明确表达，不用时间制造版本。`HarnessStatusObserver.fileVersion()` 与会话列表分离，零会话项目也能观察文件。单个 Claude 子进程断线只影响对应 thread。

原生 Codex 管理包含 rename/archive/unarchive/delete。永久删除沿用 epoch/requestId/receipt，客户端持久化删除标记；恢复时先核对删除回执，避免重放或读取已删除历史。notLoaded 的执行状态保持 unknown，归档原生历史不代表停止独立 CLI。

`HarnessSession.archiveAllowed` is optional native management eligibility, separate from attachment ownership. `harnessArchiveAllowed` combines this hint with idle/archive guards; conversations additionally require writable access, profile support and a current connection. Older nodes retain the conservative unloaded-or-owned-idle rule. Hosts can reuse the helper for navigation menus without branching on harness kind; the server rechecks permission and native state when committing an archive.

`HarnessConversation.snapshot().submittedTurnId` 保留本视图最近一次已确认发送的原生轮次身份，历史尚未回显时也可供界面替换临时卡片；开始新发送时重置。只有 turn 成功或对应 committed 回执才设置，resume/create 成功不算消息已提交。原生 `HARNESS_SESSION_BUSY` 拒绝恢复时保留草稿，不调用 turn。

历史、模型目录、profile 或会话检查在提交前失败时，返回 `not-committed`，不能留下待确认的消息提交。原生请求已经发出但响应丢失时，保留原 requestId/epoch 并查询回执，不重放。被拒绝的 submission 可携带安全 `code`，使跨视图核对后仍能展示原生写锁原因。

### Native usage

`HarnessSession.usage` and conversation snapshots carry validated native transcript usage from nestos-node 0.1.5+. `HarnessClient.usage(profileId, sessionId)` queries the read-only tool directly; ordinary viewers reuse the usage piggybacked on history/inspection. Unsupported older servers leave usage absent. The client validates session identity, safe nonnegative token counts, unique entries and matching totals. Input/cache buckets are disjoint, reasoning is already part of output. This package has no model catalog, pricing fallback or billing policy; hosts may decorate snapshots with their own estimates.

### Directory principals and public access (0.2)

A connection can explicitly set `anonymous: true` to access public read-only exports. The driver omits Authorization and never resolves a credential in this mode; a failed authenticated request never falls back to anonymous access. Authenticated connections continue using Bearer or Basic credentials supplied by the host.

Discovery exposes an optional `authorization` snapshot (`principalId`, `anonymous`, `revision`). Pass it on the connection to fence subsequent HTTP and MCP requests to the same identity and grant revision. Source pooling includes this snapshot and anonymous mode. A changed grant requires explicit discovery and refreshing the binding; it cannot silently reuse another user's view. The pure `@itookit/nestos-node-driver/authorization` entry validates snapshots without loading the MCP runtime.

Projects expose optional effective capabilities for file reads/writes, execution and session control. A read-only file mount can permit native conversation control when the server grants execution separately. Servers without these fields retain the host's conservative legacy behavior. The driver implements transport and validation; directory ACL policy and user-to-credential binding belong to the server and host respectively.

文件名与目录范围要求服务发现 `fileSearchVersion >= 2`；directory 为项目相对目录（不含前后斜线、`.`、`..`），搜索包含其子目录。driver 在旧服务上明确拒绝新范围，不接受被静默忽略的参数。仅用户提问要求 profile 的 `searchPrompts`；content 继续包括用户与助手正文，prompt 由服务端按原生消息角色和显式来源过滤。

## Native command catalogs

Profiles may advertise `capabilities.slashCommands`. `HarnessClient.commands(profileId, sessionId)` reads that harness session's catalog; `command(profileId, sessionId, name, args, options)` uses the existing epoch/requestId mutation receipts. `HarnessConversation.commands()` and `command(name, args)` expose the same capability to hosts. A command can complete without creating a model turn; DSH results become native system records, and ordinary send remains separate.

Commands require an initialized native session. Catalogs are bounded and validated, and no client-side harness-name switch guesses available commands. Without the capability, older nodes receive no new catalog request. Unknown commands never trigger an automatic model fallback. Unknown command receipts persist across reopening; accepting the original command preserves newer draft text and attachments.


## Native model selection

Profiles opt in with `capabilities.models`. `HarnessClient.models(profileId, sessionId?)` returns a bounded, validated `HarnessModelCatalog`: opaque IDs, display labels, per-model reasoning options, and optional default/current selections. `HarnessConversation.models()` returns an empty catalog for older nodes without issuing a new RPC. No model list or reasoning enum is hardcoded in the client.

`HarnessConversation.send(text, attachments?, selection?)` and `HarnessClient.turn(..., {selection})` capture `{modelId, reasoningEffort?}` for that submission. Invalid combinations fail before admission; model discovery is read-only and does not grant session control. The native adapter repeats validation. Prompt-kind commands accept the same selection through `command(name, args, selection)`; action commands retain native semantics. Lost mutation responses keep the existing receipt/reconciliation behavior and never trigger automatic replays.


`HarnessConversation.command(name, args?, selection?, inputText?)` preserves the original composer text separately from parsed arguments. Prompt commands lazily prepare a session through the same path as messages; session actions are disabled until a native session exists. Recovery captures the draft revision and original text, so confirmed receipts cannot erase later edits, including edits restored to identical text. Recent command results (up to 64, with UTF-8 previews bounded to 64 KiB) survive refresh and reopening. Active commands and committed result errors are protected from window eviction. Native history with the same command ID updates its state while preserving a previously frozen output reference. A failed handler can still have a committed receipt and must not be replayed.

### Native command outputs and committed result errors

`capabilities.commandOutputs` enables reference projection on command execution and receipt reads. The client sends `outputMode: 'reference'` only after positive negotiation; older nodes receive their original request shape. A result may contain `outputRef: {version: 1, epoch, requestId, bytes, sha256, mimeType: 'text/plain'}` plus a bounded preview. The full body remains in the node's original epoch receipt. `HarnessClient.readCommandOutput(profileId, ref, {offset, limit, signal})` reads at most 65536 bytes per page, preserving the original project authorization and epoch. Pages require canonical base64, matching immutable metadata, exact offsets and forward progress.

`HarnessConversation.readCommandOutput(commandId, options)` resolves only a retained result reference; `loadCommandOutput(commandId, {maxBytes, signal})` freezes that reference for the whole read, checks the final byte count and SHA-256, and returns an ArrayBuffer. The default download budget is 8 MiB and the maximum explicit budget is 32 MiB. Reads never repeat native commands or reload full native history. A failed download is local to the requested output and does not disable sending. Output references do not survive node epochs automatically; this API is not permanent Artifact archival.

Messages with large results carry `commandOutput: {commandId, ref?, unavailable?, truncated}`. Older nodes returning oversized inline output produce a bounded preview with `unavailable.code=HARNESS_COMMAND_OUTPUT_TOO_LARGE`; the driver preserves native acceptance and completion but does not claim that the full old output can be downloaded. Node references and previews survive exact-ID native history and event echoes.

A matching `committed` receipt remains committed even when its result cannot be decoded. Command identity/completion errors are persisted separately as `snapshot.resultError` with the original operation ID and epoch; the input is accepted, transport pending clears, and conflicting dispatch stays blocked. Read queries and queue acceptance remain available. The affected queue item cannot be retried as a new execution. Reconciliation reads only the original receipt and may repair the projection without consuming later drafts or reissuing side effects. Invalid result bodies are never copied into diagnostics or recovery records.

## 从 piagent-driver 迁移

包名改为 `@itookit/nestos-node-driver`，首选工厂为 `createNestOSNodeDriver()`，类型为 `NestOSNodeDriver` / `NestOSNodeDescriptor`。包根保留 `createNestOSNodeClient` / `NestOSNodeClient` 和更早的 PiAgent 别名供迁移。源码仓库统一为 `mushuanli/nestos-node-driver`。旧包的已发布版本保持可用。新客户端兼容新旧发现描述与能力工具，HTTP 授权头、协议编码和持久身份不迁移。

包名由 `@itookit/nestos-node-client` 更名为 `@itookit/nestos-node-driver`；更新依赖与 import 路径，首选 `createNestOSNodeDriver()`。旧 npm 包的已发布版本不变，持久连接、授权和原生会话身份不迁移。

### 共享事件传输

节点 0.4 与 driver 0.4 配套使用。`POST /v1/events` 使用正常认证 header，订阅和游标位于请求体；凭据不进入 URL。每条连接最多 32 个订阅，UTF-8 SSE 帧有容量限制和 45 秒无活动检测。会话视图接收通知后合并刷新，不再执行 200ms 轮询；远程进程通过终态订阅等待，状态 GET 仅保留恢复查询。关闭观察不取消原生 turn；进程所有者 release 仍明确取消并等待监管完成。


### Independent native cancellation

`HarnessConversation.interrupt({sessionId, turnId, operationId})` freezes an exact native target and writes an independent control receipt before dispatch. `reconcileControl(operationId)` queries that original operation and epoch without replaying cancellation. `snapshot().controls` separates `receipt` (`unknown`, `accepted`, `rejected`) from the observed `effect` (`unconfirmed`, `completed`, `failed`, `cancelled`). Acknowledgement does not prove termination. Recovery uses the existing journal, preserves input drafts and pending sends, and retains exact terminal observations across reopening.

A suspended send reply does not block queue edits or native cancellation. Cancellation itself does not pause the queue; hosts can persist an explicit queue pause before requesting cancellation. Unknown controls and acknowledged controls without terminal evidence prevent conflicting dispatch. Hosts must pass the explicit operation identity when reconciling UI operations and must keep native capability and ownership checks. Pause and steering are separate capabilities. With positively negotiated `capabilities.steer`, `conversation.steer(text, turnId, attachments, submissionId)` appends context to the exact owned active turn. Its stable request ID, target and draft revision use the existing recovery journal; unknown results are reconciled without replay. Steering preserves queued instructions and later composer edits. Renaming native metadata does not require an empty instruction queue.

### Recovering completion from native history

Terminal history turns may carry `submissionEvidence` version 1 with `requestId`,
`promptSha256`, `startSequence`, and `endSequence`. The server derives this evidence
from a complete ordered native turn in the returned page; the client never infers
completion from assistant message text or native idle alone. Older nodes can omit it.

For an already admitted, attachment-free prompt whose original turn identity equals
its request ID, `HarnessConversation` matches the retained instruction against this
provenance before recording its terminal result. Mismatched Session, input digest,
duplicate request evidence, malformed boundaries, or attachment-bearing inputs cannot
release the old claim. Normal turn IDs and native completion events keep their existing
meaning. Evidence does not create another execution, mutate native history or consume
the next draft.

`reconcile(originalId)` can persist settlement of the admitted head. It does not dispatch
an instruction that was only queued, replay an unknown operation, or start later queued
work. Queue pause is preserved. Missing old history requires explicit `loadEarlier` and
another reconciliation; no unbounded automatic scan is introduced. A failed settlement
write keeps the original claim recoverable. Merely completed assistant items no longer
substitute for terminal turn facts.

A history refresh may reuse a recorded terminal result only under the same turn ID.
A newer lastTurnId without a result cannot inherit a previous turn’s completion.


Queued execution never owns the current composer draft. Dispatch uses the same validated
native input path as a direct send, but neither replaces the draft with the queued input
nor consumes the draft when native admission arrives. The pending journal stores
`consumeDraft: false` so reopening and late receipt reconciliation preserve this boundary,
even when the next draft has identical text. Legacy direct sends keep their existing
revision and input matching rules. Queue admission and the host OperationLedger remain
the authority for consuming the submitted editor draft.

文件 HTTP 错误保留标准 VFS `code`，并以 `remoteCode` 传递经过格式校验的服务端原因（如 `METADATA_IO`）。只有状态码或服务端错误码时，默认提示包含二者，便于区分网络连接失败与已送达的服务端异常。

Native metrics are separate from transcript totals and host pricing. Positively negotiated `capabilities.metrics` enables `conversation.refreshMetrics()` / `client.metrics(profileId, sessionId)`. The read-only query validates session identity, bounds and numeric values and strips unknown fields. Observations include context capacity/last occupancy, native quota windows/reset times/credit units and optional native cost estimates. Missing values stay unknown. Metrics queries do not consume drafts, acquire the submission slot or change the execution observation on failure; `metricsError` is local to the metrics display.

`enqueue(text, attachments, selection, submissionId, delivery)` defaults to `next-turn`. Explicit `auto` delivery permits plain queued input to supplement the owned active turn when steering is negotiated; model changes, commands, pauses and preceding next-turn items retain their barriers. A steering receipt confirms admission, not turn completion. Claude may acknowledge the input in a new native turn if the targeted turn has already ended; `targetTurnId` preserves the requested target and `turnId` identifies the actual turn. Unknown receipts are reconciled without replay.

### 精简会话分析接口

正向协商 `profile.capabilities.sessionDigest` 后可调用 `digest(profileId, sessionId, {cursor?, expectedRevision?, metadataOnly?})`。
该接口不调用模型，只返回来源明确的用户提示词和可见助手正文，排除自动上下文、推理和工具。`omittedUnclassified` 大于零表示存在无法确定来源的用户记录，分析调用方不得把它当作完整输入。`metadataOnly` 不读取历史；分页绑定 `revision`，源变化明确报错。旧节点不回退全量历史。此接口继承项目 ID/revision 与读取授权，不恢复或启动原生执行。

### 执行结果未知时的人工恢复

原生事件另投影 `observation.activity`（turnId、phase、updatedAt），仅用于展示思考、工具执行、回复输出、上下文整理或等待下一次输出。空正文 reasoning item 也可更新阶段；旧轮次和倒序事件不能更新当前轮次。该字段不改变执行状态、队列屏障或终态；updatedAt 来自实际事件，不能用 inspect、心跳或本地计时刷新。

Codex 的 `session.historyRevision` 独立于本运行时的事件游标，表示原生持久文件的版本。既有 15 秒 inspect 发现版本变化时，外部会话补读历史；内部空闲会话在没有近期内容事件时也补读，内部执行中的流式事件路径保持不变。成功读取后才更新 `observation.historyRevision`，失败保留原消息、原版本并显示具体错误。事件故障的历史核对也覆盖没有队首的会话，不接管原生执行、不重发输入。

远程执行以节点原生状态、写锁与历史为准，httpd 的持久队列只记录提交及调度事实。协商 `capabilities.executionRecovery` 后，节点在历史与 inspect 的 `session.executionRecovery` 返回运行时身份、PID、启动时间及 running/detached/unknown。只有原生会话 notLoaded、未被本节点接管、没有 activeTurnId 且写锁确认为 not-held 时才声明 detached；PID 或锁文件缺失本身不充当 turn 终态。

已接纳队首等待超过 60 秒仍没有精确终态时，队列投影提供 `recovery.id`。界面经二次确认调用 `editInstructionQueue({action:'recover',id,expectedRevision})`：先读原生历史并重新 inspect，不依赖 httpd 缓存；真实终态正常结算，否则仅允许 detached 的普通已接纳 turn 结束等待。原生仍运行、写锁占用/未知、未决提交或控制操作、命令及身份冲突均拒绝。恢复决策以 outcome=unknown、原 turn/attempt、节点证据和时间存入原 journal 的 instructionQueue.recoveries（最多64项，不自动淘汰），已接纳输入同时保存可用的原运行时证据；保存失败不移除队首。

Codex rollout 的终态可能以仅含 id/status、items 为空的轮次返回；客户端仍按精确 ID 结算，不要求有助手正文。重开会话不能把缺失终态当完成；人工 unknown 恢复和后续暂停均从原 journal 恢复，保存失败保留原队首。

恢复不产生 completed/cancelled，不重发旧输入、不清除后续草稿；后续队列暂停，用户检查已有修改后发送新的继续指令。重新发送沿既有 inspect/resume 接回同一原生 Session。正常 interrupt 只针对单个 session/turn；当前共享 Codex app-server 的强杀会影响同一执行器的其他会话，本接口不将其包装为单会话重启。
