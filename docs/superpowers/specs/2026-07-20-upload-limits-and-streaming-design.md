# 上传额度按档位 + 浏览器流式上传

**日期**: 2026-07-20
**状态**: 已确认，待实现
**起因**: `2026-07-20-node-traffic-budget-design.md` 的 Task 1（单文件上限 50 MiB → 1 GiB）审查发现该改动**端到端不生效**

## 背景

把单文件上限提到 1 GiB 之后，审查发现两条独立的阻塞，1 GiB 对任何人都用不上：

1. **日额度 200 MiB 卡在前面，且不分档位。** `main.go:104` 的 `-daily-quota` 默认 200 MiB，它是一个**全局设置**（`SettingDailyQuota`），`Plan` 结构体里没有日额度字段——Max 档用户和免费用户共用同一个 200 MiB/天。任何 >200 MiB 的文件都会先被日额度拒掉。唯一例外是自带节点（BYO）上传（`billable=false`），那条路绕过日额度。

2. **浏览器把整个密文堆在 JS 堆里。** `web/src/lib/stored-file.ts:128-137` 先 `frames.push(fr)` 收齐全部密文帧、再 `new Blob(frames)`，峰值约 2× 密文（数组 + Blob 副本，且 `frames` 在整个函数作用域内存活）。1 GiB 文件在移动端必 OOM。分片上传解决的是网络中断，不解决内存。

调研另外澄清了两件事：

- **下载端已经是流式的**，`StoreDecryptor` 只保留一个不完整的尾帧（上界 `STORE_CHUNK_SIZE + 16 + 256`）。本轮范围**只有上传**。
- 之前称为"额度绕过"的 `?size=0`，性质是**磁盘占位**而非额度窃取：`declared` 仅用于 init 时的提前拒绝，从不入库、不参与 `cappedReader`、finalize 也不校验它（finalize 用 `sess.received` 这个真实字节数重跑全部额度闸）。所以偷不走额度，但能靠 5 个会话 × `MaxFileSize` × 1 小时 TTL 占住磁盘——这个数因单文件上限提升被放大了 20 倍（250 MiB → 5 GiB/账号）。

## 设计

### A. 日额度挪进套餐表

`plans` 表加列 `daily_quota_bytes`，`Plan` 结构体加对应字段。出厂值按"付费档 = 月流量 ÷ 3"：

| 档位 | 存储 | 月流量 | **日额度（新）** |
|---|---|---|---|
| free | 100 MiB | 1 GiB | 200 MiB（维持现值） |
| plus | 5 GiB | 300 GiB | 100 GiB |
| pro | 50 GiB | 1 TiB | 340 GiB |
| max | 250 GiB | 5 TiB | 1700 GiB |

免费档维持 200 MiB 而不按公式算成 100 MiB，是为了不让现有免费用户感到变严。

**解析规则**：`plan.DailyQuotaBytes > 0` 用它；`<= 0` 回落到全局 `SettingDailyQuota`。存量 `plans` 行的新列默认 0，因此**迁移后行为不变**，直到管理员或种子数据填入值。全局设置保留，作为兜底与"整体调节"的旋钮。

替换 `st.DailyQuota` 的四处使用：`files.go:145`、`files.go:224`、`uploads_resumable.go:200`、`uploads_resumable.go:356`。

后台套餐编辑器增加该列。

### B. 会话上限由服务端剩余额度推导

`handleUploadInit` 当前把 `sess.maxSize` 设为 `st.MaxFileSize` 的快照（`uploads_resumable.go:230`），与客户端声明的 `size` 无关。改为：

```
sess.maxSize = min(MaxFileSize, 剩余日额度, 剩余存储额度, 剩余流量额度)
```

四个量全部由服务端自己算，不读客户端的 `?size=`。这样声明 `size=0` 不再有任何好处——`cappedReader` 的上界本就不由它决定，而现在这个上界还进一步收敛到用户真实的剩余额度。

`?size=` 保留用于提前拒绝（早失败比传完再拒好），但它不再是唯一的防线。

**不改 finalize 的权威地位**：finalize 仍用 `sess.received` 重跑全部额度闸。B 只是把浪费的带宽和磁盘占用提前掐掉。

### C. 浏览器流式上传

**只改分片路径**（`chunkedUpload`）。单发路径 `uploadFile` 是 fallback，继续用 XHR + Blob——流式 `fetch` body 需要 `duplex: "half"` 与 HTTP/2，且会丢掉 `upload.onprogress`，为一条 fallback 付这个代价不值得。

**密文总长精确可算**，因此 `?size=` 保持精确、**服务端零改动**：

```
cipherSize = Σ_i [ size_i + 20 × ceil(size_i / 196608) ]
```

依据：`store-crypto.ts` 的 `frame()` = `uint32BE(len) ‖ ct`，AES-GCM 的 `ct = 明文 + 16`，故每帧 = 明文 + 20 字节；`STORE_CHUNK_SIZE = 192 KiB = 196608`；**文件之间没有分隔帧**（`seq` 全局递增，每个文件独立分块，末块不补齐）；空文件贡献 0 字节（循环不执行）；manifest 走 init 的 body，不计入 `cipherSize`。

新增 `cipherSizeFor(files: File[]): number` 实现该公式，并单独测试（多块、恰好整数块、空文件、零文件、多文件）。

**打包策略**：从 `encryptFiles` 生成器拉帧，贪婪填满 ≥ `chunkSize`（8 MiB）后 PATCH。帧约 192 KiB，一个块约 43 帧。**块边界不需要对齐帧边界**——服务端看到的是不透明字节流，`StoreDecryptor` 能跨任意边界重组。峰值内存 ≈ 8 MiB + 一帧。

**重试是最难的部分。** 现在 `uploadChunk` 靠对不可变 Blob 重新 `slice`；流式之后必须**保留当前块的字节**直到服务端确认。而且服务端**会提交部分块**（`uploads_resumable.go:292` 的 `sess.received = newSize // Append reports bytes written even on error`），所以 `uploadOffset()` 可能返回块起点**之后**的位置——重放缓冲必须覆盖整个在途块，并支持从块内任意偏移续传。

**进度阶段会变。** 现有测试 `reports the encrypting phase then the uploading phase` 断言 `phases === ["encrypting","uploading"]`，流式后两个阶段天然交织。**决定：合并成单一进度**，`UploadProgress` 的 `phase` 对分片路径恒为 `"uploading"`，进度按已确认字节 / `cipherSize` 计。理由：流式下加密与上传同步推进，一个中途归零重来的进度条比一个连续的更糟。`StoredUpload.svelte` 里在阶段切换时重置进度条的逻辑要跟着去掉。单发 fallback 路径保留两阶段语义不变。

## 不做的事

- **不改下载/解密路径**：已经是流式的。
- **不改单发 fallback 路径**：保留 XHR + Blob。
- **不改线格式**：`store-crypto.interop.test.ts` 的 Go↔JS 向量与 `stored-file.test.ts:342` 的字节布局断言必须原样通过——它们是这次重写不跑偏的最好保证。
- **不动 finalize 的权威校验**。

## 已知遗留

- `filesink.ts` 在 OPFS / File System Access 不可用时若回落成内存 Blob，下载 1 GiB 会在 sink 层 OOM。与本轮的加密器无关，是另一个 bug，未核实。
- `StoreDecryptor.push()` 每个网络块都 `new Uint8Array(...)` 重新拷贝（`store-crypto.ts:109-112`），是 CPU/GC 开销而非正确性问题。
- `-blob-disk-max` 默认 0（关闭），且 `StorageDiskCap` 在 `main.go` 里根本没有对应 flag——两道磁盘兜底默认全关，失败模式是盘被写满。属运维动作，不在本轮代码范围。
