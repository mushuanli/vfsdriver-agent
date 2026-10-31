# @itookit/nestos-node-driver

精确 turn 的已确认终态保存在原队列项 terminal 内，经既有 journal.save 持久化，重启可复用；不同 turn、未知提交与会话空闲本身不能解除队首屏障。inspect 的 lastTurnResult 必须与 lastTurnId 成对使用；空闲且队首缺终态时最多每 15 秒核对一次原生历史，无 inspect 能力也能核对。projection.reason 只解释等待条件，不改变执行准入。
事件读取失败时，已接纳且缺终态的队首仍独立核对历史，复用 15 秒节流，不受缓存 active 阻止；保留事件故障及发送屏障，不自动重放。回归见 tests/terminal-observation.test.ts。

平台无关的 nestos-node 接入层。文件与进程实现位于 src/files，同步 HTTP 协议与 harness MCP 协议归本包。不得依赖旧 vfsdriver-agent 包。
不得依赖 app-core、UI 或宿主 API。连接配置与目录授权策略归 app-core；凭据解析与 fetch 由宿主注入。
文件、同步与 harness 各自拥有生命周期。关闭控制面板只关闭客户端等待，不把连接断开当作 turn 已停止。
修改操作携带 epoch 与 requestId；结果未知时查询 receipt，不自动重放。
可信节点回执明确 not-committed 时，即使 code=EIO 也不能重新分类为 unknown。队列保留原接纳身份、失败状态及暂停；重开不自动派发，用户显式 retry 或 resume 才为失败项创建新的原生 attempt，原 requestId 的拒绝事实保持不变。resume 先拒绝任何 uncertain 项，再原子准备失败项重试及解除暂停；保存失败不派发。
原生命令由 profile.capabilities.slashCommands 协商，commands 查询会话目录、command 执行并沿用 receipt；不在客户端按 harness 名猜测命令或 RPC。命令与普通 turn 分开，命令可无 turnId；未知操作保存 inputText，核对接纳时只清理匹配草稿，保留后续输入。旧节点不宣称能力时不发新协议请求。
验证：pnpm --filter @itookit/nestos-node-driver test / typecheck。

FileStorageBackend 是文件契约；共享文件来源与独立执行会话分别持有生命周期。批量读的取消按订阅者隔离，最后一个订阅者离开才取消共享请求。
网络错误不能转换成不存在；响应必须验证，所有读取有容量限制。日志不记录 headers、凭据或正文。
目录监听失败与 profile 会话观察隔离；观察失败保留最近投影并标 stale/refreshError，只有传输失败证据或原生断开事件标 offline。events/list 各阶段使用相同传输证据，协议、权限错误与超时只标 stale。成功事件帧即恢复传输状态，不等待新事件；原生断开仍等待原生状态或权威快照恢复。诊断按阶段和安全错误码去重，不记录原始异常正文。
独立仓库不依赖 itookit 的 tsconfig 或私有源码；发布根、harness 与 sync 的 ESM/CJS/类型入口。

原生模型通过 profile.capabilities.models 协商，models 只投影安全目录及按模型区分的推理选项。selection 随 turn 或 prompt command 捕获，按当前目录验证，不映射为本地 Connection 档位；旧节点不发新查询，无效配置不提交提示词。


消息与 prompt 命令共用会话准备、版本化草稿接纳和提交后刷新；尚无会话时禁用 action。pending 保留原始输入及草稿版本，不能用规范化 slash 文本清理草稿。最近 64 个 commandId 结果进入恢复记录，原生同 ID 历史优先；回执接纳与 handler 成败分开。

HarnessRecovery 持久化最近已接纳的 submittedTurnId，重开后与 pending / draftRevision 一起核对输入；模型执行是否完成与提交接纳分开，不因 UI 关闭丢失接纳事实。

快照 forkSupport 区分持久能力与 canFork 的暂时可用性；仅在 checkpointFork 正向协商后声明 turn，否则沿用 fork 对应的 latest/none，不按 harness 名推断能力。forkAt 冻结 sourceSessionId/turnId 到原 pending journal，未知结果只查询原 requestId。已返回原生身份但边界未确认时保存 lastFork/forkFailure，不导航、不清草稿、不伪造未创建；原会话切换必须等回执持久保存。旧节点不发送 lastTurnId，发现失败标未发送。

可选 submissionId 将宿主冻结提交关联到 turn/command 的稳定 requestId；HarnessRecovery 保存独立 submission 的 pending/accepted/rejected 回执，准备子操作仍使用独立请求。核对 create/resume 只确认准备，不接纳未发出的 turn；接纳后存储失败保持 unknown，不能把存储冲突当作原生未执行。

0.4 使用按节点/凭据/授权版本共享的 fetch SSE；Harness、项目目录和进程订阅复用连接。eventSnapshot/directorySnapshot 是本地回放，refresh 是显式投影或权威核对；禁止恢复旧轮询 RPC 或按 active 状态增加定时请求。新增/关闭主题重连时带游标，断线不重放修改；单主题授权错误不能使其他主题离线。

SSE 的连接、主题与观察者故障分别处理；单个 next/error 回调抛错不能使其他订阅失效或阻断重连。HarnessEventFeed 与目录通知逐个隔离观察者，诊断只输出安全类别，不记录异常正文。

HarnessInstructionRuntime 将指令队列持久化到 HarnessRecovery，enqueue 接纳与原生 turn/command 回执分开。队列编辑带 revision，派发先保存领取，未知结果只核对原 requestId；明确拒绝后点击重新提交或继续队列才分配新的原生 attemptId。resume.retry 日志保留原 operationId、新 attemptId、阶段、结果与耗时。宿主共享控制面并保留后台观察，UI 关闭不拥有队列；snapshot 只投影排队附件名称。

队列的 createdAt、dispatchedAt、acceptedAt 分别记录持久接纳、派发领取及原生接纳时间，随原恢复记录与回执投影保存；旧记录缺失时不补造，重试清除旧 attempt 的派发/接纳时间。合并保留原接纳回执，只改变仍待发送的正文和附件；enqueue 默认 next-turn，仍等待当前 turn 的执行屏障；显式 delivery=auto 且正向协商 capabilities.steer 时，无模型选择或命令的普通输入可在当前轮内补充，不能越过暂停或前置 next-turn 项。派发先持久保存精确 steerTurnId，补充接纳不清除原轮终态屏障，回执带 kind=steer，不能用该轮第一条用户消息确认补充。原生 Claude 若在接纳前结束原轮，可返回 targetTurnId 与实际新 turnId；持久保存 steeredFrom 并按实际 turn 关联历史。未知结果只核对原 requestId，不自动重放或回退发送，既有队列与后来草稿保留。

命令 execution=query 可在 active 时直接查询，跳过 resume/adopt；旧目录缺失 execution 时保守串行。队列冻结定义 id/revision，发出 expectedCommand 后由原生节点复验；查询不能覆盖队列项自己的持久回执。异步命令需确切 turn 或 command 终态才续发，恢复时同样适用；scope/loaded 明确区分受控进程与外部历史。

HarnessControlLedger 在既有 HarnessRecovery.controls 保存精确 sessionId/turnId、独立 requestId/epoch 和接纳回执，原生 terminal 单独观察并持久保存。取消不占输入提交槽、不消费草稿、不隐式暂停队列；unknown 或 accepted 未确认终态时阻止冲突派发。reconcileControl 只查询原操作，不能重发。canInterrupt 不依赖发送 Promise，仍验证授权、可信观察及原生 interruptible；不据此声明 pause 支持。队列锁只覆盖领取、编辑与结算，远程等待在锁外，迟到响应按队首及 attempt 身份合并，不覆盖后续编辑。

capabilities.commandQueries 正向协商 harness_query；queryCommand/reconcileQuery 独立于输入 pending、busy、草稿及原生修改 receipt。查询报告保存到既有 commandResults，并带原生 sessionId 和定义身份；持久确认后才投影 queryReceipts。未知报告只重试保存，不重发修改、不以查询 ID 调用 harness_operation。旧节点不发新请求。

原生输入由公开 validateHarnessTurnInput / validateHarnessAttachments 在修改前严格校验；prompt 限制按 UTF-8 字节计算，图片同时核对 MIME、规范 base64 和文件签名。旧 HarnessRecovery 草稿及队列读取使用 readStoredAttachments，保持既有形状和容量限制，不以新发送规则阻断查询、取消或修复。真正派发再严格校验，失败显示具体原因且不创建/恢复/发送；未知旧操作仅核对原 requestId，不重新校验后重放。队列新增、文本更新、合并及显式重试均校验实际新输入；失败不改变原修订。严格校验器不是资产授权或远端文件准备凭据。

纯附件提交在队列与草稿中保留原始空正文，prepareTurnInput 只为实际原生 turn 生成确定性的文件名称提示；pending.inputText 和 draftRevision 仍核对原输入。纯输入校验错误带 not-committed 与具体 remoteCode，以便 RPC 和 UI 确认为拒绝；结果未知的旧操作仍仅核对。

capabilities.commandOutputs 正向协商 command/operation 的 outputMode=reference，旧节点不带新字段。HarnessCommandOutputRef 固定 version/epoch/requestId/bytes/sha256/text/plain；readCommandOutput 使用相同项目授权和固定引用，严格校验范围、规范base64、进度与EOF；loadCommandOutput 默认8MiB、上限32MiB，完整读取校验字节数和SHA-256，取消及读取错误局部化，不改 refreshError 或发送资格。普通输出按UTF-8保留最多64KiB预览；旧节点超限正文保留真实接纳/终态并明确 outputError，不能声称完整产物可读。

MCP 已确认 committed 后的解码错误保留 committed，原始回执只在模块私有 WeakMap 暂存，不进入异常属性、恢复记录、日志或广播。command ID/终态封套无效时，在原 commandResults 保存固定 operationId/epoch/resultError，submission 仍为 accepted；清理传输 pending 但保留派发屏障，允许查询和继续入队，禁止 retry 生成新 attempt 重放。原ID/epoch只读核对可修复，不消费后来草稿。最近64项窗口仅淘汰已收尾的展示项，不淘汰 resultError 或 running；查询压力和重开不能解除屏障。

native command 历史及事件以同 commandId 的稳定锚点合并；原生正文回显不能覆盖已固定预览/输出引用，迟到无ref或不同ref的更新不能替换原不可变产物。真实同ID终态可结束 running，但不能用其他命令或文字相同推断完成。command/turn结果ID在解码和队列恢复统一为最多1024字符。

capabilities.metrics 正向协商只读指标；refreshMetrics 独立于发送、队列、提交回执和 observation.refreshError，失败仅设 metricsError。累计 token 不替代当前上下文占用；额度属于远端账号，native-estimate 与宿主估算都不是账单。严格验证原生会话身份、数值和边界，剥离未声明字段；旧节点不发送新查询。

steer 的接纳回执不生成本地 steered: 用户消息；原生事件及历史是正文的来源，避免与宿主台账占位和真实回显并列重复。接纳仍按原 requestId 持久保存，不能为修复显示重发输入。

已有 thread/tokenUsage/updated 事件直接更新当前会话 contextWindow，使用 last 而非累计 total，不新增指标 RPC 或轮询。缺失占用保留 null，缺失容量撤下旧容量；非法事件只记录安全分类并保留已验证值，不影响发送。并发 refreshMetrics 返回时按本地 contextRevision 保留在途收到的新上下文，仍接收独立额度/费用字段。

executionRecovery 以节点实时原生状态与写锁为基准；超过60秒只展示人工恢复入口，不自动终结。recover 必须重新读历史/inspect，明确 detached 后按队列 CAS 将旧轮保存为 unknown 并暂停后续项；原运行时证据与恢复证据进入原 journal，不能伪造 terminal 或重放。无能力、未决提交/控制、占用与未知锁均拒绝。
