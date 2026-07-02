# P1-2 断点续传（resumable transfer）— 设计

> 来源：`docs/optimization-requirements-2026-07.md` P1-2 第三件套。
> 决策（已确认）：**同会话重连** + **按 chunk 粒度** + **自动重连续传**。不跨刷新持久化。

## 目标与边界

- 一次传输（LAN 实时 / 配对码 / 分享链接）进行中，WebRTC 连接**彻底断开**（掉线、休眠、切网，连 ICE-restart 也救不回，`connectionState` 到 `failed/closed`）时，不再整批失败，而是**自动重建连接并从上次已落盘的字节继续**。
- **同会话**：两端页面都保持打开；已收字节（接收端 sink）、进度、密钥都在内存。刷新/关页不在范围（需持久化存储层，单独立项）。
- **按 chunk**：单个大文件也能从中断的 chunk 边界续传，不整文件重传。
- 边界：若信令 socket 也断且长时间不恢复、对端离开房间，则超时后判失败（现有行为）。续传依赖信令在合理时间内恢复、双方仍在同一房间。

## 一、加密安全性（关键）

现状：只有**文件发送方**用 `keys.send`（AES-GCM）加密，nonce 由全局 `seq` 计数器生成（`crypto.ts` `nonceFromSeq`）；接收方只用 `keys.recv` 解密；控制帧（ACCEPT/REJECT/COMPLETE）是明文单字节。**加密方唯一**。

推论：**只要发送方的 `seq` 单调递增、永不回退，就绝不会 nonce 重用**，AES-GCM 安全。

因此续传**复用原握手已认证的临时密钥**（`keys` + SAS）：
- 重连时**跳过 commit-reveal 握手**，直接建立新的 DataChannel 复用现有 `keys`；SAS 不变，用户**无需重新核对校验码**（原始信任延续）。
- 发送方的 `seq` 变为 **Sender 实例字段**，跨多次重连**只增不减**：重连后从「历史用过的最大 seq + 1」继续。中断时在途丢失的那些 seq 被「烧掉」（用过一次、永不复用）。
- 无需密钥棘轮（ratchet），无需重新握手求密钥——比新建连接更简单也更安全。

**MITM 考量**：重连跳过握手是安全的，因为密钥在最初已通过 commit-reveal + 用户 SAS 核对锚定；重连只是用同一对已认证密钥建新传输通道，信令中继无法注入新密钥（它没有私钥，无法产出能通过 AEAD 的密文）。

## 二、协议层（`transfer.ts`，纯逻辑、可单测）

### 新帧类型
- `KIND_RESUME_START = 4`（发送方→接收方）：JSON `{ index, offset, seq }`——「从文件 `index` 的字节 `offset` 续传，chunk 从 nonce `seq` 开始」。
- `KIND_RESUME_REQ = 5`（接收方→发送方）：JSON `{ index, offset }`——「我已落盘到文件 `index` 偏移 `offset`，从这里续」。

### Sender 改动
- `seq` 提升为实例字段（跨 `dataFrames`/续传持久、单调）。
- `dataFrames(files, keys, resume?)`：`resume = { index, offset }` 时——跳过 `< index` 的文件（已完成）；对 `index` 号文件**从 0 读并链式哈希、但只 yield `offset` 起的 chunk 帧**（保证 DONE 是整文件链哈希，同时不重发已收部分）；`> index` 的文件正常全发。所有 yield 的 chunk 用单调 `this.seq`。
- 暴露 `resumeStartFrame(index, offset)` → 生成 `KIND_RESUME_START` 帧，携带当前 `this.seq`（在 yield 首个续传 chunk 前）。
- `resumeReq(index, offset)`（静态/工具）→ 生成 `KIND_RESUME_REQ` 帧。

### Receiver 改动
- `feed()` 处理 `KIND_RESUME_START`：`this.expectedSeq = seq`；恢复当前文件链哈希为**接收方自存的 checkpoint 快照**（见下），返回 `{ resume: { index, offset } }` 供 App 对齐。
- 暴露 `snapshotChain(): Uint8Array`（当前文件链哈希拷贝）与内部 `expectedSeq` 的 resume 设置，供 App 做一致性 checkpoint。
- 解析 `KIND_RESUME_REQ`（发送方侧用工具函数解码）。

### checkpoint 一致性（接收方）
链哈希与已落盘字节必须对应**同一批 chunk**。App 在**每个 chunk `await sink.write()` 成功之后**记录 `checkpoint = { index, offset: got, chain: receiver.snapshotChain() }`；文件切换在 `openSink(i)` 成功后置 `{ index: i, offset: 0, chain: zeros }`。若断线发生在 `feed()`（已推进内部哈希）与 `sink.write` 之间，续传时用 checkpoint 快照把接收方哈希**回滚**到最后落盘点，与 `offset` 一致；在途那一个 chunk 由发送方从 `offset` 重发。sink 全程保持打开（FSA writable 续写、blob parts 续存），**绝不重开**（重开会截断）。

## 三、连接重建（`webrtc.ts`）

新增 `connectResume(opts)`：做 SDP offer/answer + DataChannel + ICE + 超时 + ICE-restart，但**不做 commit-reveal / onPeerKey**（密钥由 App 复用）。与 `connect()` 共享传输内核（抽取公共 `establishChannel` 辅助，或有限复制以保清晰）。返回同样的 `Conn`（含已加的 `path()`）。角色沿用：发送方 initiator（发 offer）、接收方 responder。

## 四、编排（`App.svelte`）

### 接收方
- 连接失败且**传输进行中、非用户取消**时，不再 `failRecv`，改置状态 `reconnecting`，**保留** sink/target/manifest/keys/selfKey/receiver/checkpoint，登记 `pausedRecv = { from, resume }`。
- 全局 `onSignal`（现有：offer→`beginReceive`）改为：来自 `from` 的 offer 若命中 `pausedRecv`，路由到 `resume(offer)`；否则新建 `beginReceive`。
- `resume(offer)`：`connectResume`（responder，复用 keys）→ 重装 `channel.onmessage=feed`→ 发 `KIND_RESUME_REQ {index, offset}`→ 收 `KIND_RESUME_START` 对齐 → 继续原 `handleFrame` 循环写 sink → 正常收尾。

### 发送方
- 连接失败且**进行中、非取消**时，置 `reconnecting`，进入**带退避的重试循环**：反复 `connectResume`（initiator，复用 keys）到 peer；成功后重装 handler，等接收方 `KIND_RESUME_REQ`，据其 `{index, offset}` 发 `resumeStartFrame` 再 `dataFrames(files, keys, {index, offset})` 续流；直至完成或**总超时**（如 60s / N 次）判 `sendFail`。
- 发送方跨重连保留：`files`、`keys`、`sender`（含单调 seq）、状态。

### UI
- 复用现有 `reconnecting` 措辞或新增 `resuming` 状态文案（6 语言）：「连接中断，正在重连续传…」。进度条**保持**在已传位置不清零。

## 五、测试策略

- **协议层单测（核心，务必充分）**：
  - Sender 续传：`dataFrames(files, keys, {index, offset})` 跳过已完成文件、当前文件从 offset 起 yield、DONE 仍为整文件链哈希；seq 单调不回退（含跨两次续传）。
  - Receiver：`KIND_RESUME_START` 后 `expectedSeq` 对齐、链哈希回滚到快照、续流后整文件 SHA-256 校验通过。
  - **端到端往返（关键）**：Sender→Receiver 正常传一半→模拟断点（丢弃在途 chunk、记录 checkpoint）→用 checkpoint 走续传路径→最终重建文件字节与整文件哈希均正确；覆盖「断在文件中间」「断在文件边界」「断在最后一个 chunk 前」。
  - seq 单调 / nonce 不重用的断言（记录所有用过的 seq，断言无重复）。
- 连接重建与 App 编排（`connectResume`、掉线自动重连、SAS 不变）走**手动 verify**：WebRTC 状态机、真实掉线/切网无法在 jsdom 驱动。

## 六、实施顺序

1. **协议层**（Sender 实例 seq + resume 帧 + Receiver resume/snapshot）+ 充分单测（含端到端断点往返）。
2. **`webrtc.ts` `connectResume`**（+ 复用内核）。
3. **App 编排**：接收方 pausedRecv/resume 路由；发送方重试循环；checkpoint；UI 文案。
4. 手动 verify：双设备真机断网续传、SAS 不变、进度不清零。

## 七、风险 / 取舍

- 触及加密关键路径：**seq 单调不回退**是安全根基，须有单测断言 nonce 永不重用。
- App 编排改动最大、最易出错（现有 send/recv 已是数百行精细异步）；协议层用单测兜底，编排靠 verify。
- FSA writable 跨断线保持打开是「同会话」可行的前提；一旦页面刷新即失效——这正是本轮不做跨刷新的原因。
- 信令长时间不恢复 / 对端离开房间 → 超时判失败（可接受，退回现有行为）。

## 八、多智能体代码评审后的加固（2026-07-02）

四个评审 agent（逐行 / 时序竞态 / nonce 安全 / 移除守卫）核对后确认 nonce 安全根基成立，并修掉了以下真实缺陷：
- **重连重入**：`resuming` 标志 + 进入时即清 `pausedRecv`，重复/ICE-restart offer 不再生成第二个 `connectResume`/管线。
- **并发写同一 sink**：帧处理串行链 `pending` 提升到整个 receive 作用域，跨原始/重连通道共享；resume 前 `await pending` 排空旧通道在途帧，并 `old?.close()`。
- **完成竞态泄漏 `pausedRecv`**：末批进入收尾即置 `completing`，`onRecvDrop` 据此不再误触发续传；完成时清 `pausedRecv`/定时器。
- **`resumable` 过早置位**：改为「首个 chunk 落盘后」才可续传，避免 ACCEPT 后 0 字节掉线时接收端空等 90s。
- **误判 sendFail**：`gotComplete` —— 收到整批 ACK 后即使 pc 掉线也算成功，不再无谓续传/失败。
- **旧连接串扰**：`InboundSignal.resume` 标记区分「原始连接」与「重连代」信令，两代互相忽略对方信令，杜绝濒死旧连接抢答重连 offer。
- 其余：重连后接收端速率以重连点为基线（不虚高）、旧 `conn` 在重连时关闭不泄漏。

**仍为已知取舍（暂不处理）**：两端 90s 窗口按各自掉线时刻起算，抖动时接收端可能比发送端多显示一会儿「重连中」（`resumeTimer` 自愈）；`RESUME_REQ` 每次连接只发一次（数据通道可靠有序，开通后不丢）；`seq` 理论上限 2^53（约 1.5 ZiB/会话，不可达）。
