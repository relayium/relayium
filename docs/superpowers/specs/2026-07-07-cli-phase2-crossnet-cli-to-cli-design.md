# Relayium CLI — Phase 2 / Spec 1 设计：CLI↔CLI 跨网络互发（码已存在）

- 状态：设计已定，待写实现 plan
- 日期：2026-07-07
- 归属 roadmap：M3（protocol spec + multi-client）。Phase 2 的第一块。
- 前置：Phase 1 SSH-native 已合并（`internal/xfer` 传输引擎、`internal/sshx`）。

## 1. 背景与动机

Phase 1 让开发者把文件推到**自己有 SSH 权限**的服务器（走 SSH，字节不经我们，免费）。Phase 2 补上 scp/rsync 结构上做不到的那块：**发给一个你在其机器上没有任何凭据的人**——凭一个短码互发，E2E 加密。

免费/付费边界不变：**字节走不走我们的服务器**。
- 能直连（至少一侧公网可达一个端口）→ 字节点对点，**免费**。
- 双方都在 NAT 后连不上 → 落我们的中继，**付费**（计入现有月度配额）。

对"开发者手里一堆服务器"的主力场景：服务器通常公网可达，**基本永远走免费直连**。

## 2. 范围

### 本 spec 做

- CLI 子命令 `send` / `receive`，凭短码在两个 CLI 间跨网络传文件。
- 复用现有 rendezvous（`/ws?code=`）交换密钥承诺与连接候选。
- TCP 直拨（直连）+ 新增轻量 WS 中继端点（兜底，按 owner 计量）。
- E2E 安全信道：stdlib `crypto/tls` + 临时自签证书 + 公钥 pinning + SAS。
- 在安全信道上复用 Phase 1 的 `xfer.Send`/`xfer.Receive`（分块/续传/SHA-256）。

### 本 spec 不做（拆去别处）

- **CLI 铸码鉴权**（Spec 2）：`/api/pair` 只认 session cookie、无 API-token 路径。本 spec **假设码已存在**（由浏览器登录态或未来的 `relayium login` 铸好），两端仅按码 **加入**（加入无需鉴权）。
- 浏览器互通（需 pion + 逐字节复刻 libsodium/DataChannel；本 spec 用 Go 原生、与 web 线格式不兼容的加密）。
- NAT 打洞 / 完整 ICE（v1 不做；只做直拨，连不上即中继）。self-host 可配端点作为 `--server` flag 折入本 spec。

## 3. 命令面

```
relayium send <src...> <code|link>       # 发送方加入码房
relayium receive <code|link> [destdir]    # 接收方加入码房
```

- 码兼容分享链接片段 `#c=<6位>`（复用 `web/src/lib/transfer-link.ts` 的格式）。
- flag：
  - `--advertise host:port`：手动指定对外可达的直连端点（公网 IP/端口映射场景）。
  - `--relay-only`：跳过直连尝试，直接走中继（调试/已知双 NAT）。
  - `--verify`：要求人工核对 SAS 通过后才继续（默认打印不阻断）。
  - `--server <host>`：指向自建 Relayium（self-host）；默认官方端点。

## 4. 端到端流程

1. **加入房间**：两端连 `wss://<server>/ws?code=<code>`，进 `c:<code>` 双人房。复用现有 JSON envelope（`join`→`welcome`→`peers`→`signal`）。加入无需鉴权；码非法/过期时服务器在 WS 升级前回 403。
2. **在 `signal` 信道交换**（内容放 envelope 的 `data`）：
   - **证书公钥的 commit-then-reveal**：各自生成临时 TLS 证书，先发 `commit = H(certPubKey ‖ nonce)`，收到对端 commit 后再 `reveal = {certPubKey, nonce}`；校验对端 reveal 与其 commit 一致。防 rendezvous 篡改。
   - **连接候选**：各自可达 TCP 端点列表 = { 非私网本地地址:监听端口, `--advertise` 指定值 }。注意 STUN 给的是 UDP 反射地址，对 TCP 直拨无用（除非 TCP 打洞，本 spec 不做），故 v1 **不用 STUN 生成 TCP 候选**；候选来源仅公网本地地址与 `--advertise`。双方都无公网候选 → 直接进中继。
3. **连通（TCP 直拨竞速）**：每端起一个 TCP listener 并公告候选；两端**同时**对拨对方候选并接受入连。**任一方向先建成的 TCP 连接即选为直连**，其余取消。~3–5s（可配）内无直连 → 进入中继。
   - 关键性质：**只要有一侧公网可达某端口，另一侧拨进来即成直连（免费）**；只有双方都在 NAT 后才必须付费中继。
4. **安全信道**（尽量 stdlib）：在选定的裸流上跑 **TLS 1.3**，两端用步骤 2 revealed 的对端证书公钥做**证书 pinning**（`tls.Config` 自定义 `VerifyPeerCertificate` 只认钉住的公钥）。**SAS = 两个证书公钥指纹排序后的短哈希（6 位十进制）**，两端打印。`--verify` 时要求人工确认一致后继续；否则打印不阻断。
5. **传输**：TLS 连接即一个 `io.ReadWriter`，直接调 `xfer.Send`（发送端）/ `xfer.Receive`（接收端）。直连与中继两条路归一为"一个加密 stream"，引擎无差别复用。

## 5. 中继兜底（新增服务器件，Option X）

- **新端点** `wss://<server>/relay?code=<code>`：第一方连上等待，第二方连上后**服务器在两条 WS 连接间双向对拷字节**。复用现有 WS + TLS + 升级设施（穿透代理/企业防火墙）。房间语义同 `c:<code>`（双人、按码）。
- **计费/配额**：中继字节按 **code owner** 记入**现有月度账本**（`server/internal/account` 的 `UserRelayedSince` / `RelayMonthlyFree`，与 coturn TURN 共用同一 2 GiB/月上限）。owner 超额时，服务器在 `/relay` 建立时拒绝并回一个 `relayDenied:"quota"` 语义的信号，客户端提示（复用现有文案链路概念）。
- **零知识**：中继搬运的是 **E2E 加密后的 TLS 字节**，服务器读不到文件内容/名（与 TURN 同等保证）。owner 归属沿用 `/ws?code=`/`/relay?code=` 的 code→owner 解析（复用 pairReg）。

## 6. 信任模型（诚实写清）

- 证书 pinning（commit-reveal 承诺）**挡住被动/偷窥型 rendezvous**。
- **完全主动的 MITM rendezvous**（同时替换两侧承诺）**只能靠人工核对 SAS 挡**——与现有 web 端同款权衡，非本 spec 独有弱点。
- 默认打印 SAS 不阻断（照顾"两台都是本人机器"的低摩擦）；`--verify` 强制人工确认。
- 加密为 Go 原生（X25519/TLS1.3 + 自签证书 pinning + SAS），**与 web 线格式不兼容**——CLI↔浏览器互通留待后续（需 pion + libsodium 复刻）。

## 7. 代码结构

客户端新包（均 `server/` 模块内，纯客户端，不改现有 server 运行逻辑，除第 5 节新端点）：

- `internal/rzvous`：WS 客户端，讲现有 envelope；`join`/`welcome`/`peers`/`signal` 收发；commit-reveal 密钥承诺；连接候选交换。
- `internal/connect`：候选收集（非私网本地地址过滤 + `--advertise`）、TCP 直拨/listen 竞速、中继兜底；对上层返回一个裸 `net.Conn`（或 `io.ReadWriteCloser`）+ 一个"是否走了付费中继"的标记。
- `internal/secure`：TLS-over-stream，临时自签证书生成、pinning `VerifyPeerCertificate`、SAS 派生与打印。
- `cmd/relayium`：新增 `send` / `receive` 子命令，串起 rzvous→connect→secure→xfer；flag 解析。

服务器改动（仅新增，不动现有路径）：

- 新增 relay handler（如 `server/internal/signal/relay.go` 或新包）：`/relay?code=` WS 双向对拷 + 按 owner 计量 + 配额门。
- 复用 `internal/signal`（房间/envelope/pairReg）、`internal/account`（计量账本/配额）、`internal/metering`（如需统一记账口径）。

## 8. 复用与新写清单

| 复用 | 新写 |
|---|---|
| `xfer.Send`/`Receive`/manifest/wire（Phase 1） | `send`/`receive` 命令 |
| `/ws?code=` rendezvous + envelope | rzvous WS 客户端 |
| —（v1 不用 STUN/TURN；直连靠公网候选，兜底靠新 `/relay`） | connect 直拨竞速 + 候选收集 |
| coder/websocket（服务器已用；客户端复用） | secure（TLS pinning + SAS） |
| 月度账本 `UserRelayedSince`/`RelayMonthlyFree` | `/relay` 中继端点 + 计量 hook |
| pairReg code→owner 归属 | — |

## 9. 测试

- **单测**：envelope 编解码、commit-reveal 承诺与校验、SAS 派生（跨两端一致、对调公钥不变）、证书 pinning（钉错公钥必拒）、候选择优/去私网。
- **集成**：进程内起 WS hub（复用 signal hub）+ loopback 直连 → 全程 `send`→`receive` 逐字节+hash 一致；杀连接→`--resume`→跑完（复用 Phase 1 续传）。
- **中继集成**：进程内起 `/relay` 端点，两端强制 `--relay-only`，验证对拷通路 + 计量累加 + 超额拒绝。
- **E2E（opt-in）**：对真实部署的 rendezvous 跑一次真实跨网络 `send`/`receive`（`RELAYIUM_E2E_CROSSNET=1` 门控，缺省 SKIP）。

## 10. 未决 / 后续（不阻塞本 spec）

- **Spec 2**：CLI 铸码鉴权（`relayium login` device-auth 或服务器加 API-token 路径），让 CLI 能主动铸码而非依赖浏览器/手工码。
- NAT 打洞（STUN-based TCP/UDP hole-punch 或引 pion/ice）扩大免费直连覆盖到双 NAT。
- 浏览器互通（pion + 逐字节复刻 libsodium `crypto_kx`/commit-reveal/DataChannel 帧）——见 Phase 1 spec 与 web 契约。
- 二进制分发（release / go install / brew）。
- 是否将 CLI 原生加密与 web 线格式**收敛为单一 spec**（M3 决定；目前有意分叉）。
