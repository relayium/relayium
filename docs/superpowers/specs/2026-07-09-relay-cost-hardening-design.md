# Relay 成本加固设计 (Relay Cost Hardening)

- 日期: 2026-07-09
- 状态: 已通过 brainstorming 对齐,待 review
- 相关文件: `server/internal/account/turn.go`、`server/internal/metering/`、`server/main.go`、`deploy/coturn-setup.sh`、`deploy/coturn.md`

## 背景

Relayium 的 TURN relay 带宽是当前唯一"每字节都花真钱"的资源(egress 计费)。接入支付之前,relay 就已经存在成本被白嫖导致"惊吓账单"的风险。审阅 `turn.go` 发现三个具体钱漏点:

1. **单凭证窗口无上限** —— `handleICE` 只在**发凭证时**检查月配额(`turn.go:61`),凭证 TTL 为 1 小时;coturn 只通过 Redis 上报流量(`total_traffic` 频道),**自身不做任何配额强制**。因此一个持有有效配对码的用户,在单个凭证窗口内可无上限中转,月配额只能拦下一次发放。
2. **Redis 读错 fail-open** —— `turn.go:55-56` 注释写明:量度读取出错时"issue TURN rather than blocking"。Redis 一抖动,月配额软拦整个失效。
3. **Sybil 绕过** —— 月配额按账号计,但账号免费无限注册,批量建号即可绕过。

coturn 部署脚本 `deploy/coturn-setup.sh` 当前也**未设**任何 coturn 原生上限,云端亦无 egress 账单硬顶。三层全敞开。

## 目标

**首要目标:封住灾难性账单。** 接受一定程度的白嫖,但保证任何单个用户 / 单段时间都不可能把 relay 账单打到失控。硬天花板放在基础设施层。

- 月度 relay 带宽"兵总额"硬切点: **数十 GB / 月**。到顶后**全局关闭 relay,STUN 仍可用**(同网段 / 能 NAT 打洞的传输不受影响)。

## 非目标 (YAGNI)

- **不做**精确的每账号公平配额 / 按 plan 分级限流 —— 那是"让月配额真正生效"的目标,属于计费 phase-1,不在本次范围。
- **不改** `handleICE` 的发凭证判定逻辑本身(单窗口问题改由 Layer 1 限速解决,而非改发放逻辑)。
- **不做** WebRTC / 信令 / 加密层的任何改动。

## 架构:三层防线(从硬到软)

关键定位(本设计的地基):**月度累计字节的硬天花板,只能由 Layer 0(云 egress 账单)兑现。coturn 原生配额管的是"并发数"与"每会话速率",不是"月累计字节"。** 因此 coturn 的作用是"限制漏得多快、给人工反应时间",不是月度硬切本身。

### Layer 0 —— 云 egress 账单告警 / 硬上限(唯一真正的月度字节天花板)

- 在每台 relay 主机所在云厂商配置**带宽 / egress 预算告警**,三档:50% / 80% / 100%(以"数十 GB/月"折算的金额或流量为基准)。
- 到 100% 档挂一个**自动动作**:停 coturn 服务或用防火墙断掉 relay 端口(3478/5349),STUN 不受影响。
- 与代码完全无关,是"下面全失效也不会收到惊吓账单"的最后一道墙。
- 交付物: `deploy/coturn.md` 增补"每 relay 主机的账单告警 + 到顶自动停 coturn"的 runbook(具体云厂商动作由部署者按其平台实现,文档给出通用步骤与推荐阈值)。

### Layer 1 —— coturn 原生限速 / 限并发(限制"漏得多快")

在 `deploy/coturn-setup.sh` 生成的 coturn 配置里增加(每个 relay 都加):

- **每会话速率上限**(`max-bps`):使单会话在 1 小时凭证窗口内的最大中转量 = `max-bps × 3600`,从而**封死"单窗口无上限"**(钱漏点 1),无需改发凭证逻辑。默认取一个既够正常大文件传输、又不至于被当高速代理的值(建议起步几 Mbps,实现期定稿)。
- **并发分配上限**(`user-quota` / `total-quota`):防单用户同时开大量分配、防被当高速代理集群。
- 纯配置改动,零 Go 代码。

> ⚠️ 实现期需核对: `max-bps` / `user-quota` / `total-quota` / `bps-capacity` 在所装 coturn 版本上的**确切单位与语义**(并发数 vs 带宽),以本机 `turnserver` 版本文档为准,写进 setup 脚本时校验一次实际生效。

### Layer 2 —— app 月配额的两处便宜收口(Layer 0 已兜底,只做低成本、不误伤的)

1. **fail-open 保留 + 加告警**(钱漏点 2)
   - **决策:维持 fail-open**(Redis 读错时仍发 relay),优先保可用性 —— 真用户跨网络传输不因 Redis 抖动而中断。因为 Layer 0/1 已封住成本,严格 fail-closed 得不偿失。
   - **改动:** 在 `turn.go` 量度读取出错的分支,发出一条**告警 / 指标**(表明"计量瞬盲"),让运维及时发现并修 Redis。日志字段或 metrics counter 均可,不新增外部依赖。

2. **Sybil 抑制:relay 发放要求邮箱已验证**(钱漏点 3)
   - 邮箱验证已上线,几乎白捡的最低成本手段:未验证邮箱的账号,`handleICE` 不发 relay(STUN 照发)。
   - 挡住"脚本批量建号刷免费额度"的最廉价门槛。**不做**更精细的每账号公平配额。

## 各层交付物汇总

| 层 | 改动 | 文件 | 类型 |
|---|---|---|---|
| L0 | egress 账单告警 + 到顶自动停 coturn 的 runbook | `deploy/coturn.md` | 文档 |
| L1 | `max-bps` + 并发配额写入 coturn 配置 | `deploy/coturn-setup.sh` | 配置脚本 |
| L2a | fail-open 分支加告警/指标 | `server/internal/account/turn.go` | Go |
| L2b | relay 发放前校验邮箱已验证 | `server/internal/account/turn.go`(+ store 查询) | Go |

## 测试策略

- **L2b(邮箱验证门槛):** 单测覆盖 `handleICE` —— 未验证邮箱 → 响应含 STUN、不含 relay/relays 且带 `relayDenied` 标记;已验证 → 正常发 relay。复用 `turn_test.go` 现有夹具。
- **L2a(fail-open 告警):** 单测:注入一个 Redis 读取返回 error 的 store,断言仍发 relay **且**告警指标/日志被触发。
- **L1(coturn 配置):** `deploy/coturn-setup.sh` 生成的配置包含 `max-bps` 等指令(可加一个 grep 断言到 `deploy/test/`);实机 `turnserver` 版本语义核对为实现期手动检查项。
- **L0:** 文档变更,无自动化测试;runbook 里给出人工验证步骤(触发一次告警 / 验证到顶动作)。

## 决策记录

- **目标 = 封灾难性账单**(非精确公平)。
- **月度硬切阈值 = 数十 GB/月**,到顶全局关 relay、STUN 保留。
- **月度硬切执行者 = Layer 0 云账单**;coturn 只做限速/限并发。
- **fail-open 保留**,加告警而非改成 fail-closed(可用性优先,成本已被 L0/L1 兜底)。
- **Sybil 抑制止于"要求邮箱已验证"**,不做每账号精确配额。

## 实现期需核对项(open questions)

1. coturn 各限速/配额指令在所装版本的确切单位与语义(见 Layer 1 警示)。
2. `max-bps` 的具体数值(需兼顾正常大文件直传速率与防滥用)—— 起步值实现期定,可后续按实际调。
3. Layer 0 的到顶自动动作在当前 relay 主机云厂商上的具体实现方式(告警 webhook / 预算动作 / 脚本),部署者环境相关。
