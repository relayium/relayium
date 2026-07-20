# 可存储列修正 + 大文件下载拦截 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 三件收尾：让 12 个后台设置的行为拉齐；让后台「可存储」列显示真实答案而不是三道闸中的一道；在**下载端**拦住手机浏览器下不动的大文件。

**Architecture:** 三个互不依赖的任务。W1 是一行种子数据。W2 把放置过滤的三道闸从 SQL 提炼成一个具名 Go 函数，SQL 与 Go 共用同一组常量。W3 在下载页开始下载**之前**用「浏览器有无流式落盘能力 × 文件总大小」拦截，并在上传页给发送方一句提示。

**Tech Stack:** Go（`server/`）、`html/template`、Svelte 5 + TypeScript（`web/`）。

## 背景：为什么 W3 拦在下载端

能力矩阵（已实测确认）：

| 路径 | 大文件表现 |
|---|---|
| 上传·网页·分片（正常路径） | ✅ 峰值 8.6 MiB |
| 上传·网页·单发（退路） | ⚠️ 2× 文件，已限制在 64 MiB |
| 上传·CLI | ✅ 流式 |
| 下载·网页·桌面 Chrome/Edge | ✅ 流式落盘（File System Access） |
| **下载·网页·Firefox / Safari / 所有手机** | ❌ **整个文件进内存**（`filesink.ts:61,77`）|
| 下载·CLI | ✅ 流式 |

iOS 上所有浏览器都是 WebKit、安卓 Chrome 也不支持 File System Access ⇒ **所有手机浏览器下载大文件都会 OOM**。而它砸的是**接收方**——那个人没参与决定文件多大。发送方在电脑上传得好好的，接收方在手机上打开链接，页面直接崩。

所以防线要放在下载页：那里既知道总大小（`DownloadPage.svelte:53` 的 `totalBytes`，从 manifest 算出，在下载**之前**就有），也能探测浏览器能力（`showSaveFilePicker` 在不在）。**在唯一知道真相的时刻、对唯一能改变结果的人说话。**

服务端 1 GiB 上限**不改**——CLI 在这个尺寸上是真能跑的，调小会连它一起罚。

## Global Constraints

- Go 测试 `cd server && go test ./...`；前端 `cd web && npx vitest run`、`npm run check`、`npm run build`。
- **commit message 一律英语**。用户可见文案中文（后台界面、下载页提示）。代码注释跟随所在文件既有风格。
- **不改服务端 `MaxFileSize` 上限**，不改上传的分片/单发路径，不改 `filesink.ts` 的落盘策略本身（W3 只是**在它之前**拦一道）。
- 还原临时改动一律用 `cp` 备份，**禁用 `git checkout`**。变异按**行号**定位并回显被改的那一行自证。
- **比例只定义一次**：本计划新增的 80% 卷保留常量必须同时供 SQL 与 Go 使用，不得再出现裸字面量 `5`。

---

### W1: `node_traffic_default` 补进种子列表

**Files:** Modify `server/internal/account/settings.go`（`SeedSettings` 的 defaults 切片）；Test: `server/internal/account/settings_test.go` 或新建

**问题**：12 个后台设置里，`SeedSettings` 写了 11 个，唯独漏了 `SettingNodeTrafficDefault`。后果是**这一个设置的行为与另外 11 个不一样**——它的命令行 flag 在首次启动后仍然生效，而另外 11 个不会（DB 值优先，种子写完就压住了）。两个长得一样的参数行为不同，是个陷阱。

拉齐规则：**命令行/环境变量 = 首次部署的初值，之后一律以后台为准。** 只有一条规则，没有例外。

- [ ] **Step 1: 写失败的测试**

断言 `SeedSettings` 之后 `node_traffic_default` 在 settings 表里存在且等于 `cfg.NodeTrafficDefault`。**另外断言它遵守"已存在则不覆盖"**（先手动写一个不同的值，跑 SeedSettings，确认没被改）——那是 `SeedSettings` 对所有 key 的既有语义，新 key 不该例外。

先读既有的 SeedSettings 测试找手法（`grep -rn "SeedSettings" internal/account/*_test.go`）。

- [ ] **Step 2: 确认失败** → `cd server && go test ./internal/account/ -run TestSeed -v`

- [ ] **Step 3: 实现** —— 在 `SeedSettings` 的 defaults 切片里加一行：

```go
		{SettingNodeTrafficDefault, s.cfg.NodeTrafficDefault},
```

并在 `SeedSettings` 的文档注释里写明这条规则（flag/env 是首次部署初值，之后后台优先），这样后人加新设置时知道要同步这里。

- [ ] **Step 4: 确认通过 + 全量** → `go build ./... && go test ./...`

- [ ] **Step 5: 提交**

```
feat(settings): seed the node traffic default like every other setting

It was the only one of the twelve admin settings missing from SeedSettings,
so its flag stayed live after first boot while the other eleven were pinned
by their seeded DB row. Two identical-looking flags behaving differently is
a trap; now the rule has no exceptions.
```

---

### W2: 「可存储」列显示三道闸取最小值

**Files:**
- Modify: `server/internal/account/sqlite.go`（80% 保留的具名常量；两处 SQL 用它）
- Modify: `server/internal/account/admin.go`（`adminNodeView.UsableBytes` → 改为三闸取最小；新 helper）
- Modify: `server/internal/account/admin_templates.go`（列名去掉 `(70%)`）
- Test: `server/internal/account/admin_usable_test.go`（扩充）+ 渲染测试

**问题**：这一列现在只反映放置过滤三道闸中的一道（70% 余量）。一台 100 GB 盘用了 92 GB、剩 8 GB 的节点，这一列显示 `5.6 GB`（8×0.7），**实际上一个字节都放不进去**——因为剩余 8 GB 已低于总量的 20%，第二道闸把它整台排除了。

三道闸（见 `sqlite.go` 的 `StorageNodes`）：
1. `storage_free * 7/10 >= 需要的量`
2. `storage_total = 0 OR storage_free * 5 >= storage_total`（卷不得超 80% 满）
3. `disk_limit_bytes = 0 OR disk_limit_bytes - stored_bytes >= 需要的量`

- [ ] **Step 1: 先给 80% 保留一个名字**

现在它是**两处裸字面量 `5`**（`sqlite.go:2173` 与 `:2209`），是本项目"比例只定义一次"纪律的唯一例外（终审点名过）。在 `storageHeadroomNum/Den` 旁边加：

```go
// 卷保留：剩余空间必须至少占总量的 1/volumeReserveDen，否则该节点整台退出放置池，
// 免得 relayium 把宿主机的盘撑爆。与 storageHeadroom* 是两回事——那个限制"一次放
// 多少"，这个限制"整块盘能用到多满"。节点本地 relay.go 有同口径的绝对写闸。
const volumeReserveDen = 5 // storage_free * 5 >= storage_total ⇔ 剩余 ≥ 20%
```

两处 SQL 改用 `fmt.Sprintf` 拼这个常量（`:2209` 那处 `UserStorageNodes` 目前可能不是 Sprintf，需要改造；**只改这个字面量的来源，不要动它的语义**）。

**注意**：`cmd/relayium-node/relay.go:105` 的 `f*5 < t` 是**节点本地**的同口径写闸，属于另一个二进制、无法共享常量。**不要动它**，但在新常量的注释里点名它，说明两者必须一起改。

- [ ] **Step 2: 写失败的测试**

用终审给的那个真实场景：100 GB 卷、已用 92 GB、剩 8 GB。断言这一列是 **0** 而不是 5.6 GB。

再覆盖：
- 三道闸都宽松时 = 70% 那道的值（原行为）
- `disk_limit_bytes` 是最紧的一道时 = `disk_limit - stored`
- `disk_limit - stored` 为负时 = 0（不能显示负数）
- 节点从未上报存储（`StorageTotal = 0`）时的取值——请判断显示什么合理，并说明理由

- [ ] **Step 3: 实现**

在 `admin.go` 加 helper（与 `usableBytes` 相邻），**逐条镜像 `StorageNodes` 的三道闸**：

```go
// storableBytes 是这台节点现在真正还能接收的字节数——放置过滤三道闸取最小值，
// 任一道把它整台排除时为 0。
//
// 必须与 SQLiteStore.StorageNodes 的 WHERE 保持一致：那边是"够不够放下这一个
// 文件"的布尔判断，这边是"还能放多少"的数值，同一组条件的两种问法。改一边就要
// 改另一边——这是这两处之间唯一的耦合，没有更好的共享方式（SQL 里算不出 min）。
func storableBytes(n Node) int64 { ... }
```

`adminNodeView` 的字段改名为 `StorableBytes`（原 `UsableBytes` 语义已变，留着旧名会误导），所有引用同步更新。

- [ ] **Step 4: 模板改名**

`<th>可存储(70%)</th>` → `<th>可存储</th>`；数据行的字段名跟着改。

**上一轮的教训**：模板字段名拼错时 `html/template` 在执行期才报错，会让 `/admin` 页面**渲染到一半截断**而测试全绿。必须有真正渲染模板的测试覆盖新字段（既有的 `admin_official_nodes_ui_test.go` 已经有这个手法，扩充它）。HTML 断言用 `strings.Count(html, want) != 1` 而非 `Contains`，并核算 fixture 各值之间无子串碰撞。

- [ ] **Step 5: 验证 + 变异**

```bash
cd server && go build ./... && go vet ./... && gofmt -l internal/account/ && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -20
```

变异（按行号定位 + 回显自证）：
1. `storableBytes` 去掉 80% 那道闸 → 100GB/剩8GB 那条应失败
2. 去掉 disk_limit 那道闸 → 对应用例应失败
3. 模板字段名拼错一个字母 → **应失败**（模板有覆盖的证明）
4. `volumeReserveDen` 从 5 改成 4 → **SQL 与 Go 两边都该有测试失败**（证明两处真的都在用这个常量）

- [ ] **Step 6: 提交**

```
feat(admin): show what a node can actually store, not just the headroom term

The column reflected only the 70% headroom gate, so a node already past the
80% volume reserve -- excluded from placement entirely -- still advertised
capacity. It now takes the minimum of all three placement conditions and
reads 0 when any of them excludes the node outright.
```

---

### W3: 下载端拦截大文件 + 上传端提示

**Files:**
- Modify: `web/src/lib/filesink.ts`（导出一个能力探测函数）
- Modify: `web/src/lib/DownloadPage.svelte`（下载前拦截）
- Modify: `web/src/lib/StoredUpload.svelte`（上传时提示）
- Modify: `web/src/lib/i18n/types.ts` + 9 个语言文件
- Test: `web/src/lib/filesink.test.ts` 或相应组件测试

**阈值**：`256 * 1024 * 1024`（256 MiB）。定义成一个具名常量，注释写明它是**保守估计、需真机验证**，不是实测出来的硬数字。

**核心判断**：拦截条件是 **`没有流式落盘能力` 且 `总大小 > 阈值`**。有流式能力（桌面 Chrome/Edge）时不拦——那条路多大都行。

- [ ] **Step 1: 导出能力探测**

`filesink.ts` 现在在 `pickSaveTarget` 内部才判断 `w.showSaveFilePicker`。抽一个导出函数（例如 `canStreamToDisk(): boolean`），供下载页在**下载开始前**调用。**不要改变 `pickSaveTarget` 的既有行为**，只是把判断条件暴露出来。

注意 `filesink.ts:82` 的判断还带了 `files.length === 1` 这个条件（多文件走另一条路）。请读代码确认多文件时的落盘策略是什么、是否同样受内存限制，并在报告里说明你的探测函数是怎么处理多文件的。

- [ ] **Step 2: 下载页拦截**

`DownloadPage.svelte` 已有 `totalBytes`（`:53`）。在下载按钮的处理里，**在 `pickSaveTarget` 之前**判断：

```
if (!canStreamToDisk() && totalBytes > LARGE_DOWNLOAD_WARN_BYTES) → 显示提示，不开始下载
```

提示要说清三件事：为什么（你的浏览器需要把整个文件读进内存）、会怎样（可能崩溃）、怎么办（用电脑版 Chrome/Edge，或用命令行工具）。

**这是提示还是硬拦？** 请做成**提示 + 明确的"仍要继续"选项**，不要硬拦死——用户可能在一台内存充足的桌面 Firefox 上，比我们更清楚自己的情况。默认不继续。

- [ ] **Step 3: 上传页提示**

`StoredUpload.svelte`：选中的文件总大小超过阈值时，给发送方一句提示——接收方如果用手机可能下载不了。**只是提示，不阻止上传。**

- [ ] **Step 4: i18n**

新增 key 放在合适的块下，补齐 9 个语言（`zh/en/ja/ko/de/fr/ar/es/pt`）——少一个 `npm run check` 就会失败，这是本仓刻意保留的保障。

**术语一致性**：`存储`/`下载`/`浏览器` 这些词在各语言文件里已有既有译法，请 grep 出来跟随，不要引入新词（上一轮在这里栽过：日语和阿拉伯语的"流量"用了仓库里从未出现的新词）。

- [ ] **Step 5: 测试**

- 能力探测：有/无 `showSaveFilePicker` 两种情况
- 下载页：无流式能力 + 大文件 → 显示提示且**未开始下载**；有流式能力 + 大文件 → 正常下载；无流式能力 + 小文件 → 正常下载
- "仍要继续"能真的继续
- 上传页提示的显示/不显示

参考 `QuotaNotice.test.ts` / `PlanCard.test.ts` 的 mount + flushSync 手法。

- [ ] **Step 6: 验证 + 变异**

```bash
cd web && npm run check && npx vitest run && npm run build
```

变异：
1. 把拦截条件的 `!canStreamToDisk()` 去掉（变成只看大小）→ "有流式能力 + 大文件应正常下载"那条应失败
2. 把阈值改成 0 → "小文件正常下载"那条应失败
3. 把"未开始下载"的断言对应的实现去掉（提示显示了但仍然开始下载）→ 应有测试失败

- [ ] **Step 7: 提交**

```
feat(web): warn before a download the browser must buffer in memory

Only Chrome/Edge on desktop stream a download to disk; Firefox, Safari and
every mobile browser buffer the whole file, so a large transfer kills the
recipient's tab -- and the recipient never chose the size. The download page
now says so before starting, with an explicit continue for people who know
their machine can take it.
```

---

## 收尾验证

```bash
cd server && go build ./... && go vet ./... && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -20
cd ../web && npm run check && npx vitest run 2>&1 | tail -5 && npm run build 2>&1 | tail -3
```

**人工确认（部署后）**：
1. 后台节点表列名是「可存储」，一台剩余空间低于总量 20% 的节点显示 0。
2. 用手机浏览器打开一个 >256 MiB 的下载链接，应看到提示而不是直接崩。
3. 桌面 Chrome 打开同一个链接，不应有提示。

**已知 flake**：`store-crypto.interop.test.ts` 的多文件 Go 向量用例约 10-15% 概率抛 `_malloc` TypeError，与本计划无关，撞上重跑。

## Self-Review 记录

- **符号一致性**：`volumeReserveDen` / `storableBytes` / `adminNodeView.StorableBytes` / `canStreamToDisk` / `LARGE_DOWNLOAD_WARN_BYTES` 在定义与消费处拼写一致。
- **需实现者判断的项**：W2 Step 2 的 `StorageTotal = 0` 显示什么；W3 Step 1 的多文件落盘策略与探测函数的关系。
- **最大风险**：W2 的 `storableBytes` 与 `StorageNodes` 的 SQL 是两处必须同步的实现，SQL 里算不出 min 所以无法共享。变异 4（改 `volumeReserveDen`）是这条耦合的守卫。
