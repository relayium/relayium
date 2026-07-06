# 计费套餐 · 第一期：档位配置 + 后台管理 + 额度强制（不含支付）

**日期：** 2026-07-06
**状态：** 已批准设计，待写实现计划
**上游依赖：** [2026-07-06-admin-per-user-usage-metering-design.md](./2026-07-06-admin-per-user-usage-metering-design.md)（`usage_monthly` 按月计量必须先实现——本期的额度强制读它）

## 目标与边界

给 Relayium 落地**套餐档位**：定义 Free/Plus/Pro/Max 四档，各自的**存储上限、月流量上限、暂存保留期、价格**都**后台可调**；把用户放进某档；在上传/下载/中继三处**按档强制额度**。

**本期只做"定档 + 限流"，不接支付。** Stripe 自助结账、超额按量计费、增值包、对象存储、存储 GB·月时长计费——全部第二期或以后。第一期的档位指派靠**后台手动**（验证有人愿付即可，收款可先走外部/手动）。

## 定价背景（已与产品方拍板）

- 存储是**稀缺资源**（本地盘，硬上限，如单机 ~20GB），流量富余。故存储给得紧、流量给得松。
- 存储供给走**本地盘**；不够了以后再接对象存储（`BlobStore` 已抽象，属以后工作）。付费档存储**超售**，靠全局盘闸兜底。
- 实时直传的 **P2P 直连不计费、不限量**（不过服务器）；只有 **TURN 中继 + 暂存上传/下载**计入"流量"额度。
- 下面数字是**出厂默认**；因为全部后台可调，运营方按实际盘容量随时改，不用发版。

| 档位 | 年付 | 月付 | 存储 | 月流量 | 保留期 |
|---|---|---|---|---|---|
| **Free** | — | — | 100 MB | 2 GB | 3 天 |
| **Plus** | $29 | $3.9 | 5 GB | 300 GB | 30 天 |
| **Pro** | $79 | $8.9 | 50 GB | 1 TB | 90 天 |
| **Max** | $199 | $19.9 | 250 GB | 5 TB | 180 天 |

## 架构

### 1. `plans` 表（后台可调的档位定义）

```sql
CREATE TABLE IF NOT EXISTS plans (
  id             TEXT    PRIMARY KEY,        -- 'free' | 'plus' | 'pro' | 'max'（稳定键）
  name           TEXT    NOT NULL,           -- 展示名
  storage_bytes  INTEGER NOT NULL,           -- 存储上限
  traffic_bytes  INTEGER NOT NULL,           -- 每月流量上限（中继+暂存上传下载）
  retention_secs INTEGER NOT NULL,           -- 暂存保留期上限（覆盖全局 max_ttl）
  price_monthly  INTEGER NOT NULL DEFAULT 0, -- 美分；0=免费/未定价
  price_yearly   INTEGER NOT NULL DEFAULT 0, -- 美分
  sort_order     INTEGER NOT NULL DEFAULT 0, -- 后台/前台展示顺序
  active         INTEGER NOT NULL DEFAULT 1, -- 停售的档位保留但不可新指派
  updated_at     INTEGER NOT NULL
);
```

- `stripe_price_id` 等支付字段**第二期**再加，本期不引入。
- 首次启动 `SeedPlans()`：表空时按上表写入 4 个默认档（与现有 `SeedSettings` 同一处调用）。已存在的行不覆盖（运营方的改动优先，同 settings 语义）。

### 2. 用户归属档位

`users` 增列：
```sql
ALTER TABLE users ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free';
```
新用户默认 `free`；存量用户迁移后也落 `free`。

### 3. 全局盘闸（存储超售的兜底）

新增一个 admin 设置 `storage_disk_cap`（字节，复用现有 settings 机制，`settings.go`）。任何上传前先查**全局**当前占用（`SUM(stored_files.size) WHERE expires_at>now`，后台首页已有此指标）+ 本次大小 > `storage_disk_cap` → 拒绝，与用户档位无关。默认设为略小于实际盘容量。

## 额度强制（三处 + 保留期）

统一用一个只读聚合作为"本月已用流量"：
```
CurrentMonthTraffic(userID) =
    usage_monthly(upload_bytes + download_bytes, period=当月)          -- 上游计量 spec
  + SUM(usage_events.relayed_bytes WHERE user_id=? AND recorded_at∈当月)  -- 中继
```
以及"当前存储占用" `CurrentStorage(userID) = SUM(stored_files.size WHERE user_id=? AND expires_at>now)`。

| 强制点 | 位置 | 逻辑 | 超限响应 |
|---|---|---|---|
| **上传·存储** | `files.go` 上传提交前 | `CurrentStorage(u) + size > plan.storage_bytes` | 413 + "存储空间不足，请清理或升级"（不删已有文件） |
| **上传·全局盘** | 同上，先于上一条 | 全局占用 + size > `storage_disk_cap` | 507 + "服务器存储已满" |
| **上传·流量** | `files.go` 上传提交前（沿用现有 daily-quota 预检旁边） | `CurrentMonthTraffic(u) + size > plan.traffic_bytes` | 429 + "本月流量已用尽，请升级" |
| **下载·流量** | `files.go` `handleFileBlob` 流式发送前 | 按**文件属主** `sf.UserID`：`CurrentMonthTraffic(owner) + sf.Size > plan.traffic_bytes` | 429 + "该文件所属账户本月流量已用尽" |
| **中继·流量** | `/api/ice` 签发 TURN 凭据时 | `CurrentMonthTraffic(u) > plan.traffic_bytes` → **不签发中继凭据**，只回 STUN（P2P 仍可直连） | 正常 200 但无 `turn:` 项；前端提示"超额，仅直连" |
| **保留期** | 上传创建暂存文件时 | 请求 TTL 向 `plan.retention_secs` 收敛（覆盖全局 `max_ttl` 的 `clampTTL`） | 静默截断到上限 |

设计要点：
- **P2P 直传永不受限**：超额只影响中继凭据签发和暂存收发，直连传输照常免费。
- **中继是粗粒度**：coturn 按事后上报，无法逐字节实时卡；策略是"已超额就不再签发新中继分配"。已在进行的中继不中途掐断。
- **下载按属主计费**：不读取下载方身份（保持零知识），流量记在文件属主账上，超额则该属主的分享链接暂停可下载。
- 强制读的都是**当月**用量，自然按月重置。

## 后台

### 套餐管理区（新增）

`/admin` 加一节"套餐"：
- 列出所有 `plans`，每档可**改** name/storage/traffic/retention/price/sort/active（表单 POST，与现有 `/admin/settings` 同风格）。
- `storage_disk_cap` 全局盘闸也放在这里改。
- 校验：字节/秒/价格为非负整数；至少保留一个 `active` 档。

### 用户档位指派

- 用户列表每行显示 `plan_id`（承接计量 spec 已加的按月用量列——一眼看到"这人在哪档、本月用了多少、还剩多少"）。
- 加一个指派入口（列表行内下拉或用户详情页），POST 改 `users.plan_id`。仅 `active` 档可选。

## 涉及文件

- `server/internal/account/sqlite.go` — 建 `plans` 表、`users.plan_id` 迁移、`SeedPlans`、plans CRUD、`GetUserPlan`、`SetUserPlan`、`CurrentMonthTraffic`/`CurrentStorage` 查询。
- `server/internal/account/store.go` — `Plan` 结构、相关接口方法、`users` 视图加 `PlanID`。
- `server/internal/account/settings.go` — `storage_disk_cap` 设置键。
- `server/internal/account/files.go` — 上传（存储/全局盘/流量）+ 下载（流量）强制；上传 TTL 按 `plan.retention_secs` 收敛。
- `server/internal/account/`（ICE/TURN 签发处，`handlers.go` 里 `/api/ice`）— 超额不签发中继凭据。
- `server/internal/account/admin.go` + `admin_templates.go` — 套餐管理区、盘闸、用户档位指派。
- 对应 `_test.go`。

## 测试

1. `SeedPlans`：表空时建 4 档；已存在不覆盖。
2. plans CRUD + 校验（负数拒绝、至少一个 active）。
3. `SetUserPlan` / 默认 `free` / 只能指派 active 档。
4. 强制：
   - 存储超限→上传 413；未超→通过；已有文件不被删。
   - 全局盘闸→上传 507（先于个人存储判断）。
   - 月流量超限→上传/下载 429；下载按属主判定；跨月自动重置。
   - 中继超额→`/api/ice` 无 `turn:`，STUN 仍在；未超→有 `turn:`。
   - TTL 按档收敛（Free 3 天、Pro 90 天）。
5. P2P 路径不受任何额度影响（回归）。
6. 端到端：把某用户设 Free（100MB/2GB/3天），传超 100MB 被存储拦、月内累计超 2GB 被流量拦、TTL 被截到 3 天。

## 明确不在本期

Stripe 结账 / webhook / 自动指派、超额按量计费、增值包、对象存储后端、存储 GB·月时长计费、前台定价页与自助升级 UI。
