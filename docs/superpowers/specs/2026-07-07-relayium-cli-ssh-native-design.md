# Relayium CLI — Phase 1 设计：SSH-native push/pull

- 状态：设计已定，待写实现 plan
- 日期：2026-07-07
- 归属 roadmap：M3「Protocol spec + multi-client / TCP between developers」的第一块落地

## 1. 背景与动机

跨网络 realtime 传输走 TURN relay 时文件字节要过我们的 coturn，吃运营方带宽，因此被计量/配额（`server/internal/account/turn.go`，默认 2 GiB/月）。我们想给开发者一个 **CLI**，并且：**能直连、不走我们带宽的场景就免费**；只有必须经我们中转时才谈收费。

对"开发者把文件推到自己的服务器"这类场景，开发者**本来就有 SSH 访问权**。用那条已有的 SSH 连接传输：

- 字节全程不经过 Relayium 任何服务器 → **零成本、免账号、天然免费**；
- 复用 SSH 已有的加密、认证、NAT 穿透 → 我们不用造这些轮子。

## 2. 诚实的产品定位（重要，先写清楚）

**这条 SSH-native 路不是我们赢 scp/rsync 的地方。**

- vs **scp**：我们明确赢在续传、进度、端到端 SHA-256、远端零依赖降级、stdin 管道。
- vs **rsync**：就"推到自己服务器"本身，rsync 已经有续传（`--partial --append`）、进度、checksum、delta，**我们基本打平甚至略输**，唯一还赢的是"远端连 rsync/sftp-server 都没有、只有 tar/cat"的边角。

**真正的护城河在 Phase 2**——scp/rsync 结构上做不到的：①发给你在其机器上没有任何凭据的人（短码 + E2E）；②一个工具通吃 LAN/自有服务器/陌生人，且 CLI 发→浏览器收；③不可信中转下可人肉验证的 E2E（SAS）。

**因此 Phase 1 的定位 = "最小可用骨架 + 免费引流入口"**：先把 CLI 命令面、Go 版 wire 协议、测试脚手架搭起来（Phase 2 反正都要），并交付"一个工具通吃"的体验起点。不指望它单挑 rsync。此定位是有意识的取舍，非疏漏。

## 3. 范围

### Phase 1 做

- 独立 Go 二进制 `relayium`，`push` / `pull` 本机 ↔ 已有 SSH 访问权的远端。
- 传输层直接 `exec` 系统 `ssh`，复用用户既有 SSH 配置。
- 两种远端接收模式，自动探测：full（远端已装 relayium）与 zero-dep（仅 tar/cat）。
- 逐文件 SHA-256 校验；full 模式支持断点续传；多文件批量；进度；stdin 管道。
- 首次写下 Go 版 wire 协议（帧/manifest/校验），为 M3 spec 化铺路。

### Phase 1 不做（留给 Phase 2 / 后续）

- 开发者互发的 P2P、rendezvous 汇合服务器、TURN relay 兜底。
- 计费/配额对接（Phase 1 纯客户端，压根不碰）。
- CLI ↔ 浏览器互通。
- 自研 app 层加密（X25519 / AES-GCM / SAS）——Phase 1 直接靠 SSH。
- self-host 可配置端点（Phase 2 有了 rendezvous 才需要）。

## 4. 命令面

沿用 scp 的 `user@host:path` 直觉，降低学习成本：

```
relayium push <src...> user@host:dest      # 本地 → 远端
relayium pull user@host:src... <dest>       # 远端 → 本地
relayium push - user@host:file              # 从 stdin 传
```

- **复用系统 `~/.ssh/config`**：host 别名、端口、identity、`ProxyJump` 跳板机自动生效。
- 常用 flag：`-i/--identity`、`-p/--port`、`--resume`（默认开）、`--no-verify`、`--progress`（TTY 下默认开）。
- 退出码：成功 0；部分文件失败非 0 且列出失败项。

## 5. 传输 / 连接层：直接调用系统 `ssh`

**决策：不使用 `golang.org/x/crypto/ssh` 自实现，而是 `exec.Command("ssh", …)` 并把数据流 pipe 到其 stdin/stdout**（git/rsync/mosh 同款做法）。

理由：

- 开发者已配好的 `~/.ssh/config`、ssh-agent、`ProxyJump`、硬件密钥、host key 验证**全部自动复用**，代码量与出错面最小。
- host key 校验（known_hosts）由系统 ssh 负责——这就是本场景的**防 MITM 机制**，替代了 web 端的 SAS。
- Windows 10+ 自带 OpenSSH，可用。

权衡：依赖系统存在 `ssh` 二进制。若日后需嵌入式 SSH（无系统 ssh 的环境），再补 `x/crypto/ssh` 作为备选后端；Phase 1 不做。

## 6. 两种远端接收模式（自动探测）

启动时探测：`ssh host command -v relayium` 有输出 → full，否则 → zero-dep。

### 6.1 Full 模式（远端已装 relayium）

- 本地执行 `ssh host relayium __recv <args>`；两端 relayium 进程在 SSH 管道（可靠、有序、已加密）上跑我们的帧协议。
- 因为底层是可靠有序流，协议比 web 那套 (`web/src/lib/transfer.ts`) **大幅简化**：无需流控信用窗口、无需断线重连握手、无需 nonce 管理、无需自研加密。
- 支持：多文件 batch manifest、逐文件 SHA-256、断点续传。

### 6.2 Zero-dep 模式（远端仅有 tar/cat）

- 目录/批量：本地 tar 流 pipe 进 `ssh host 'tar -x -C dest'`。
- 单文件：`ssh host 'cat > dest'`。
- 完整性：SHA-256 发送端算，传完 `ssh host 'sha256sum dest'` 取回比对。
- 续传能力受限（tar 不可续传）；大单文件可用 offset（`tail -c +N`）续，文档写清限制。
- 增值点（相对裸 scp）：批量、进度、校验、管道、`~/.ssh/config` 感知、与 full 模式一致的 UX。这是**优雅降级路径**。

## 7. 加密与信任（Phase 1）

- **不自研加密。** SSH 提供传输加密 + 传输完整性 + **host key 认证**。
- 本场景的防 MITM = SSH host key（known_hosts），替代 web 的 SAS。文档明确说明信任边界。
- app 层 X25519 / AES-GCM / SAS 推迟到 Phase 2（仅"不可信 rendezvous 的 P2P"与"CLI↔浏览器互通"才需要）。

## 8. Wire 协议（full 模式）

现有帧/分块/校验逻辑**目前只存在于 TypeScript**（`web/src/lib/transfer.ts`），Go 侧尚无。**Phase 1 是 Go 版 wire 协议第一次被写下来**，要写得能 spec 化，为 M3 的 CLI↔浏览器互通铺路。

SSH 管道上的极简帧（可靠有序流，无需加密/流控层）：

1. **Hello / 协商**：版本号、模式（push/pull）、能力位。
2. **Manifest**：文件列表 `{相对路径, size, mode, mtime}`，长度前缀。
3. **Resume 协商**（续传）：接收端回报每个文件 `{path, bytesOnDisk}`；发送端据此定起始 offset。
4. **文件流**：按 manifest 顺序，每文件分块流式发送（无需固定 chunk 加密封装，纯字节 + 末尾 SHA-256）。
5. **Per-file 校验**：逐文件 SHA-256，接收端比对，报告成功/失败。

协议放入同模块新包 `internal/wire`（server 与 CLI 共享）。保持字段稳定、可文档化。

## 9. 代码结构

- 入口：`cmd/relayium/`（同 Go 模块 `github.com/relayium/relayium`），可独立 `go build` 与分发。
- 共享协议：`internal/wire`（帧/manifest/校验/续传逻辑）。
- SSH 连接封装：`internal/ssh`（`exec` 系统 ssh、参数拼装、模式探测）。
- 具体布局按 Go 惯例微调；`__recv` 为隐藏子命令。

## 10. 测试

- **单测**：manifest / 帧编解码、SHA-256 校验、续传 offset 逻辑、`user@host:path` 解析、ssh 参数拼装。
- **集成**：对 `ssh localhost`（或容器内 sshd）跑 push/pull full 模式；把 `relayium` 移出 PATH 验证 zero-dep 降级。
- **E2E**：推目录到 localhost → 拉回 → 逐字节 + hash 一致；传到一半 kill → `--resume` → 跑完且完整。

## 11. 未决 / 后续（不阻塞 Phase 1）

- Phase 2：短码 + rendezvous + P2P + relay 兜底 + 自研 E2E/SAS + self-host 可配端点 + CLI↔浏览器互通。
- 二进制分发方式（release / go install / brew）后续定。
- 是否将 web 端 TS 协议与 Go `internal/wire` 收敛为单一 spec，M3 决定。
