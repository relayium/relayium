# 上传额度按档位 + 浏览器流式上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「单文件 1 GiB」端到端真正可用——日额度按套餐档位配置，会话上限由服务端剩余额度推导，浏览器上传改成边加密边上传。

**Architecture:** 三个任务。Task 1 给 `plans` 表加日额度列并替换四处 `st.DailyQuota`（`<= 0` 回落全局设置，因此迁移后行为不变）。Task 2 把 `sess.maxSize` 从 `MaxFileSize` 快照改成 `min(MaxFileSize, 剩余日额度, 剩余存储, 剩余流量)`，全部服务端自算。Task 3 只改浏览器的分片上传路径，单发 fallback 保持不变。

**Tech Stack:** Go（`server/`，SQLite）、TypeScript + Svelte 5（`web/`）、vitest。

**Spec:** `docs/superpowers/specs/2026-07-20-upload-limits-and-streaming-design.md`

## Global Constraints

- Go 测试 `cd server && go test ./...`；前端 `cd web && npx vitest run <file>`，类型检查 `npm run check`，构建 `npm run build`。
- **commit message 一律用英语**。代码注释跟随所在文件既有风格（`internal/account` 中英混用跟随文件；`web/src/lib` 中文为主）。
- **线格式绝对不能变**。`web/src/lib/store-crypto.interop.test.ts`（Go↔JS 跨语言向量）与 `web/src/lib/stored-file.test.ts:342` 的字节布局断言必须**原样通过**，不得修改这两处断言来迁就实现。它们是这次重写不跑偏的唯一保证。
- **不改 finalize 的权威地位**：finalize 仍用 `sess.received` 重跑全部额度闸。
- **不改下载/解密路径**（已经是流式的），**不改单发 fallback 路径**（`uploadFile`，保留 XHR + Blob）。
- 还原临时改动一律用 `cp` 备份，**禁用 `git checkout`**。
- 变异按**行号**定位并回显被改的那一行自证。

---

### Task 1: 日额度挪进套餐表

**Files:**
- Modify: `server/internal/account/store.go`（`Plan` 结构体）
- Modify: `server/internal/account/sqlite.go`（建表 + 迁移 + `planCols`/扫描/写入）
- Modify: `server/internal/account/settings.go`（`defaultPlans()` 种子值）
- Modify: `server/internal/account/plan_enforce.go`（新增解析函数）
- Modify: `server/internal/account/files.go:145,224`、`uploads_resumable.go:200,356`
- Modify: `server/internal/account/admin.go` + `admin_templates.go`（套餐编辑器加列）
- Test: `server/internal/account/plan_daily_quota_test.go`（新建）

**Interfaces:**
- Produces: `Plan.DailyQuotaBytes int64`、`func (s *Service) dailyQuotaFor(ctx context.Context, userID string) (int64, error)` — Task 2 使用

**出厂值**（`defaultPlans()`，`settings.go:200` 附近）：

| 档位 | DailyQuotaBytes |
|---|---|
| free | `200 << 20`（200 MiB，维持现值） |
| plus | `100 << 30`（100 GiB） |
| pro | `340 << 30`（340 GiB） |
| max | `1700 << 30`（1700 GiB） |

- [ ] **Step 1: 先摸清 plans 表的既有模式**

```bash
cd server && grep -n "planCols\|price_yearly\|stripe_price_monthly_id" internal/account/sqlite.go | head -20
```

`plans` 表已经历过 ALTER 迁移（`stripe_price_*_id` 就是后加的）。**照抄那套模式**加 `daily_quota_bytes INTEGER NOT NULL DEFAULT 0`：建表语句要加、迁移要加、列清单/扫描/写入三处都要同步。请在报告里列出你改到的每一处，漏一处就会出现"写进去读不出来"。

- [ ] **Step 2: 写失败的测试**

新建 `server/internal/account/plan_daily_quota_test.go`，覆盖三条：

1. **解析规则**：`plan.DailyQuotaBytes > 0` 时用它；`= 0` 时回落到全局 `SettingDailyQuota`。
2. **往返**：`SetSetting`/套餐写入后读回该列的值不丢（这条钉住 Step 1 的三处同步，漏改任何一处它都会失败）。
3. **端到端**：一个 plus 档用户上传 300 MiB 不再被 200 MiB 的全局日额度拒绝。**这条是本任务存在的理由**——请用既有的上传测试手法（`grep -rln "handleUpload\|/api/files" internal/account/*_test.go` 找惯用脚手架），不要自己新造。

- [ ] **Step 3: 运行确认失败**

```bash
cd server && go test ./internal/account/ -run 'TestPlanDailyQuota|TestDailyQuotaFor' -v
```

Expected: 编译失败（`Plan` 无 `DailyQuotaBytes` 字段 / `dailyQuotaFor` 未定义）

- [ ] **Step 4: 实现**

`Plan` 加字段：

```go
	// DailyQuotaBytes 是该档每 24 小时的上传额度；<= 0 表示回落到全局
	// SettingDailyQuota。存量 plans 行的该列默认 0，因此迁移后行为不变。
	DailyQuotaBytes int64
```

`plan_enforce.go` 加解析函数（放在 `planForUser` 附近，复用它）：

```go
// dailyQuotaFor 给出 userID 当前档位的 24 小时上传额度。档位没配（<= 0）时回落
// 到全局 SettingDailyQuota——存量 plans 行都是 0，这让迁移后的行为保持不变。
func (s *Service) dailyQuotaFor(ctx context.Context, userID string) (int64, error) {
	plan, err := s.planForUser(ctx, userID)
	if err != nil {
		return 0, err
	}
	if plan.DailyQuotaBytes > 0 {
		return plan.DailyQuotaBytes, nil
	}
	return s.resolveSettings(ctx).DailyQuota, nil
}
```

然后把 `files.go:145`、`files.go:224`、`uploads_resumable.go:200`、`uploads_resumable.go:356` 四处的 `st.DailyQuota` 换成 `dailyQuotaFor` 的结果。**注意这四处的错误处理**：读失败时的行为要与该处既有的 fail-open / fail-closed 取向一致，不要顺手改变它。请在报告里逐处说明你选了哪个方向、依据是什么。

- [ ] **Step 5: 后台套餐编辑器加列**

找到套餐编辑的模板与 handler（`grep -n "price_monthly\|storage_bytes" internal/account/admin_templates.go internal/account/admin.go`），照相邻字段的模式加「每日额度 (MiB)」输入框与读写。**必须允许 0**（0 = 用全局设置）。

- [ ] **Step 6: 验证 + 变异**

```bash
cd server && go build ./... && go vet ./... && gofmt -l internal/account/ && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -20
```

变异验证（按行号定位并回显自证）：
1. `dailyQuotaFor` 改成永远返回全局值 → 端到端那条测试应失败
2. `daily_quota_bytes` 从 `planCols` 里删掉（模拟 Step 1 漏改一处）→ 往返测试应失败

- [ ] **Step 7: 提交**

```bash
git add server/internal/account/
git commit -m "feat(plans): make the daily upload quota a per-plan setting

A single global 200 MiB/day applied to every tier, so no paid user could
upload a file larger than that regardless of what they paid for. Plans now
carry their own daily quota; 0 falls back to the global setting, so existing
rows keep today's behaviour until seeded or edited.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 会话上限由服务端剩余额度推导

**Files:**
- Modify: `server/internal/account/uploads_resumable.go:225-235` 附近（`sess.maxSize` 的赋值）
- Modify: `server/internal/account/plan_enforce.go`（新增 remaining 系列辅助函数，若不存在）
- Test: `server/internal/account/upload_session_cap_test.go`（新建）

**Interfaces:**
- Consumes: `dailyQuotaFor`（Task 1）
- Produces: 无对外符号（内部辅助函数随你命名）

**问题**：`sess.maxSize` 现在是 `st.MaxFileSize` 的快照，与用户真实剩余额度无关。客户端声明 `?size=0` 可以跳过 init 的提前拒绝，然后实际写满 `MaxFileSize`。偷不走额度（finalize 是权威闸门，会拒绝），但能占住磁盘：5 个会话 × 1 GiB × `pendingUploadTTL`（1 小时）= 5 GiB/账号。单文件上限提到 1 GiB 后这个数放大了 20 倍。

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/upload_session_cap_test.go`。核心用例：

一个**剩余日额度只有 10 MiB** 的用户，`POST /api/uploads?size=0`（谎报），然后不停 PATCH 数据。断言**服务端在写入约 10 MiB 后就截断/拒绝**，而不是允许写满 `MaxFileSize`。

**这条测试必须能区分"finalize 拒绝"与"写入阶段就截断"**——前者是现状（浪费了带宽和磁盘才拒），后者才是本任务要的。请断言在 PATCH 阶段就出现拒绝，并在报告里说明你如何确保它测的不是 finalize。

另加：
- 剩余额度充足时，`size=0` 的会话仍能正常写满一个合法文件（不要把正常路径误伤）。
- `MaxFileSize` 小于剩余额度时，`maxSize` 仍受 `MaxFileSize` 约束（min 的另一侧）。

- [ ] **Step 2: 运行确认失败**

```bash
cd server && go test ./internal/account/ -run TestUploadSessionCap -v
```

Expected: FAIL——当前实现允许写满 `MaxFileSize`

- [ ] **Step 3: 实现**

先查有没有现成的"剩余额度"辅助函数：

```bash
cd server && grep -n "func (s \*Service) over\|remaining" internal/account/plan_enforce.go
```

现有的是 `overStorage(ctx, userID, add)` / `overTraffic(ctx, userID, add)` 这种「加上 add 会不会超」的形式。**若没有 remaining 形式，就新增**——注意与既有 over* 函数共用同一套口径（尤其 `monthlyTrafficCap` 对月中改档用户的分段折算逻辑，不要绕开它另算一份）。

然后把 `sess.maxSize` 的赋值改成四者取最小：

```go
	// 会话上限取「单文件上限」与用户三项剩余额度的最小值，全部由服务端自算，
	// 不读客户端声明的 ?size=。客户端谎报 size=0 只能跳过 init 的提前拒绝，
	// 拿不到更大的写入配额——否则 5 个会话 × MaxFileSize × pendingUploadTTL
	// 就是一个免费账号能占住的磁盘。
	maxSize := st.MaxFileSize
	// ... 依次与剩余日额度 / 剩余存储 / 剩余流量取 min（任一读失败时的取向见下）
```

**读失败时的取向**：某项额度读不出来时**不要收紧到 0**（那会把正常上传全拒了），保持该项不参与 min。请在注释里写明这个 fail-open 选择及理由。

- [ ] **Step 4: 验证 + 变异**

```bash
cd server && go build ./... && go test ./internal/account/ -count=1 2>&1 | tail -5
```

变异：把 `maxSize` 改回 `st.MaxFileSize`（去掉三项 min）→ 新测试应失败。

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/
git commit -m "fix(uploads): derive the session write cap from server-side remaining quota

handleUploadInit sized the session from MaxFileSize alone, so a client that
declared size=0 skipped the early rejection and could still write a full
MaxFileSize of ciphertext before finalize refused it -- squatting 5 sessions
x MaxFileSize of disk for the session TTL. The cap now comes from what the
account actually has left.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 浏览器流式上传

**Files:**
- Modify: `web/src/lib/store-crypto.ts`（新增 `cipherSizeFor`）
- Modify: `web/src/lib/stored-file.ts`（`chunkedUpload` 改流式）
- Modify: `web/src/lib/StoredUpload.svelte`（进度阶段）
- Test: `web/src/lib/store-crypto.test.ts`（追加 `cipherSizeFor` 用例）
- Test: `web/src/lib/stored-file.test.ts`（调整受影响用例）

**Interfaces:**
- Consumes: 无（服务端零改动）
- Produces: `export function cipherSizeFor(files: File[]): number`

**背景数据（调研已确认，可直接用）**：
- 帧格式 `frame() = uint32BE(ct.length) ‖ ct`，AES-GCM 的 `ct = 明文 + 16` → **每帧 = 明文 + 20 字节**
- `STORE_CHUNK_SIZE = 192 * 1024 = 196608`
- **文件之间没有分隔帧**；`seq` 全局递增；每个文件独立分块，末块不补齐
- 空文件贡献 **0** 字节（循环不执行）
- manifest 走 init 的 body，**不计入** `cipherSize`
- 服务端 `?size=` 只用于 init 的提前拒绝，不入库、不参与 `cappedReader`、finalize 不校验它 → **服务端零改动**
- 上传块边界**不需要**对齐帧边界（服务端看到的是不透明字节流，`StoreDecryptor` 跨任意边界重组）
- 服务端**会提交部分块**（`uploads_resumable.go:292`），所以 `uploadOffset()` 可能返回块起点之后的位置

- [ ] **Step 1: 先写 `cipherSizeFor` 与它的测试**

公式：

```
cipherSize = Σ_i [ size_i + 20 × ceil(size_i / 196608) ]
```

在 `store-crypto.test.ts` 追加用例，**必须覆盖**：多块文件、大小恰好是 192 KiB 整数倍的文件、空文件、零文件、多文件混合。

**关键**：至少有一条测试要**真的跑一遍 `encryptFiles` 并累加实际产出的字节数**，与 `cipherSizeFor` 的返回值比对。只用公式验公式是同源的，测不出公式本身写错。

- [ ] **Step 2: 改 `chunkedUpload` 为流式**

设计要点：

1. 用 `cipherSizeFor(files)` 算出 `cipherSize`，照旧放进 init 的 `?size=`。
2. 从 `encryptFiles(files, sk.key)` 拉帧，贪婪填进一个缓冲区，达到 `chunkSize`（init 返回，兜底 `8 << 20`）就 PATCH 出去。**不要**保留已确认的块。
3. **重放缓冲**：当前在途块的字节必须保留到服务端确认为止。服务端可能提交部分块 → `uploadOffset()` 返回的偏移可能落在**块内**，重放缓冲必须支持从块内任意偏移续传，不能只支持"整块重发"。
4. 峰值内存目标 ≈ `chunkSize` + 一帧（约 8 MiB + 192 KiB）。
5. 生成器的生命周期：抛错路径上要确保生成器被正确终止，不留悬挂的加密工作。

**不要改的东西**：`uploadChunk` 的重试策略（≤5 次、409 读 `received`、指数退避上限 5s）、finalize 的重试、错误分类（413/429/401 直接抛）。

- [ ] **Step 3: 进度阶段合并**

现有测试 `reports the encrypting phase then the uploading phase` 断言 `phases === ["encrypting","uploading"]`，流式后两阶段天然交织。

**决定（spec 已定）**：分片路径的 `phase` 恒为 `"uploading"`，进度按已确认字节 / `cipherSize` 计。`StoredUpload.svelte` 里在阶段切换时重置进度条的逻辑要去掉。**单发 fallback 路径保留两阶段语义不变。**

那条测试要改成断言新的语义（分片路径单阶段、单发路径两阶段），**不是删掉它**。

- [ ] **Step 4: 逐条处理受影响的既有测试**

| 测试 | 位置 | 处理 |
|---|---|---|
| `uploads in chunks (init → PATCH×N → finalize)` | `stored-file.test.ts:165` | 它用 `chunkSize: 8` 且 fixture 只有 40 字节 → 流式后只有 1 帧（60 字节），naive 实现只发 1 个 PATCH，`state.patches > 1` 会失败。**用更大的 fixture** 让它真的跨多个块，不要改断言去迁就。 |
| `resumes after a mid-upload network error` | `:177` | **本任务最关键的回归守卫，必须继续通过。**另外**新增**一条：服务端返回的偏移落在块**内部**（部分提交）时也能正确续传。 |
| `throws UploadError on a fatal chunk status (413)` | `:196` | 应仍通过；额外确认抛错路径上生成器被终止。 |
| `falls back to the single POST when /api/uploads is unavailable` | `:185` | fallback 会**重新加密一遍**。要确保第一次尝试消费过的生成器不会被复用。 |
| `uploadFile — body wire format` | `:342` | **必须原样通过，不得修改。** |
| `store-crypto.interop.test.ts` Go↔JS 向量 | `:60,81` | **必须原样通过，不得修改。** |

- [ ] **Step 5: 验证**

```bash
cd web && npm run check && npx vitest run && npm run build
```

Expected: 类型检查 0 错误；全部测试通过；构建成功。

- [ ] **Step 6: 内存验证（本任务的核心交付）**

写一个临时脚本或测试，构造一个**远大于 chunkSize 的**输入（例如 100 MiB 的 File），跑一遍流式上传路径，测量峰值驻留。**不要**只靠代码阅读断言"现在是流式的"——请给出可复现的数字证据（例如在打包循环里记录缓冲区长度的最大值，断言它不超过 `chunkSize + STORE_CHUNK_SIZE + 一点余量`）。把这条做成常驻测试，否则将来有人再加一个 `frames.push` 不会有任何报警。

验证完把临时脚本删掉，常驻测试留下。

- [ ] **Step 7: 提交**

```bash
git add web/src/lib/
git commit -m "perf(web): stream chunked uploads instead of buffering the ciphertext

chunkedUpload collected every encrypted frame into an array and then built a
Blob from it, so peak memory was ~2x the ciphertext and a 1 GiB upload OOMed
on mobile. Frames are now packed into chunks and PATCHed as they are produced.
The ciphertext length is computed up front so ?size= stays exact and the
server is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾验证

```bash
cd server && go build ./... && go vet ./... && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -20
cd ../web && npm run check && npx vitest run 2>&1 | tail -5 && npm run build 2>&1 | tail -3
```

**人工确认（部署后）**：
1. 后台套餐编辑器出现「每日额度 (MiB)」，四个出厂档位分别是 200 / 102400 / 348160 / 1740800 MiB。
2. 用一个 Plus 档账号在**浏览器**上传一个 500 MiB 文件——应当成功，且**浏览器内存不随文件大小线性增长**（开 DevTools 内存面板看）。这是本次两个改动的合流点，也是"1 GiB 端到端可用"的真正验收。
3. 手机浏览器上传一个 300 MiB 文件不再崩溃。

## Self-Review 记录

- **Spec 覆盖**：spec 的 A/B/C 三节分别落在 Task 1/2/3。
- **符号一致性**：`Plan.DailyQuotaBytes` / `dailyQuotaFor` / `cipherSizeFor` 在定义与消费任务中拼写一致。
- **需实现者确认的项（已在步骤内标注，非占位符）**：Task 1 Step 1 的 plans 表列同步点数量；Task 1 Step 4 四处替换各自的 fail-open/closed 取向；Task 2 Step 3 是否已有 remaining 形式的辅助函数；Task 3 Step 2 的重放缓冲需支持块内偏移续传。
- **最大风险**：Task 3 的重试路径。既有的 `resumes after a mid-upload network error` 是主要守卫，计划已要求**额外**补一条"服务端偏移落在块内部"的用例——那正是从 Blob 切片改成流式后新出现的情形。
