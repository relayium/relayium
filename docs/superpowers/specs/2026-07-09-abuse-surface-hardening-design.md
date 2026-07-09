# 付费滥用面加固 Round 2 设计 (Abuse-Surface Hardening)

- 日期: 2026-07-09
- 状态: 已通过 brainstorming 对齐,待 review
- 来源: 5-agent 安全审计(付费/计量服务滥用面),见对话记录
- 相关包: `server/internal/signal/`、`server/internal/account/`、`server/internal/storage/`、`server/internal/metering/`、`server/main.go`

## 背景

审计发现:Relayium 的"人均配额"是唯一的闸,而它被"随便建号 + 几个关键端点根本没限速 + 一条完全绕开计量的免费信令通道"轻松击穿。本轮修复这些**能让人白嫖付费/计量资源或让我们付费(带宽/存储/邮件)**的路径。

**范围内(本 spec):** C2、H1、H2、H3、H4、M1、M2、M3、M4。
**明确不在本轮(单独处理):** C1(计量在默认部署路径下未接线 + 无告警)——已向用户单独说明,单独立项。

## 目标 / 非目标

- 目标:堵死"零门槛/低成本白嫖"路径,并给关键成本端点加限速与全局兜底。
- 非目标:不做完整反欺诈/风控体系;不引入外部依赖(除非 M2 的 Redis 用法调整,仍是已有的 `redis/go-redis`);不改 WebRTC/加密语义;不改已确认稳固的部分(HMAC 凭证、blob 单账号配额 TOCTOU、session/IDOR、admin 鉴权——审计已判 sound)。

## 各修复项

### C2 — 信令通道不能当免费/无计量 bulk 中转 【Critical】

**问题:** `/ws` 用 `websocket.Accept(w,r,nil)` 未设读限;`ServeWS`(`server/internal/signal/client.go:100-122`)的 `TypeSignal → h.Relay` 原样转发,除单帧默认上限外无任何速率/累计字节限制;LAN 房间(无 code)还无需登录、无限速。攻击者切片 push 即得免费双向 bulk 中转,绕开计费 TURN。

**改动(全在 `ServeWS`,对所有连接一律生效,含 LAN):**
1. 连接建立后 `c.SetReadLimit(32 << 10)`(32 KiB)——显式单帧上限。真 SDP/ICE 只有几 KB(数据通道无音视频编解码)。
2. **每连接累计信令字节上限 = 1 MiB**:累加每个 `TypeSignal` 的负载字节;累计超过 `maxSignalBytes = 1<<20` 即 `c.Close(StatusPolicyViolation, "signal budget exceeded")`。一次真实 rendezvous 远不到 100 KB,1 MiB 给约 10× 余量;bulk 中转要 MB/GB → 掐断。
3. **每连接信令消息速率 = 令牌桶(burst 50,补充 10/s)**:无令牌时 `c.Close(StatusPolicyViolation, "signal rate exceeded")`。防 CPU 刷。

**边界/取舍:** 计数与限速在 `ServeWS` 内每连接局部状态(非全局),`TypeJoin` 不计入信令预算(只有 `TypeSignal` 负载计入)。字节/速率阈值定为常量并加注释说明可调。

**测试:** 单测驱动 `ServeWS`(已有可注入 `Conn`/`writeFn` 的测试基座):① 累计 `TypeSignal` 超 1 MiB → 连接被关且返回 policy-violation;② 正常小信令(<100 KB)不受影响、正常 relay;③ 高频消息触发速率关闭;④ `SetReadLimit` 生效(超大单帧被 coder/websocket 拒绝→读错误→连接结束)。

### H1 — `/api/ice` 限速 【High】

**问题:** `mux.HandleFunc("GET /api/ice", s.handleICE)`(`handlers.go:89`)裸注册无限速;可暴力枚举 6 位配对码(10⁶ 空间,15 分钟 TTL)偷记在受害者账上的 TURN 凭证。

**改动:** 复用 `signal.RateLimiter`,新增 `iceLimiter := NewRateLimiter(5, time.Minute, ...)`,在 `/api/ice` 处理前按 `ipx.IP(r)` 键限流,超限返回 429。**5 次/分钟/IP**(用户已定)。接线点在 `main.go`(那里已有 `ipx`);account 包提供一个可被外部限流包裹的入口,或 `main.go` 用中间件包裹该路由。

**测试:** 单测:同一 IP 第 6 次/分钟 → 429;不同 IP 各自独立;放行时 handleICE 行为不变。

### H2 — register 限速 + 反 Sybil 邮箱去重 【High】

**问题:** `POST /api/auth/register`(`handlers.go`)无任何限速,每次对新地址同步发一封验证邮件 → 可对任意第三方邮箱轰炸(SMTP 成本 + 拉黑 noreply@relayium.com),并可 Sybil 刷号(`user+1@gmail`…同一收件箱无限号,`normEmail` 只小写去空格)。

**改动:**
1. **register 每 IP 限速 5/分钟**:复用 `signal.RateLimiter`,按 `ipx.IP(r)` 键,超限 429。主修邮件轰炸。
2. **注册查重用"规范化邮箱"**:新增 `canonicalEmail(email)` —— 去掉 `+tag`(所有域)、gmail/googlemail 去掉本地部分的点。注册时若已存在**规范化形式相同**的账号,按"邮箱已被占用"拒绝(与现有 anti-enum 一致:不泄露具体存在性,走既有的中性响应路径)。**不改 `normEmail`**(现有登录/身份/存储不变,老用户 +tag 账号不被误合并)。需要一个按规范化形式查已有账号的存储方法。

**取舍:** 规范化只影响**新注册查重**,不影响登录。gmail 去点为 gmail 特有规则,其它域仅去 `+tag`。

**测试:** ① 同 IP register 第 6 次/分钟 → 429;② `a+x@gmail.com` 在 `a@gmail.com` 已存在时被拒;③ `a.b@gmail.com` 与 `ab@gmail.com` 视为同一;④ 非 gmail 域的点不合并;⑤ 现有登录路径不受 canonical 影响(用原 email)。

### H3 — account 限流改用可信 IP 提取 【High】

**问题:** `account.clientIP()`(`throttle.go:97-113`)无条件信任 `X-Forwarded-For` 最左值,与 signal 包**谨慎的 `IPExtractor`**(`roomkey.go`,仅在直连 peer 可信时才读 XFF、右到左取真实客户端)不一致。若反代配置为追加 XFF,则 admin 锁定/密码爆破/邮件限流全部可被伪造头绕过。

**改动:** 让 account 的限流 IP 来源改用共享的 `signal.IPExtractor`。做法:`account.Service` 增加一个 `clientIP func(*http.Request) string` 字段(默认保留现有行为以不破坏单测,`main.go` 用 `ipx.IP` 注入),所有限流键(`pwLogins`/`magicRequests`/`verifyRequests`/`resetRequests`/`adminLogins`)改用它。`-trusted-proxies` 已在 `main.go` 解析并构造 `ipx`,直接复用。

**取舍:** 不把 `IPExtractor` 挪包(避免大改),用依赖注入共享同一实例。

**测试:** ① 注入一个可信 loopback 直连 + 伪造 XFF → 取 XFF 真实客户端;② 不可信直连 peer 的 XFF 被忽略、用直连地址;③ 默认(未注入)行为对现有单测不变。

### H4 — 信令连接/房间不被耗尽 【High】

**问题:** `/ws` 无每-IP 并发连接上限;LAN 房间 `maxPeers=0`(无限);`Hub.rooms` 无房间数上限。可低认证耗内存/goroutine。

**改动:**
1. **每 IP 并发 WS 连接上限 = 20**:`main.go` 的 `/ws` handler 用按 IP 计数的信号量,进入时 `+1`、退出时 `-1`,超限拒绝升级(429)。
2. **LAN 房间每房 peer 上限 = 50**:LAN 分支的 `maxPeers` 从 0 改为 50(code 房间维持既有 `RoomFor` 语义)。
3. **全局房间数上限 = 5000**:`Hub.JoinLimited` 在创建**新房间**时若 `len(h.rooms) >= 5000` 则拒绝。

**明确不做:** 不给已配对连接加寿命上限——大文件跨网络传输可能 >15 分钟,砍寿命会误伤;"持久免费中转"已被 C2 累计字节上限杀死。

**测试:** ① 同 IP 第 21 条并发 `/ws` 被拒、断开后可再连;② LAN 房间第 51 人被拒;③ 房间数达上限时新房间被拒、已有房间仍可加入。阈值定为常量并注释可调。

### M1 — 上传并发上限 【Medium】

**问题:** 上传无并发限制;500 路并行各写满 `MaxFileSize` 才被配额拒 → 瞬时几十 GB 磁盘压力。

**改动:** 每账号在途上传信号量,默认 **5 并发**;第 6 个并发上传返回 429(`Retry-After`)。信号量按 `userID` 键,在 `files.go` 上传处理开头 acquire、结束 release。

**测试:** 单测:同账号 6 路并发,第 6 路 429;释放后可再传;不同账号互不影响。

### M2 — 计量摄入健壮化(尽量完整) 【Medium】

**问题:** coturn→app 走 Redis pub/sub(即发即弃),app/Redis 重启或重连退避窗口内的 `total_traffic` 事件静默丢失且不报错;`UserRelayedSince` 只会少计不报错,现有 fail-open 告警不覆盖这种"最常见的致盲方式(例行重启)"。

**改动(目标:重启不坏账 + 可观测 + 尽量补齐):**
1. **幂等 + 累计式摄入**:按 `allocationID` 记录"已见最大累计 `total`",而非叠加增量。重复/乱序/漏中间事件都不坏账,只要拿到某更高累计值即修正。(先对着 `metering.go` 现有 rcvb/sentb 解析 + coturn 版本核实 coturn 是否周期性上报累计值——若是,现有叠加逻辑本身有重复计数风险,一并修正。)
2. **重连缺口可观测**:暴露"最后一次收到计量事件的时间/计数"指标;计量已启用却超过阈值(如 5 分钟)无事件则打警告日志。
3. **对账 pass**:定期(如每数分钟)读取 coturn 现存 allocation 状态并补齐 app 侧累计,尽量覆盖 pub/sub 漏发。
4. **残余**:app 在某 allocation 整个生命周期内都宕、且该 allocation 于此期间关闭 → pub/sub 无法追回;对账 pass 尽量覆盖,覆盖不到者在文档写明。

**实现期核实项:** coturn `--redis-statsdb` 的确切上报格式与频率(单次 close vs 周期累计)、以及能否读取现存 allocation 列表用于对账(以本机 coturn 版本为准)。

**测试:** ① 幂等:同一 allocation 重复/乱序事件不重复计数、取最大累计;② 缺口告警:注入"长时间无事件"→ 触发警告;③ 对账 pass 逻辑单测(用可注入的 coturn 状态源)。

### M3 — 小对象撑爆(改用最小计费 + 全局软上限) 【Medium】

**问题:** 字节配额只管总字节不管条数;无限个近零字节对象 → `stored_files`/`upload_events` 行 + inode 爆炸,拖慢配额查询与 GC、耗尽 inode;叠加 Sybil。

**改动(取代原拟的硬 1000/天条数上限):**
1. **最小计费尺寸 = 64 KiB**:每个存储上传按 `max(实际字节, 64<<10)` 计入 `DailyQuota`。这样现有 200 MiB/天配额顺带把条数封在 ~3200/天/账号,无论对象多小。正常小文件几乎无感。
2. **全局磁盘/inode 软上限**:blob 卷用量(字节或 inode)超过配置的高水位线时,新上传返回 503。这是审计指出当前**完全缺失**的全局兜底(人均配额 × 无限账号仍无界)。阈值可配(env/flag),默认取一个保守值;检测用 `syscall.Statfs`。

**取舍:** 砍掉硬条数上限(两头不讨好)。最小计费复用已有字节配额、单机制、正常行为无感。

**测试:** ① 上传 1 字节对象后,该账号已用配额 +64 KiB;② 连续小对象很快耗尽日配额(证明条数被间接封顶);③ 全局用量超阈值 → 新上传 503,低于阈值放行;④ 正常尺寸文件计费不变(≥64 KiB 时按实际)。

### M4 — roster 广播去抖 【Medium】

**问题:** 每次 Join/Leave 触发全房 `TypePeers` 广播,O(N);快速进退制造抖动扰民(尤其同 NAT 出口的真实用户)。

**改动:** 每房间 roster 广播合并:一次变更后至多每 **200ms** 广播一次(尾随合并),`Hub` 内按房间维护一个待广播标记 + 定时器。配合 H4 的连接限速。

**测试:** ① 200ms 内多次 Join/Leave 只产生一次(或有限次)roster 广播;② 广播内容仍为最终正确 roster;③ 单次变更仍及时广播。

## 各项交付物汇总

| 项 | 改动 | 主要文件 | 类型 |
|---|---|---|---|
| C2 | 信令读限+累计字节封顶+消息限速 | `signal/client.go` | Go |
| H1 | /api/ice 5/min 限速 | `main.go`(+account 入口) | Go |
| H2 | register 5/min 限速 + canonicalEmail 查重 | `account/handlers.go`,`sqlite.go`,`main.go` | Go |
| H3 | account 限流改用 IPExtractor 注入 | `account/service.go`,`throttle.go`,`main.go` | Go |
| H4 | 每IP连接上限+房间/peer 上限 | `main.go`,`signal/hub.go` | Go |
| M1 | 每账号上传并发信号量 | `account/files.go` | Go |
| M2 | 幂等累计摄入+可观测+对账 | `metering/`,`account/` | Go |
| M3 | 最小计费64KiB+全局磁盘软上限 | `account/files.go`,`storage/`,`main.go` | Go |
| M4 | roster 广播去抖 | `signal/hub.go` | Go |

## 决策记录

- C2 累计上限 **1 MiB/连接**;不加连接寿命上限(C2 已封 bulk 中转,寿命上限会误伤大文件传输)。
- H1 `/api/ice` **5/min/IP**;H2 register **5/min/IP** + 邮箱规范化查重(现在做,不动 normEmail)。
- H3 用依赖注入共享 `signal.IPExtractor`,不挪包。
- H4 每 IP **20** 连接、LAN 每房 **50**、全局 **5000** 房。
- M1 每账号 **5** 并发上传。
- M2 尽量完整:幂等累计 + 可观测 + 对账;残余不可追回场景文档写明。
- M3 **最小计费 64 KiB**(≈3200/天/账号)+ 全局磁盘软上限,取代硬条数上限。
- M4 roster 广播 **200ms** 尾随合并。

## 实现期需核实项(open questions)

1. coturn `--redis-statsdb` 上报格式/频率与可否读现存 allocation 用于对账(M2)。
2. 全局磁盘软上限的阈值与检测方式(`Statfs` 字节 vs inode),默认值(M3)。
3. 各阈值(1 MiB、5/min、20/50/5000、5 并发、64 KiB、200ms)均定为带注释常量/flag,上线后按实际可调。

## C1(不在本轮,单独说明)

C1 = 计量在"推荐部署路径"下默认未接线(`coturn-setup.sh` 无 `--redis-statsdb`、docker-compose 注释掉、`main.go` 缺告警),导致 relay 月配额可能整体失效且无信号。本轮不改,已约定单独向用户解释后立项。M2 假设计量已接线(由 C1 保证)时提升其健壮性。
