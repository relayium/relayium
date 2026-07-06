# 跨网络实时传输需登录 + 中继按用户归属 + 临时中继上限

**日期：** 2026-07-06
**状态：** 已批准设计，待写实现计划
**关联：** 下游是 [2026-07-06-billing-plans-phase1-design.md](./2026-07-06-billing-plans-phase1-design.md)（按档配额将取代本 spec 的临时统一上限）；计量归属让 [2026-07-06-admin-per-user-usage-metering-design.md](./2026-07-06-admin-per-user-usage-metering-design.md) 的按月中继统计精确到人。

## 目标

跨网络实时直传（配对码 / 分享链接）从"完全匿名"改为"必须由一个已登录账号拥有"，并把 TURN 中继流量按用户归属、按临时上限限流。LAN 同网传输保持匿名免费、不受影响。

三件事：
1. **登录门槛**：铸造配对码 / 分享链接需要登录（发起方）。接收方仍匿名参与（只用码/链接）。
2. **中继归属**：TURN 凭据用户名嵌入 owner userID，coturn→Redis→metering 链路把中继字节记到 `usage_events.user_id`（今天硬编码为空）。
3. **临时限流**：`/api/ice` 在 owner 本月中继超 `relay_monthly_free_bytes` 时不发 TURN 凭据。

## 定价前提（已拍板）

- "整个跨网络都要登录"，但采**发起方拥有**模型：跨网络传输由发起方账号拥有，中继全记他头上；接收方无需账号。与"暂存下载属主付费"一致。
- LAN（无码、无 TURN、不过服务器）永久匿名免费。原"P2P 直传永久免费不计量"因此收敛为**仅 LAN 免费**。
- 临时统一上限现在就上；billing phase-1 的按档 traffic 配额落地后取代它。

## 现状（已核实）

- `/api/pair`（`main.go` 经 `signal.PairHandler`）匿名铸码；`PairRegistry`（`internal/signal/pair.go`）内存存 `code→expiry`，**无 owner**。
- `/api/ice`（`internal/account/turn.go:43` `handleICE`）匿名；对任一有效 live code 发 TURN。凭据用户名 `expiry:code`（`turnCredentials`，`turn.go`）。
- coturn 把每分配的中继字节按 TURN 用户名写 Redis；`internal/metering`（`metering.go:70` `handle`）解析 `token`（用户名首个 `:` 之后），**硬编码 `UserID: ""`**（注释即"per-user attribution TODO"）。
- 客户端对跨网络码传输强制 relay-only ICE（`web/src/App.svelte:124`：有 TURN 就 `iceTransportPolicy:"relay"`；无 TURN 回退 `{ iceServers }` 默认策略）。

## 架构

### 1. 配对码归属（signal 层）

- `PairRegistry` 每个码存 `{expiry, ownerUserID}`（结构从 `map[string]int64` 改为 `map[string]codeEntry`）。
- `Mint()` → `MintFor(ownerUserID string)`：铸码并绑定 owner。
- 新增 `OwnerOf(code string) (userID string, ok bool)`：live code 返回其 owner；过期/不存在 `ok=false`。保留 `Validate` 语义（`OwnerOf` 的 ok 即"有效"）。
- `PairHandler` 改为**需要会话**：从请求解析登录用户（复用 account 的 session 解析），无会话 → 401；有则 `MintFor(user.ID)`。
  - 落点细节：`PairHandler` 目前在 `signal` 包、不认识 account 的 session。实现时把"当前用户解析"以回调注入（如 `PairHandler(reg, rl, ipx, currentUser func(*http.Request)(userID string, ok bool))`），由 `main.go` 用 `acct` 的 session 中间件填充，避免 signal→account 反向依赖。

### 2. 中继归属（account TURN + metering）

- `/api/ice?code=`：把 `s.validatePairCode(code) bool` 换成 `s.pairCodeOwner(code) (userID string, ok bool)`（同样经 `SetPairCodeOwner` 注入 `PairRegistry.OwnerOf`）。仅当 `ok` 时发 TURN。
- TURN 凭据用户名：`expiry:ownerUserID.code`（HMAC 计算不变，仍对整串做 HMAC）。userID 是 hex、code 是 6 位数字，`.` 分隔无歧义、对 coturn 用户名/Redis 通道安全。
  - `turnCredentials(secret, token, expiry, urls)` 的 `token` 传 `ownerUserID + "." + code`。
- `metering` worker（`metering.go:handle`）：`token := tokenFromUsername(...)`；再 `userID, code := splitAttrib(token)`（按第一个 `.` 拆）。`splitAttrib`：含 `.` → `(前段=userID, 后段=code)`；不含 `.` → `("", token)`（**滚动兼容**：旧格式 `expiry:code` 仍作纯 code、UserID 空，退回全局记账不报错）。`RecordUsage{UserID: userID, Token: code, ...}`。
- 结果：`usage_events.user_id` 有值 → 按月中继计量（metering spec 的 `AdminListUsers`/`AdminMetrics` 中继子查询）精确到人。

### 3. 临时中继上限（account 设置 + `/api/ice` 判定点）

- 新增 admin 设置 `relay_monthly_free_bytes`（复用现有 settings 机制，`settings.go`；默认 `2<<30` = 2 GiB，可后台调）。
- `/api/ice` 在确认 code 有效且拿到 owner 后，读 **owner 本月中继字节** = `SUM(usage_events.relayed_bytes) WHERE user_id=owner AND recorded_at ∈ 当月`（复用 metering 的 `monthRange(periodOf(now))`）。
  - `used >= relay_monthly_free_bytes` → **不发 TURN**（STUN-only），并在响应加 `relayDenied: "quota"`。
  - 否则正常发 TURN。
- billing phase-1 落地后：此判定点改读 owner 所在 plan 的 traffic 配额（组合口径：中继+暂存上传下载），取代 `relay_monthly_free_bytes`。本 spec 只做临时统一上限。

### 4. 客户端（web）

- **CrossPage**：发起"生成码/链接"前需登录——复用 OfflinePage 的登录门/面板模式（未登录时展示登录，登录后才调 `/api/pair`）。接收方（有码/链接进入）路径不变、无需账号。
- **`/api/ice` 响应**：`fetchIceConfig` 读取新的可选 `relayDenied` 字段并透出。
- **超额提示**：当 `relayDenied==="quota"`（无 TURN），客户端在跨网络连接失败/降级时显示"本月中继流量已用尽，请升级"，区别于"未配置 TURN"。P2P 若在默认策略下侥幸直连成功仍免费。
- i18n：新增该提示与 CrossPage 登录门相关文案，六语言（en/zh/de/fr/ja/ko）逐字，遵循现有 i18n 键结构。

## 边界与兼容

- **会话解耦**：`/api/ice` 从注册表 `OwnerOf(code)` 查 owner，不看请求方会话；发起方中途登出/会话过期，传输仍继续并仍记其账上（码在 TTL 内有效）。
- **注册表内存态**：owner 随码存于内存，服务重启即失（与现状一致，码本就短寿）。
- **旧客户端**：`/api/pair` 无会话 → 401 → 跨网络发起需登录（预期门槛）。LAN 不经 `/api/pair`，不受影响。
- **滚动部署**：新旧 TURN 用户名格式并存期间，metering `splitAttrib` 对无 `.` 的旧 token 退回 UserID 空、不报错、不丢全局记账。
- **安全**：userID 进入 coturn 用户名不泄露敏感信息（已是不透明随机 hex）；HMAC 覆盖整串，凭据不可伪造；per-IP 速率限制（`/api/pair`、`/ws?code=`）保持不变。

## 测试

1. `PairRegistry`：`MintFor` 绑定 owner；`OwnerOf` 对 live/过期/不存在码的返回；并发铸码不串 owner。
2. `PairHandler`：无会话 401；有会话铸码且码归属正确。
3. `handleICE`：有效码+owner → TURN 用户名含 `ownerUserID.code`；无效/过期码 → STUN-only 无 TURN；owner 本月中继 ≥ 上限 → STUN-only + `relayDenied:"quota"`；未达上限 → 有 TURN。
4. `metering.splitAttrib`/`handle`：`userID.code` → 记 `UserID=userID, Token=code`；纯 `code`（旧格式）→ `UserID="", Token=code`；据此 `usage_events.user_id` 落库正确。
5. 端到端：登录用户铸码→接收方匿名加入→`/api/ice` 两端都拿到嵌 owner 的 TURN→（模拟 coturn 上报）中继字节记到 owner 的当月计量。
6. 客户端：CrossPage 未登录时门控；`relayDenied` 透出与提示文案；六语言键完整。
7. 回归：LAN（无码）路径完全不受影响，仍匿名、STUN-only-可 P2P。

## 涉及文件

- `server/internal/signal/pair.go` — `codeEntry`、`MintFor`、`OwnerOf`。
- `server/internal/signal/pairhttp.go` — `PairHandler` 注入 `currentUser` 回调 + 401 门槛。
- `server/main.go` — 用 `acct` session 解析填 `currentUser`；`SetPairCodeOwner(reg.OwnerOf)`。
- `server/internal/account/turn.go` — `handleICE` 改用 owner、用户名嵌 `userID.code`、超额判定 + `relayDenied`。
- `server/internal/account/service.go` — `SetPairCodeOwner` / `pairCodeOwner` 字段（取代或并存 `SetPairCodeValidator`）。
- `server/internal/account/settings.go` — `relay_monthly_free_bytes` 设置键（+ Config 默认、Seed）。
- `server/internal/account/sqlite.go` — owner 本月中继字节读取（可复用/新增小查询）。
- `server/internal/metering/metering.go` — `splitAttrib` + `handle` 记真实 UserID。
- `web/src/lib/ice.ts` — 透出 `relayDenied`。
- `web/src/App.svelte` / CrossPage 组件 — 发起登录门 + 超额提示。
- `web/src/lib/i18n/*.ts` — 六语言文案。
- 各对应 `_test.go` / `*.test.ts`。

## 明确不在本 spec

plans 表与按档配额（billing phase-1）、Stripe、增值包、把 LAN 或纯 P2P 纳入计费、改变客户端 relay-only 策略本身。
