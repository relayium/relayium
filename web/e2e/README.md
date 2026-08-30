# 端到端测试

四个脚本，共用三份东西：

- `harness.mjs` —— CDP 客户端、标签页把手、浏览器生命周期、另存为桩、`vite preview`
  生命周期。
- `go-server.mjs` —— 一台真 Go 服务器的完整生命周期：先拒绝一个不成立的端口，再拒绝
  缺失/陈旧的 dist、拒绝接管别人占着的端口，然后构建、剥掉继承来的全部 `RELAYIUM_*`
  配置、按墙钟等就绪、有界地终止并收掉临时目录。`mixed-link.mjs` 和 `device-inbox.mjs`
  用它。
- `dom-contracts.mjs` —— 真浏览器运行器和普通 Vitest 单测**共用**的选择器。

共用而不是各抄一份：两份迟早会漂移，而漂移的那一份会安静地变成一个测不出东西的假绿。
`dom-contracts.mjs` 就是被这件事逼出来的——`QueuedBatches` 换成组合 `PendingFiles`
之后，`mixed-link.mjs` 手里那份 `.fname` 和裸 `li` 计数当场过时，而因为当时没有任何
托管道次跑它，几周之后才有人手工跑出来，报的还是一个 `undefined.includes` 的
TypeError。现在同一份选择器由每次推送都跑的 `QueuedBatches.test.ts` 对着真渲染的组件
钉着，DOM 一漂移，先红的是便宜的那条道次。

现在这个模块里有三组（2026-08-29 / Phase 3D C3b-1 加了后两组）：

| 常量 | 覆盖的界面 | 每次推送钉着它的用例 |
|---|---|---|
| `QUEUED` | 传输中再选文件排出来的队列卡 | `src/lib/QueuedBatches.test.ts` |
| `RECEIVE` | 收文件的同意卡（含 `ReceiveActions` 那一行两颗按钮） | `src/lib/ReceiveActions.test.ts` |
| `XFER` | 传输卡，以及它进行中才渲染的 `role="progressbar"` | `src/lib/workspace-orchestration.test.ts` |

`RECEIVE` 里有一条必须读的注意事项：大批次内存提示一起来，主按钮和幽灵按钮的**含义
互换**——`.btn-primary` 变成"拒绝"，唯一能往下走的是一个明确的"仍要接收"幽灵按钮。

所以那两颗按钮的常量按**呈现角色**命名（`RECEIVE.primary` / `RECEIVE.ghost`），不按
语义命名。早先它们叫 `accept` / `decline`，而那正是一个共享标识符**不能**做的事：在提示
分支里 `RECEIVE.accept` 就是拒绝键，于是这个名字会在每个读者的编辑器里、恰好在他判断
"这一下点得安不安全"的那一刻，写着与事实相反的话。`primary` / `ghost` 只说分支之外仍然
为真的那部分——哪颗是哪颗——把"它到底干什么"逼回到调用点去确定。

`mixed-link.mjs` 因此在它两次同意点击之前都先查 `RECEIVE.warning` 在不在，查到就当场
报错而不是改点另一颗；两个分支的真实语义都由 `ReceiveActions.test.ts` 对着真渲染的标记
双向钉住。

`XFER.progressBar` 的**不存在**同样是有意义的，而且两个方向的含义相反：它只在
`{#if !xf.done}` 里渲染，所以"卡片在、进度条不在"是 runner 证明批次进了终局的方式，
"卡片在、进度条也在"是 runner 证明传输真的在进行中的方式——后者是活场景无障碍扫描唯一
能断言到东西的时刻。

四套都跑**默认产物**（`npm run build`）。它们的区别不是构建，是**对端和房间**：

- `lan-transfer.mjs` —— 老对端在场时那条一次一模式的老路，`npm run test:e2e`。
  每个标签页都套了测试侧的降级过滤器（见下）。**⚠️ 截至 2026-08-29 这一套跑不到底**，
  原因和迁移方向见下面那一节；在迁移完成之前，它的尾巴一条信号都不产出。
- `page-shell.mjs` —— auth 落地页、`/apps`、`/pricing` 和不安全上下文单列兜底这四条
  **页面**契约（不是传输契约），`npm run test:e2e:page-shell`，**在 CI 里跑**。
  2026-08-29（Phase 3D C2）从 `lan-transfer.mjs` 搬出来单独成套，见下面专门一节。
- `mixed-link.mjs` —— 两个新版本浏览器在 LAN 房间里的统一链路（`link/1`），
  `npm run test:e2e:mixed`，**在 CI 里跑**（`.github/workflows/web.yml` 的
  `mixed-link-e2e` 作业，2026-08-29 / Phase 3D C3a 新加）。它**自己起服务器**：
  从 `./server` 构建一个真的，起在自己的端口、自己的临时库上，跑完全收掉。
  它仍然和 `test:e2e` 分开的作业跑，因为它要 Go 工具链和自己的端口。
  现在是**四幕**，各自拥有自己的标签页和自己那份冻结 act 台账：二十幕的统一链路旅程、
  多页设备身份（一个浏览器的两页 + 第三台设备）、有界的中继池失败（两页，外加一份
  只答 `/api/ice` 的池形状应答），以及"不支持的对端"（两页，其中一页的名册 hello 在
  线上被掐掉）。为什么分幕而不是加 act，见下面 C3b-7 / C3b-8 / C3b-9 三节。
- `code-room.mjs` —— 同一条统一链路，但在**配对码房间**里，
  `npm run test:e2e:code-room`，**在 CI 里跑**（`.github/workflows/web.yml` 的 test
  作业，紧跟 `npm run build` 和 a11y 扫描）。它不需要 Go 服务器：会合与 ICE 由一份
  受控夹具提供（见下）。

## CI 里真正跑的浏览器道次

`.github/workflows/web.yml` 一共起七条真浏览器道次，`test:e2e` **不在其中**：

| 道次 | 脚本 | 作业 |
|---|---|---|
| 已构建产物的无障碍扫描 | `test:a11y` | `test` |
| 页面外壳契约（auth 落地页、`/apps`、`/pricing`、不安全上下文布局） | `test:e2e:page-shell` | `test` |
| 配对码房间里的统一工作区 | `test:e2e:code-room` | `test` |
| 设备发现可发现性走查 | `test:device-discovery` | `test` |
| Device Inbox 入口走查 | `test:device-inbox-entry` | `test` |
| Device Inbox：浏览器 → 服务器 → CLI → 落盘 | `test:device-inbox` | `device-inbox-e2e` |
| LAN 房间里的统一 `link/1` 工作区（真 Go 服务器） | `test:e2e:mixed` | `mixed-link-e2e` |

最后一行是 2026-08-29（Phase 3D C3a）新加的，**已经并入 `main`**（`a703c56f`
"Test unified mixed-link path in hosted CI"）。**只剩 `lan-transfer.mjs` 还只在本地跑**
（而且跑不到底，见下）。

`test` 作业自己带**五**条浏览器道次（a11y 扫描、页面外壳、配对码房间、设备发现、
Device Inbox 入口），所以 `mixed-link` 才单开一个作业——它另外还要 Go 工具链。
`web.yml` 里 `mixed-link-e2e` 旁边的注释现在也写明 `test` 作业是这**五**条浏览器道次。

把 `mixed-link` 托管起来，先要修掉它托管不了的原因：它以前要求人先手工起一台服务器。
现在它自己起（`go-server.mjs`，和 `test:device-inbox` 共用的那套生命周期），所以它
不再依赖"有人记得起服务器"。

## 这套 harness 覆盖不到的两件事

写在最前面，因为"没有断言"和"断言过了"看起来太像：

- **只有 Chromium。** harness 说的是 CDP，起的是本机那个 Chrome/Chromium。
  Firefox 和 WebKit/Safari 在这里**一次都没跑过**，任何报告都不该说跑过。跨引擎会
  分叉的地方（`bufferedAmount` 的行为、DataChannel 的背压、移动端后台策略）只能靠
  真机手测，或者靠 vitest 里那些与引擎无关的状态机/协议用例——后者是有意保留的那一层。
- **没有真的配对码房间。** `/api/pair` 铸码要一个登录且验证过的账号，服务器的 ws
  路由又用 `pairReg.Validate` 卡住未铸出的码，所以这套 harness 进不去一个**真**的
  配对码房间。`code-room.mjs` 用一份受控夹具补上了它缺的那两样服务器职责（会合 +
  ICE 下发），页面本身仍然是原样的构建产物、跑原样的策略——但它证明的是**路由与
  界面**，不是服务器的准入。准入那一半仍然只有服务器端的 Go 用例覆盖。
- **没有 TURN，所以没有中继凭据到期。** 上面那份夹具下发的是**空**的 iceServers
  （否则 `chooseRtcConfig` 会强制 relay-only，而这台机器上没有 TURN 服务器，一个候选
  都收集不到）。中继链路的凭据有效期边界——提前告警、到点进入可信的终局态、绝不拿
  过期凭据去恢复——因此在浏览器里一次都没跑到，它钉在确定性用例上：
  `relay-deadline.test.ts` 和 `mixed-link-lifecycle.test.ts`。这不是懒：真浏览器没有
  办法按需让一份 TURN 凭据在中途过期，而"信令掉了但 DataChannel 还活着"同样只能用
  注入的时钟和手动触发的终局回调来构造。

## `lan-transfer.mjs` — 两个真标签页之间的一次真传输（降级路径）

`npm run test:e2e`

跑之前要有两件东西：

```bash
# 1) 构建产物（服务器直接吐 web/dist，测的就是它——别拿旧 dist 测出一个假绿）
cd web && npm run build

# 2) 本地服务器（同时兜 SPA、/ws 信令和 /api/ice）
cd server && RELAYIUM_ADDR=:8099 go run .
```

然后 `cd web && npm run test:e2e`（换端口用 `node e2e/lan-transfer.mjs --url http://localhost:1234`；
调试时加 `--keep` 保留 Chrome 的临时 profile）。

### ⚠️ 现状：这一套跑不到底（2026-08-29）

先说结论，因为下面那份"它测的是什么"读起来像是这些断言每天都在跑，而它们**一条都
没在跑**。

`d175f863`（"Remove legacy Mac and Web transfer paths"，2026-08-27）把 `App.svelte`
里对端卡片上的老控件删了：包着隐藏 `.file-pick-input` 的 `.pa-files` 标签，以及它旁边
那条文件 / 文件夹 / 消息的三选一。现在一张对端卡片上只有**一个**控件
`.open-workspace`，而且只发给能路由 `link/1` 的对端；路由不了的对端拿到的是
`<p class="pa-unsupported">`——一句话，不是一个灰掉的按钮。

这个脚本的前提正好相反。`main()` 在开出第一个标签页之前调 `setDefaultInit(STRIP_LINK_CAP)`，
于是**每一个**标签页都以只通告 `text/1` 的老对端身份出现，然后各幕去驱动这种对端过去
才有的那条分叉。分叉没了，那些选择器指向的节点也就不再渲染。

于是今天这一套的实际情况是：

- **跑到了、而且过了——现在这个文件里一幕都没有了**。以前跑得过的那三幕
  （`authLandingScenario`、`appsHierarchyScenario`、`pricingHierarchyScenario`）连同
  `unsupportedLayoutScenario`（当前单列布局契约；它从来不依赖任何被删的东西，只是因为
  排序原因才轮不到它跑）一起，在 2026-08-29（Phase 3D C2）整体搬进了
  `web/e2e/page-shell.mjs`，细节见下面专门一节。
- **没有跑**：现在是**全部**，从 `mobileRelayFallbackScenario` 起——它现在是 `main()`
  的第一幕。它去驱动已删控件（`lan-transfer.mjs:1420` 取 `.file-pick-input`，现在拿到
  `null`），运行到这里就过不去了。主传输那一幕，以及它后面的 small-message-cap、
  transfer-boundary、early-failure、mobile-no-picker、desktop-picker-cancel、resume、
  四幕消息、multi-page-device、caps-suppressed，全都在这个点的下游，眼下一条信号都不
  产出。

所以下面第 1–5 条**描述的是这个脚本的设计意图，不是当前的覆盖**。它们全部位于尾巴里，
现在一条都没有执行。搬出去的那四幕不再是"设计意图"——它们是 `page-shell.mjs` 里
每次推送都在跑的真实覆盖。

### 真正丢掉的东西，比尾巴的长度小得多

这个脚本一度被称作实时管道"唯一的回归网"。那句话曾经成立，现在不成立了；继续那么说
会高估损失，也会把修复引向错误的方向。对着 `mixed-link.mjs` 和 `code-room.mjs` 做过一次
覆盖审计，结论是**大量重复**：握手到落盘、强制换 PeerConnection 后的逐字节续传、
一条链路一个 SAS、逐文件 SHA-256 完整性、同意状态机、活场景无障碍扫描、断开收尾——
这些那两套都在跑，跑在替代了老分叉的统一 `link/1` 界面上，而且 `code-room.mjs` 每次
推送都在托管 CI 里跑。

审计当初认定搁浅的有**八条**。八条全部改了状态，所以现在是**零条搁浅、六条已托管
迁移、两条已退役**：

| # | 独有断言 | 状态 |
|---|---|---|
| 1 | 移动端一个 picker 都不开（手机上产品主动不开） | **已托管迁移**（C3b-6，exact-main `122cb2fd`） |
| 2 | 桌面端另存为对话框被取消 | **已托管迁移**（C3b-4，exact-main `daadc94a`） |
| 3 | SCTP 协商出来的单条消息上限边界（RFC 8841 默认值 64 KiB） | **已托管迁移**（C3b-5，exact-main `b08457d6`） |
| 4 | 应答竞态（发起方还在接管通道时，应答方已经接受） | **已退役**，见下 |
| 5 | 数据通道打开前 PeerConnection 就 `failed` | **已退役**，见下 |
| 6 | 传输进行中 `role="progressbar"` 的活场景无障碍 | **已托管迁移**（C3b-1，exact-main `129e4cd`） |
| 7 | 多页设备身份与焦点（一个浏览器的两页 + 第三台独立设备） | **已托管迁移**（C3b-7，exact-main `c7b83dc4`） |
| 8 | 有界的中继池失败（池里发了凭据然后被丢掉） | **已托管迁移**（C3b-8，exact-main `74ac85db`） |

"零条搁浅"说的是这张迁移清单，不是 `lan-transfer.mjs`——那个文件还在，也还是跑不起来。
删它是下面的阶段四；它当初等的那件事——C3b-9 迁过来的那条"渲染出来的不支持对端"形状
——现在已经托管：`mixed-link-e2e` 在托管 PR 道次 **33290134608** 上把四幕清单跑绿，
那份源码合入后就是 exact main **`9d815c84`**；合入后的那份字节本身也跑绿了一次，在
exact-main Web 道次 **33290357209** 的 `mixed-link-e2e` job **99200800583** 上，该 job
结论为 `success`。同一个提交上的 Web workflow 整体仍是红的——红的是另一个 `test` job
里的 page-shell 触摸目标断言（见下面阶段四）——这里没有任何一句声称 exact-main Web
道次整体是绿的。

**第 1 条的措辞在这里被更正，而这条更正很重要——退役 runner 比审计那句话强。** 审计
当年写的是"没有 `showSaveFilePicker`"，读起来像"一个没有这套 API 的浏览器"。
`lan-transfer.mjs` 的 `mobileNoPickerScenario` 布置的**不是**那个条件：在 exact-main 上，
它的 `WORKING_PICKERS`（第 317-329 行）装的是**能用**的 `showSaveFilePicker` 和**能用**的
`showDirectoryPicker`，两者返回的句柄 `createWritable()` 真的收字节、真的计数；它还伪造了
安卓 UA，然后断言 picker 调用数为零、经由句柄的字节数为零、并且文件只靠浏览器下载逐字节
到手。那本来就已经是产品**主动**的那条规则——`pickersAllowed()` 在手机上**即使两个 picker
都在、都能用**也拒绝走 File System Access 分支，而且同意卡在用户点下去之前就先把"会落到
下载目录"说出来。C3b-6 **是把这份证明搬过来**，不是替掉一条更弱的断言；这里任何一句都不
应被读成"老那一幕证明得更少"。

C3b-6 改变的是**这份证明落在哪里、以及仪表打得多紧**。它从那个没接进托管 CI、已经数周
没有执行过的本地 runner，迁到当前统一的托管 `link/1` 旅程上，于是这条规则被证明在产品真正
发布的那条管道上，而不是在被它替代的老 LAN 分叉上。在搬过来的核心之上，它新增：两条
picker 分支分开计数，而不是共用一个计数器——于是"走了目录 picker"的 run 不能冒充"保存
picker 从没打开过"；一次显式的运行时可用性探针，先各花一次再清零，而不是把"picker 能用"
留成桩的一条没人查的性质；`ReceiveActions.test.ts` 里一条按维护语言对真实渲染标记的文案
契约，垫在 runner 那条与语言无关的模式匹配后面；四个被替换的浏览器边界与 UA 按**同一性**
在一个不会抛的 `finally` 里还原；以及按文件名限定的终局卡片，让这次新的成功不能满足后面
某一幕的完成等待。审计那句措辞描述的"没有 API"的情形，以及 `filesink` 层同一条手机闸门，
仍然由 `src/lib/filesink.test.ts` 确定性覆盖；只有真浏览器才能补上的，是"活的管道端到端
确实遵守它"。它到底证明了什么、又没证明什么，见下。

**第 3 条写的是 SCTP，这不是抠字眼。** 这个产品里有两个互不相干的 64 KiB，点错名字就会
把修复引到错误的模块去。这一条是**传输层**的限制：按 RFC 8841 协商出来的
`a=max-message-size`，从 `RTCPeerConnection.sctp.maxMessageSize` 读，对端什么都不通告时
默认就是 65 536——所以一个 Android WebView 对端能把桌面发送方整个拽下来，文件流也因此
必须分片（`src/lib/wire-limit.ts` 的 `CONSERVATIVE_MAX_MESSAGE_BYTES`）。它**不是**
`TEXT_MAX_BYTES`，那是产品自己给单条消息定的 64 KiB 上限（`src/lib/text-wire.ts`），
存在的意义是"再大就算文件"，而不是把用户当成一整块的东西悄悄切开。两者在边界上连数值都
对不上：64 KiB 明文封出来是 65 557 字节的帧，塞不进一条协商成 65 536 的通道。
`lan-transfer.mjs` 的 `smallMessageCapScenario` 独有的是传输那一半——它改写 SDP，在真
Chromium 上强制协商出 64 KiB，然后证明旧的 192 KiB 分块帧会被拒、装得下的那个会被收。
分片本身的算术已经有确定性用例（`src/lib/transfer-fragmentation.test.ts`）；C3b-5 已把原先
搁浅的协商搬进现有真 Chromium mixed 旅程，并已在 exact-main `b08457d6` 托管通过，细节见下。

**第 4 条是退役，不是迁移，证据如下（精确到用例名）。** `messageDefaultRaceScenario`
把那次线上故障强制复现：A 的 `getStats()` 路径采样被挂住时，B 自动接受并立刻发出第一条
消息，两个帧都落在"通道已开、A 的 lane 还没挂上处理器"的窗口里。这个窗口现在在结构上
已经关掉了——传输层会把挂上之前到达的帧捕获下来，挂上之后再按序回放——而且这件事由每次
推送都在 `npm test` 里跑的确定性用例钉着：

- `src/lib/mixed-session.test.ts` —— "replays a text request captured before lane
  attachment"（REQUEST 在 `attach` 之前到达，回放后状态是 `incomingRequest`）、
  "fails quickly instead of replaying into a declined lane capture sink"、
  "re-attaches both lanes to a replaced transport before replaying its capture"
  （换传输时两条 lane 都先接管，才回放第一个被捕获的帧）。
- `src/lib/peer-link.test.ts` —— "holds an inbound offer and replays the frames
  that chased it, in order"，以及那条断言 `{ file: [1, 2], text: [9] }` 按序落到替换
  通道上、且同一帧不会被回放两次进 codec 的用例。

**顺序**就是这条规矩的全部内容，而上面这些用例直接断言顺序。

**第 5 条同样按可执行证据退役，不算迁移。** 老浏览器场景强制在已删除的接收构造入口里
同步触发 `onconnectionstatechange("failed")`；它独有的回归是尚未初始化的 callback 被读取
而抛 TDZ `ReferenceError`，不是某种浏览器专属 ICE 行为。统一实现现在有两层每次
`npm test` 都跑的确定性证据：`src/lib/peer-link.test.ts` 在 transport promise 返回前同步
触发终局 callback，证明 manager 干净失败且没有 current link；`src/lib/webrtc.test.ts` 则让
初始 `connectLink` 在两条 DataChannel 都未打开时进入 `failed`，直接证明具名拒绝、调用方收到
状态、PeerConnection 关闭，而且迟到的 open 事件不能把已经拒绝的建立过程翻成成功。旧接收
构造器和控件都已不存在，再搬它那个人工浏览器 hook 不会增加当前路径事实。

理由的另一半在于那一幕的**手法**，而这一半才是"退役"而非"缓办"的依据。它不是去等那次
竞态，是**造**出来的：把 `RTCPeerConnection.prototype.getStats` 换成一个由用例手动放行的
promise。这招当年管用，是因为路径采样正好卡在"通道已开"和"lane 已挂上"之间。现在不是了。
`src/lib/mixed-session.svelte.ts` 的 `onLinkChange` 里，发布链路（`publishedLink = link`）、
两条 lane 都挂上（`file.attach(link)`、`text.attach(link)`，紧跟着一句"任一通道没有
`onmessage` 就抛"）、把捕获到的帧全部回放——这些**全是同步的**——之后才调用
`observePath(link)`，而它只是把 `conn.path()` 采样发出去就返回，并不等它。`conn.path()`
就是 `pc.getStats().then(classifyPath)`（`src/lib/webrtc-core.ts`），所以现在挂住
`getStats`，挂住的是一个早已被它本该领先的那次挂载超过去的诊断调用。注入点还在，它背后
那个窗口没了。

把话说准：统一工作区**是可以**为这条写一幕的。`link/1` 没有任何东西挡着，也**不**需要
把删掉的对端卡片消息控件加回来。没了的是那根**杠杆**——再没有一个能按需撑开这个间隙的
钩子，于是迁过来的那一幕只能去赌计时，而当年那次 `getStats` 挂起正是为了不赌计时才写的。
加上上面那些每次推送都跑、且直接断言这条性质的确定性用例，所以这是退役，不是丢失。

剩下这六条才是真实的回归暴露面，也正是下面的迁移必须搬过去的东西。尾巴里的其余部分可以
**退役而不是移植**——已经有托管套件在断言它们了。

### 迁移方向（分阶段）

修法**不是**把删掉的控件加回来，也不是加一个只有测试能打开的降级开关去重新渲染它们。
那条分叉是被有意从产品里拿掉的；一条只有测试走得到的回头路，断言的是任何用户都到不了的
行为，比什么都不断言更糟。

分四阶段，顺序是刻意的：任何一刻的覆盖都不低于今天。每一阶段落地并绿了，才开始下一阶段。

**阶段一：新起一套托管的页面外壳套件——已完成，2026-08-29（Phase 3D C2）。** 以前
能过的那三幕考的是页面契约，不是传输契约，本来就不该长在一套传输套件里。它们连同
`unsupportedLayoutScenario`（当前单列布局契约，同样不依赖任何被删控件，只是排序上轮
不到）一起搬进了 `web/e2e/page-shell.mjs`：一套只对 `vite preview`、不接真 Go 服务器
的新套件，`/api/plans` 由 a11y 扫描已经在用的那份进程内夹具同源应答。已加进
`.github/workflows/web.yml`（`test:e2e:page-shell`）。`page-shell-contract.test.mjs`
守着这个 runner 本身不会悄悄漏掉一幕：钉的是一个写死的 `EXPECTED_SCENARIO_COUNT`
（不是拿数组自己会跟着缩水的 `.length` 去比），并且钉住新 CI 步骤没有 `if:` 或
`continue-on-error`。光这一步就把 `/apps` 层级契约从"只在本地"变成托管——这是它第一次
由"有人记得跑"以外的东西来保证。

这条道次目前在 exact main `9d815c84` 上是**红的**（托管 Web 道次 33290357209 的
`test` job），红在一个亚像素触摸目标比较上，不是任何产品几何；修法已写，待托管 CI。
详见下面 `page-shell.mjs` 一节里的"44px 触摸地板"。

**阶段二：传输类独有断言并入 `mixed-link.mjs`，并把 `mixed-link` 托管起来。**
上表第 1–6 条考的是真管道（commit-reveal、分块 AES-GCM、ACK 流控、checkpoint 续传、
同意），不是那条退休的分叉。它们从 `STRIP_LINK_CAP` 上摘下来，改走统一 `link/1` 工作区：
`.open-workspace`，然后是工作区自带的草稿框和 `.attach-file` / `.attach-folder`。
`mixed-link.mjs` 驱动的就是这套界面。把独有断言搬进一套没人跑的套件是挪问题，不是解决
问题，所以"把 `mixed-link` 托管起来"先做，而且**已经并入 `main`**（C3a，2026-08-29，
`a703c56f`）：`mixed-link-e2e` 作业每次推送和 PR 都跑它现有的那一幕。把剩下的搬过去
是 C3b，它的起点因此是一条绿的、托管着的基线，而不是一套自己的排队断言已经陈旧了好几周
的套件。

**C3b-1 —— 活进度条，只做文件那条通道。** C3b 的第一刀只搬**第 6 条，别的一条都不动**。
它在每个值得记录的意义上都是一条"只涉及文件"的条目：

- *搬了什么*：活的 `role="progressbar"` 断言，进到 `mixed-link.mjs` 现有那一幕 5 MiB
  续传里，成为新的 `live-progressbar` act。它跑在唯一存在"传输进行中"这个状态的窗口里
  ——接收方已经落了两个 durable chunk 之后、强制掐断两条 PeerConnection **之前**。
  先证明主体确实在（每个方向一条进度条、`role="progressbar"`、`aria-labelledby` 指到卡片
  自己那个标题 id `xfer-label-{send,recv}`、`0 ≤ aria-valuenow ≤ 100`、卡片还没进终局），
  然后才用 `scanLiveState` 以 `XFER.card` 为 context 扫。一个 context 什么都没匹配到的
  `axe.run` 报的是零违规——所以少了这一步存在性证明，这一 act 会永远打印"axe clean"。
- *这个窗口是怎么撑开的，以及它什么时候合上*：接收侧桩 sink 每写一个 192 KiB 分块要
  睡一觉，而这个睡眠现在有**两个**值，因为这一幕里有两件预算差一个数量级的活。
  `SCAN_WRITE_DELAY_MS`（1000ms）只服务上面这一 act：等到两个分块之后还剩约 25 次写，
  按旧的 20ms 只给出约 500ms——够那一次强制掐断（一个 CDP 往返），远不够在两个标签页上
  注入并跑完 axe，传输会先跑完，这一 act 就会以"卡片已进终局"失败，而不是给出一个无障碍
  结论。**扫完立刻**换回 `RESUME_WRITE_DELAY_MS`（20ms，也就是这一 act 出现之前这一幕
  一直在跑的那个值），换回的位置刻意排在读 PeerConnection 计数和强制掐断**之前**：剩下
  约 25 次写按 1000ms 睡就是纯粹的墙钟时间，谁也没有因此更安全。第一版把 1000ms 一路留到
  底，把这一幕从约 10 秒拖成了约 31 秒——一次绿跑里完全看不出来的回归，所以换回的**顺序**
  由 `go-server.test.mjs` 钉着，不是靠一行注释。换回那一步还顺手断言传输此刻确实还活着：
  要是哪天两次 axe 真的跑到把文件跑完，下面每一条等待都会以别的名义超时，而这一幕会悄悄
  退化成一次没被打断的普通传输。
- *C3b-1 当时没搬什么*：第 1、2、3、5 条都没被那一刀改动，但这四条后来都改了状态——
  第 5 条按上面的确定性证据退役，第 2 条在 C3b-4、第 3 条在 C3b-5、第 1 条在 C3b-6 搬走；
  第 7 条随后在 C3b-7、第 8 条在 C3b-8 搬走，所以**已经不剩搁浅的了**。逐字节续传和
  "真的换了 PeerConnection"那两组断言原样保留——这一 act 是**插进**那一幕的，不是替掉它
  的任何一部分。
- *这次改动碰了哪些文件*：只有测试和文档——`web/e2e/mixed-link.mjs`、
  `web/e2e/dom-contracts.mjs`、`web/e2e/go-server.test.mjs`、
  `web/src/lib/ReceiveActions.test.ts`、`web/src/lib/workspace-orchestration.test.ts`、
  本文件和 `docs/TESTING.md`。产品源码、workflow、依赖、原生和 ops 一个都没动。
- *顺手加的反空转机制*：一幕不等于一条断言。`mixed-link.mjs` 当时加了一份**冻结的逐 act
  执行台账**——C3b-1 是十七个具名 act，C3b-4 加入第十八个，C3b-5 加入第十九个，C3b-6
  加入第二十个；成员、顺序和一个**字面量**计数（`EXPECTED_ACT_COUNT`，
  绝不是 `ACTS.length`）三样都查——外加一个字面量 `EXPECTED_SCENARIO_COUNT`。否则一个被
  改到只剩第一条断言的 run 照样会报 `1/1`。`e2e/go-server.test.mjs` 钉住这个形状，也钉住
  那次活扫描确实落在"接受"和"强制掐断"之间。C3b-7 加的是**第二幕**、C3b-8 加的是
  **第三幕**、C3b-9 加的是**第四幕**，都不是往 `ACTS` 里再塞 act，所以现在是四份冻结
  清单、四个字面量计数——`ACTS`/`EXPECTED_ACT_COUNT`（20）、
  `MULTIPAGE_ACTS`/`EXPECTED_MULTIPAGE_ACT_COUNT`（5）、
  `RELAY_ACTS`/`EXPECTED_RELAY_ACT_COUNT`（4）与
  `UNSUPPORTED_ACTS`/`EXPECTED_UNSUPPORTED_ACT_COUNT`（5），`EXPECTED_SCENARIO_COUNT`
  为 4。四份刻意不合并：一份三十四条的平表会把"某一幕根本没起来"和"少了一个 act"报成
  同一种失败，而这两者要修的地方不一样。
- *共享选择器*：同意卡和传输卡现在和 `QUEUED` 一样，只在 `e2e/dom-contracts.mjs` 里写一遍
  （`RECEIVE`、`XFER`），由 `ReceiveActions.test.ts` 对着真渲染出来的标记、
  `workspace-orchestration.test.ts` 对着 `App.svelte` 真实的分支结构各钉一遍——这两条每次
  推送都跑，浏览器道次不是。`RECEIVE` 还记下了那张卡片唯一的坑：大批次内存提示一起来，
  两颗按钮的含义**互换**，`.btn-primary` 变成"拒绝"——所以它们按呈现角色叫
  `primary` / `ghost`，不叫 `accept` / `decline`，runner 也在它两次同意点击之前都先查
  这个提示在不在。

**验证状态：本地已跑绿，并已在 exact-main `129e4cd` 托管跑绿。** 2026-08-30 由作者在本地 macOS
worktree 上记录，服务器是这套用例自起的 Go 服务器（`127.0.0.1:8124`），浏览器是无头
Chrome：

| 命令 | 结果 |
|---|---|
| `npm run check` | 548 个文件，**0 错误 0 警告**，0 个有问题的文件 |
| `npx vitest run`（全量） | **4370 通过**，3 跳过，0 失败（233 个文件） |
| `npx vitest run`（这一刀碰的四个文件） | **176 通过**——`e2e/go-server.test.mjs` 79 条，`ReceiveActions` / `workspace-orchestration` / `QueuedBatches` 合计 97 条 |
| `npm run build` | 成功；写出 12 个按路由的 SPA 外壳 |
| `npm run test:e2e:mixed` | **17/17 act 按序执行**，连跑五次——12.05s、11.24s、12.41s、13.01s、12.69s（换回节流之前是约 31s） |

之前记为"没跑过"的那次对抗性变异现在跑过了，而且跑的正是要紧的那一个：把 `XFER.bar`
指向一个不存在的类名——也就是"进度条在传输中不再渲染"的形状——真浏览器那一跑**在这一
act 上**红，报的是

> no in-flight progress bar in the send card on tab A: the transfer is already
> terminal, or the bar left its `{#if !xf.done}` branch. Either way this act has
> no live subject left to scan.

而不是一句空洞的"axe clean"。另外三个便宜的源码变异也照样跑了，每一个都被一条指着自己
原因的消息抓住：删掉那次节流换回（"nothing restores the throttle after the scan"）、
把 `RECEIVE.primary` 改回 `accept`（`go-server.test.mjs` 与 `ReceiveActions.test.ts`
一共红四条）、把 `web.yml` 的道次数改回"四"（"the mixed-link job's stated reason names
the wrong lane count"）。

有一个数值值得留下来，因为它正是"换回节流"而不是"调低 `SCAN_WRITE_DELAY_MS`"的依据：
五次跑到换回那一刻，接收方写下的字节数都恰好是 **393,216 / 5,242,953**，也就是它起步时
那两个 durable chunk 一个没多。两次 axe 都塞进了**第一次** 1000ms 睡眠里，所以留给强制
掐断的跑道仍是完整的约 25 次写 × 20ms ≈ 500ms——正是这一幕原本就验过的预算。

之后 exact-main `129e4cd` 的 `mixed-link-e2e` 已通过，所以第 6 条现在是已托管迁移，不再只是
本地跑绿。

**C3b-2 没有迁移另一条 `lan-transfer.mjs` 独有断言。** U1 钉的是仅发起方、只发一次、
同一 PeerConnection 上的 ICE restart；U3a 钉的是 stored receive 共用的空保存参数。二者是
相邻的确定性韧性补强；它们当时没有改变第 2、3 条。第 2 条后来由 C3b-4 搬走，第 3 条由
C3b-5 搬走。

**C3b-4 —— 桌面 picker 取消，复用现有托管旅程。** 第 2 条现在插进原有 5 MiB 传输，
没有另起第二套浏览器场景，也没有再发一份大文件。接收侧先包一层已有保存桩，让第一次调用
抛真正的、名字为 `AbortError` 的 `DOMException`；runner 随即证明：只有一个带非空
`role="status"` 文案的 retry hint，没有写入字节、没有打开 sink、没有新增终局失败，短暂等待
后 picker 仍只调用一次，request 标题和清单没换，link、SAS、composer、附件控件也都还活着。
只有第二次明确 click 才能把 picker 计数推进到二并开始 durable writes；后面原封不动的
progressbar / resume 尾巴继续证明最终名称、大小、逐字节内容和替换 PeerConnection。

`.savehint.retry` 只写在 `e2e/dom-contracts.mjs`，普通 Vitest 用渲染出来的
`ReceiveActions` 钉住它；`e2e/go-server.test.mjs` 则独立冻结第十八个 act、它必须在
progress/resume 之前、真实 AbortError 注入、第一次/第二次 picker 计数、非终局同一 consent
证据和后续精确字节证据。产品源码和节流常量都没改。

这次被分类的取消会刻意打一条 console error。runner 在第一次 click 前同时记下两页 error
数组长度，证明 retry 状态后只消费接收页窗口内**恰好一条**完整匹配固定产品前缀、
`SaveCancelledError` 和 `showSaveFilePicker` 来源的记录。重复、异名、异来源、出现在发送页，
或同一句落在窗口之外，都继续留给未放宽的最终 console sweep 判红；没有全局忽略 picker
错误的正则。

之后 exact-main `daadc94a` 的 `mixed-link-e2e` 已通过，所以第 2 条现在是已托管覆盖，不再是
本地迁移待 CI。

旧脚本的 `NotAllowedError` 第二幕没有搬进 Chromium。它本来就是旧 runner 人工抛的异常，
并不证明真实浏览器权限弹窗；对应产品规则已有直接确定性证据：`src/lib/filesink.test.ts`
区分 `AbortError` 与非取消失败，`src/lib/mixed-file-session.test.ts` 证明非取消的保存失败会拒绝
传输、不会冒充用户取消。这半按上述精确测试退役；本次迁移不声称覆盖真实浏览器权限拒绝。

**C3b-5 —— 对端不通告 SCTP 上限时的 RFC 8841 边界，复用同一条 mixed 旅程。** 两个现有
标签页都在 `setRemoteDescription` 入口删除非零 `a=max-message-size` 行，让真 Chromium 自己
得出默认值，而不是给应用塞一个 mock 数。旅程先在接收页跑一个很小的真 DataChannel probe：
证明删掉了一条真实的非零通告，`pc.sctp.maxMessageSize` 精确等于 65,536，65,536 字节发送后通道
仍开着，而 65,537 字节不能保持为一次成功且仍开的发送。随后明确核对并清空 probe 的两个
PeerConnection 和删除计数，再打开产品链路，避免 probe 冒充产品或 replacement 证据。

产品旅程接着独立证明两页最初各自唯一的产品 PC 都是 65,536；原有 5 MiB 精确字节、强制
断线、续传和 replacement 尾巴全部在这个上限下照跑。结束时两页都读取**未过滤**的全部
tracked PC 上限数组，数组长度必须等于 PC 数，而且每一项都必须是 65,536；null/关闭状态
不能被藏掉。这里完全不碰 `TEXT_MAX_BYTES`——它是明文产品上限，不是 SCTP 传输上限。旧
runner 的 262,144→65,536 动态分片算术仍由 `transfer-fragmentation.test.ts` 直接覆盖；本次
浏览器迁移证明的是缺省协商和受限 replacement 旅程，没有增加第二套 runtime。

**当前状态：本地跑绿，且已在 exact-main `b08457d6` 托管通过。** 作者本地记录为：focused
四文件 Vitest 194/194、`svelte-check` / TypeScript 0 错误 0 警告、production build 成功、真
Chromium 自起服务旅程 19/19 act 按序通过。之后 exact-main `b08457d6` 的 `mixed-link-e2e`
已通过，所以第 3 条现在是已托管覆盖，不再是本地迁移待 CI。

**C3b-6 —— 手机上一个 picker 都不开，复用同一条 mixed 旅程。** 第 1 条现在作为台账里的
第二十个 act 落在同一条 `link/1` 上，位置在"正文逐字节一致"和桌面 picker 那一幕之间——按
执行顺序是第十三幕，后面还有七幕。针对一个
96 KiB 确定性文件，接收页先用 `Emulation.setUserAgentOverride` 换上安卓 UA 和 platform，
然后一次替掉四个浏览器边界：`showSaveFilePicker`、`showDirectoryPicker`、
`URL.createObjectURL` 和 `HTMLAnchorElement.prototype.click`。

**为它装上的两个 picker 是真能用的，这就是整个反空转论证。** 它们返回的句柄，
`createWritable()` 真的收字节、真的计数；而且这一幕在依赖"它们没被调用"之前，**先在运行时
证明**它们能用——各调一次、恰好吞下 8 字节——再把计数清零，让这次证明不可能被误算成产品
开了 picker。"picker 调用数为零"这句话，架在一个会抛异常的桩上说的是桩；架在一个本来会
成功并把文件吃掉的桩上，才是"产品**事先**决定不开"的唯一证据。两条 picker 分支分开计数，
因为产品本来就有两条（扁平单文件 vs. 其余），合成一个计数器会让"走了目录 picker"的 run
冒充"保存 picker 从没打开过"。这一条源码契约替不了：没人调用的函数，函数体是观察不到的。

UA 必须**赶在批次发出之前**落地，因为 `ReceiveActions` 只在同意卡挂载那一刻解析一次保存
提示。点"接受"之前，runner 用共享的 `.savehint` 选择器读卡片，要求恰好一条提示、不是 retry
那一版、没有内存提示，而且文案**双向**成立：必须承诺下载目录，且必须不是桌面分支那句
"选择保存位置"——按本次 run 启动时所处的那个维护语言判断，所以"只靠缺失来断言"的提示不会
在空文本上蒙混过关。点击之后，两个 picker 计数和句柄自己的字节计数必须仍然精确为零；必须
恰好捕获到一次下载，名字、声明长度和字节模式逐项精确；它那张按文件名唯一限定的传输卡必须
成功、卡内没有在途进度条、状态里没有任何"取消"字样；同一条 link、SAS、草稿框、附件控件和
空的请求队列都必须还在。载荷公式只写一遍，同时插进发送页和校验页——写两份会让"逐字节精确"
退化成"这个文件和它自己一致"。字节是从捕获到的 `Blob` 上读的，不是 fetch `blob:`：生产
CSP 的 `connect-src` 不允许 `blob:`，fetch 会红在桩上而不是红在产品上。

**因为这一幕在前面多了一次成功传输，续传那一幕的终局等待必须改。** 它原来等的是页面上
任意一个 `.xfer.ok`；现在手机那次下载会立刻满足它，于是一次根本没续上的续传会径直穿过去，
后面每一条断言描述的都是另一次传输。两处现在都按"单文件计数器正好写着这个文件名"的卡片
限定；而一张不再渲染那个计数器的卡片会**抛错**，不是被过滤掉——否则改名字会把每一条按名
限定的检查悄悄降级成 `length === 0`，也就是一条只会超时、还栽赃给产品的等待。

还原按**同一性**，不是按形状：紧随其后的桌面取消那一幕会捕获 `window.showSaveFilePicker`
并透传调用它，所以"装着一个 picker"不是要保的性质。`finally` 会还原四个函数以及原来的 UA
和 platform，把临时全局连同它钉住的 `Blob` 和 object URL 一起丢掉，并且**刻意不会抛**。
一个会抛的 `finally` 会**顶掉**把它送到这里的那个异常：如果失败发生在装桩之前，跑出来的报错
会是"全局不存在"，真正的诊断一个字都不会打印；而且第一个故障还会跳过后面的 UA 还原，把一台
手机交给桌面的那几幕。所以两半各自 catch、两半永远都跑，清理故障只在块**之后**重新抛出——
那时它只可能是全部真相。后面那一幕原封不动地证明自己的两次 picker 调用仍然发生，这就是
"还原是真的"的下游证据。

**要说准这到底是什么。** 这是桌面 Chromium 套了一个伪造的安卓 UA，加上浏览器边界桩。它
**不是**真安卓设备、不是真系统 picker、也不是真安卓下载管理器；runner 和
`go-server.test.mjs` 都不许把它说成那样——有一条契约会在它们开始那么说时判红。产品规则背后
那两桩真实故障（自带浏览器的 picker 弹不出可用界面；Chrome 文件夹页上一次误触返回键取消
整次接收）在这里**没有**被复现。被证明的是产品自己在统一管道上的主动策略：
`pickersAllowed()` 事先拒掉这条分支、卡片提前说明、文件仍然只靠浏览器下载逐字节到手。
产品源码、workflow、依赖包和节流常量一个都没动；这次改动只有
`web/e2e/mixed-link.mjs`、`web/e2e/go-server.test.mjs`、
`web/src/lib/ReceiveActions.test.ts`、本文件和 `docs/TESTING.md`。

浏览器查不了的那一半交给普通 Vitest 道次。浏览器那一幕匹配的是"承诺下载目录"的模式而不是
字面字符串，因为它跑在本次 run 启动时的那个维护语言里；而这个配对只有在两句话确实不同、
且"下载"那句确实说了下载目录时才有意义。`ReceiveActions.test.ts` 就对着真渲染出来的标记
钉住这一点，**英文和简体中文各一遍**，每次推送都跑——而且是**从一开始就挂在**对应语言下
渲染的：`lang()` 在渲染时读一次，挂完再切语言证明不了 `zh` 用户看到的是什么。

**当前状态：本地跑绿，且已在 exact-main `122cb2fd` 托管通过。** 合入本刀的那个
exact-main `122cb2fd` 上，`mixed-link-e2e` 道次已经跑过并通过，所以第 1 条现在是已托管
覆盖，不再是本地迁移待 CI。下面这份是作者在合入之前的**本地**记录，原样保留：它记的是
当时手工跑了什么，不是托管结论。所有行都记录于 2026-08-30，跑的是**当时那棵树**——评审更正已落、下面那轮变异也已
还原之后——在本地 macOS worktree 上，浏览器是 headless Chrome，分支
`test/mixed-link-mobile-download`，基线 `origin/main` `b08457d6`。这三次跑**不是**由套件
自起服务器：隔离的 Go 测试服务器是从这同一个 worktree 里用
`RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=127.0.0.1:8124` 单独起好的，runner 只是显式指
向那台已经在跑的实例。承载这些 act 的 runner
按内容钉死：`web/e2e/mixed-link.mjs` SHA-256
`b2b78bb2b7f2e44fc0d1669e6036b3a93b5a1e0cb5481334254960fba358cedc`。

| 命令 | 结果 |
|---|---|
| 对 `e2e/mixed-link.mjs` 与 `e2e/go-server.test.mjs` 跑 `node --check` | 两个都干净通过 |
| focused `npx vitest run e2e/go-server.test.mjs src/lib/ReceiveActions.test.ts` | **121 passed** |
| `npm run check` | **0 错误 0 警告** |
| `npx vitest run`（Web 全量） | **4394 passed**、3 skipped |
| `npm run build` | 成功；447 个生成页面，12 份 per-route SPA 外壳 |
| `node e2e/mixed-link.mjs --url http://127.0.0.1:8124`（对着上面单独起的那台服务器） | **20/20 act 按序执行**，连跑三次——13.27s、11.90s、12.59s 墙钟 |

**对抗性变异测试已经做过，而且先做的就是运行时那道闸门。** 把
`web/src/lib/filesink.ts` 的 `pickersAllowed()` 改成无条件走 File System Access 分支，用
这份变异重新构建，再跑一次旅程：它在 **2.284s** 内判红——落在第一个决定性的保存边界上，
早于更慢的终局与逐字节检查——并打出具名诊断 `saveCalls=1 dirCalls=0 handleBytes=0
downloads=0`。这正是"先判计数器"的全部意义：手机闸门一旦被抬掉，报出来的是**哪条 picker
分支开了、它的句柄吃了多少字节**，而不是一次等在永远不会来的下载上的 60 秒超时。随后
`filesink.ts` 被还原成变异前的原样——SHA-256
`624e6b344a5627bd3a43c4707aed94e2fdcc4ada7214aa913265e1b589bd8e90`——并用还原后的源码重新
构建；所以本刀的改动仍然只有上面那五个测试与文档文件，运行时源码一个字节都没留下。

另有六种变异只改测试文件，且**一次只改一种**、下一种之前先还原：让 picker 桩抛错而不是
真能用；破坏 `Blob` 捕获内容；把续传那一幕的终局等待改回原来泛化的 `.xfer.ok`；删掉
`finally` 清理；把手机那一项从 `ACTS` 台账里删掉；以及删掉那次 `act()` 调用。每一种都被
它对应的那条契约判红，之后逐一还原。有两件事这轮变异**不能**代表：它不是关于托管道次的
结论，也不会让上面那条"伪造安卓 UA"的限制变成真机结果。

**C3b-7 —— 一个浏览器的两页就是一台设备，作为同一个 runner 上的第二幕。** 第 7 条是第一条
没法复用现有旅程那两个标签页的迁移，所以也是第一条以**第二幕**、而不是"再加几个 act"的形式
落地的。它需要三页、各自的安装身份是刻意挑的——两页共用一个 LAN 种子，第三页自己一个——
而且需要高级验证**关掉**：这一幕要测的是请求落在哪一页，而一道同意闸门会把每一条"到达"
断言变成"有人点了接受"的断言。这两点都和那条二十幕旅程不相容（它自己占着两个标签页，而且
在启动前就把验证打开了）。所以现有旅程一个字没动：这一刀是在它旁边**加**一幕，二十个 act
连顺序一并保留。

它整幕都跑在当前的 `link/1` 界面上。这个缺陷当年是在一个**已经不存在**的对端卡片消息控件上
发现的，而整条搁浅尾巴的迁移规矩就是：不要把证明写在用户根本够不到的界面上——所以请求是用
产品那唯一的 `.open-workspace` 打开的，"到达"是由工作区自己渲染出来的草稿框证明的。
`.peer-actions button` 之类退役选择器一旦在这里回潮，`go-server.test.mjs` 就判红。

五个 act，冻结顺序：

1. *`multipage-one-device`* —— 独立播种的第三台设备只看见那个两页浏览器**一次**，而两页
   谁也不把自己的兄弟页列成目标。两条都是**精确**名册比较，不是成员判断：一页要是把兄弟页
   和对面设备**并排**列出来，`includes` 照样过，而那正是这个缺陷的另一半。
2. *`multipage-focus-handover`* —— 焦点在**两个**方向上都决定代表页（先切 A2，再切回
   A1），于是"谁后加入谁代表"那种实现过不了。它还额外要求这次交接**没有人离开**：离开台账
   在交接前后各读一次，必须都是空的。一个靠"旧页掉线、新页重连"来换代表的实现，能满足上面
   每一条名册断言，却会在用户每次切标签页时把活链路打断——而 `current-page.ts` 把这条不变量
   直接写死了（"失去焦点不会发 inactive 帧"），所以这里钉的是一条真的产品规矩。
3. *`multipage-request-follows-focus`* —— 从第三台设备打开的工作区必须落到**当前那一页**和
   发起方，同时那张在请求发出**之前**就装在后台页上的闩必须精确为零。是闩，不是事后一读：
   一张出现过又消失的卡片，和一张一直挂着的卡片是同一个缺陷，而事后单读恰好漏掉前者。这张
   闩还额外数一个后台页**确实有**的控件，并要求它**非零**——其余每个计数器都被断言为零，而零
   同样是"闩根本没装上"或"选择器已经失配"的结果。
4. *`multipage-fallback-on-close`* —— 代表页是真被关掉的（`Target.closeTarget`），第三台
   设备必须观察到**恰好**这一页的物理离开，名册必须回落到活着的兄弟页、且仍然只有一条。
   只用 `includes` 的话，"连幸存页也被报成离开了"照样能过，而这正是"设备回落了"和"设备消失了
   、换了个东西上来"被混为一谈的方式。离开台账被限定在本幕自己那三个 page id 上——这不是把
   claim 放松，而是让它成立：前一幕会在本幕开三个标签页之前刚好关掉它自己的两个，一条迟到的
   `left` 帧否则就会落进台账里。
5. *`multipage-sibling-reachable`* —— 名册回落了，不等于设备还能用。关闭留下的那个工作区
   要用产品自己的控件答掉，B 必须**重新拿回恰好一个可用动作**，然后再用它开**第二个**
   工作区，必须够到幸存页并打开发起方自己的草稿框。

   这一切之前会先把幸存页切成当前页（`activateTab`），而这一步不是装饰——见下面那条产品
   缺陷，那正是这一幕最后证明的东西。

   `returnToChooser` 答的是 header 当下提供的那**一个**控件。`WorkspaceHeader.svelte` 每个
   状态只渲染一个：终局链路给 `.wh-restart`，仍读作活着的给 `.wh-disconnect`——包括
   `mixed-session.svelte.ts` 在还有 lane 想要回传输时保持的 `interrupted` 挂起态；关页之后
   落在哪一面是这一幕不该去钉的竞态，所以两个都列出来，哪个在屏幕上就答哪个。它只答一次，
   并受几条 `go-server.test.mjs` 逐条钉住的界限约束：整个恢复**只有一个** deadline，由它的
   两次等待共用，而不是每次一个字面量；**没有任何 sleep**——"睡一下让它稳定"在一个 chooser
   永远不回来的构建上照样能过；拒绝靠"什么都不做"来成功——答不动的 header、既没有 header
   也没有 chooser 的页面，都是显式报错；每条拒绝都**报出屏幕上是什么**，包括那个点名了真正
   缺陷的 `.pa-unsupported` 计数。

**这一幕找出来的产品缺陷，以及修法。** 第 5 幕在**两次**真实验收里都失败，而第一次诊断是
错的。它把失败归给一个异步的 `.wh-disconnect` → `.wh-restart` header 迁移，并把
`returnToChooser` 扩成一个不停答控件的有界循环；第二次跑照样失败。第三次跑带了一个临时
诊断——现已移除，那棵树已精确还原到 `ef8d6f`——才定案：A1 关掉、B 答完 Disconnect 之后，
B 的原始名册**恰好**是 `[A2]`，工作区 header **不存在**，open-workspace 计数为**零**，另有
一张 `.pa-unsupported` 卡说 A2 太老。全程没有任何 header 迁移参与。

原因是**单边的能力剪枝**。`retainPeers` 会在某个对端离开名册时丢掉它的通告，而一个浏览器的
两页在名册里是**一条**——所以 A1 代表这台安装期间，B 把 A2 的 `link/1` hello 剪掉了。A2
自己的名册全程没变过，于是 `CapsAnnouncer` 仍然认为 B 已被问候，它的名册路径永远不会再发。
两边都不在等任何东西；幸存页就这样在整个标签页生命周期里不可达。任何开着两个 Relayium
标签页的用户，一旦关掉当代表的那个，都会撞上它。

修法在**产品**里，而且只有一条行为：在每一次真正的 `watchCurrentPage` 转换上，页面照旧发
`sendActivate`，并且**额外**把自己的能力 hello 向名册里每一个非自身对端重发一次
（`CapsAnnouncer.refreshPresent`）。选这个时机，是因为它恰好就是"这一页开始成为对端被指向
的那一页"的那次转换。

它刻意**不欠任何东西**：不动 greeted、不建也不清 pending、不装定时器、不花掉一个真正的新
对端仍然被欠的有界重试次数；也永远不从接收路径调用，所以"用 hello 回 hello"依然在结构上
不可能。准入一个字没改：`peerSupportsLink` 仍然是 `linkRoomActive()` 之后的 `link/1` 精确
匹配，没通告过的对端仍然是 unsupported，老的/不通告的对端行为完全照旧。
`caps-vectors.test.ts` 钉住 announcer 那一侧（含"剪枝后再刷新"的端到端序列），
`go-server.test.mjs` 钉住 `App.svelte` 里的接线。

**这一幕不能代表什么。** 它是一个 headless Chromium 的三页加逐页种子覆盖，不是三台真设备，
而且"一个 profile 的两页算一台安装"完全是靠那个种子覆盖成立的。它断言的是服务器的分组、
代表页选举和回落，从第三页观察到的样子；它没有跑真实的网络分区、真实的移动端后台页，也没有
跑恢复窗口的时序。原始的 `welcome`/`peers`/`left` 帧确实被读了——这是刻意的，因为一个浏览器的
两页设备名一模一样，DOM 真的分不出它们——但它们只用来给页命名、以及知道服务器什么时候稳定
下来。每一条关于请求**到达**的断言都是对着渲染出来的产品 UI 做的；一旦有人用信令帧读数替掉
它，就有一条契约判红。

*这次改动碰了哪些文件*：**产品源码也在内**——本节更早的版本曾错误地写成"只有测试和文档"。
共七个文件：`web/src/App.svelte` 与 `web/src/lib/peer-caps.svelte.ts`（修复）、
`web/src/lib/caps-vectors.test.ts`、`web/e2e/go-server.test.mjs`、`web/e2e/mixed-link.mjs`
（覆盖），以及本文件和 `docs/TESTING.md`。workflow、依赖、原生和 ops 一个都没动。

**当前状态：本地跑绿，且已在 exact-main
`c7b83dc413b44713771c54495ef8c7e95d28a209` 托管通过。** 源码经 PR #93 合入，合入门
run `33285623243` 所有选中道次（含 `mixed-link-e2e`）通过，exact-main Web run
`33285787562` 五个 job 全过，其中就包括那条 25 个 act 的 mixed-link runner。所以第 7 条
现在是**已托管覆盖**，不再是本地迁移待 CI。下面这份是作者在合入之前的**本地**记录，
原样保留：它记的是当时手工跑了什么，不是托管结论。

修复之前那三次跑连同它们找出来的缺陷已记在上面，这里只留其中两条事实。第 1 跑跑到
**20/20** mixed link acts 加多页幕第 **1 到 4** 幕才在第 5 幕超时，所以第 5 幕以上的部分
早就被证明过了，而这次改动没有动那段幕体。以及：第 1、2 跑之间塞进 `returnToChooser` 的
那个臆测性 `.wh-disconnect` → `.wh-restart` 答控件循环，连同它那套"四条界限"的说明文字和
对应源契约，在第 3 跑证伪该诊断之后被**删掉**了，不是"留着以防万一"。

之后 Codex 对最终还原出来的那七个文件独立验了一遍：

| 命令 | 结果 |
|---|---|
| 对 `e2e/mixed-link.mjs` 与 `e2e/go-server.test.mjs` 跑 `node --check` | **通过**——两个都干净解析。值得手工跑：没有任何一道门会解析 `e2e/mixed-link.mjs`（`tsconfig.node.json` 只 include `scripts/**/*.mjs`，而 `go-server.test.mjs` 是把它当**文本**读的；`go-server.test.mjs` 本身会被 Vitest import，所以是被解析过的）。 |
| focused `npx vitest run src/lib/caps-vectors.test.ts e2e/go-server.test.mjs` | **通过**——**150/150**，含 7 条新的 `refreshPresent` 向量和 6 条新的 `App.svelte` / `peer-caps` 接线契约 |
| `node e2e/mixed-link.mjs`（自起服务器） | **通过**——**先 20/20 mixed link acts，再 5/5 multi-page device identity acts**，对着最终源码连跑三次：15.1s、14.4s、13.8s |
| `npx vitest run`（Web 全量） | **通过**——233 个文件、4428 条测试，另有 2 文件 / 3 测试 skipped（记录于同一棵树，在下面那轮变异之前） |
| `npm run check` | **通过**——548 文件，0 error，0 warning（同一棵树） |
| `npm run build` | **通过**（同一棵树） |

这些契约都对着故意变异验过，确认不是空过。更早的一轮做了四种：从 `App.svelte` 的当前页
回调里删掉 `refreshPresent`；让 `refreshPresent` 去标记 greeted（会同时让源契约和那条
"先 refresh 再 greet 的对端仍然拿得到有界重试"的单元用例判红）；在 `returnToChooser` 里
重新塞回 `for (;;)` 答控件循环；以及把它某次等待的共享预算换成字面量 `30_000`。

之后 Codex 对最终源码又独立做了一轮，而且其中一种一路做进了真浏览器，没有停在契约层：

- 从 `App.svelte` 删掉 `refreshPresent` 调用，**三条** focused 源契约判红；用这份变异重新
  构建之后，真实旅程在**第 5 幕**失败，报的是 `head=false chooser=0 unsupported=1`——正是
  这次修复所关掉的那条剪枝缺陷的签名，靠"把修复拿掉"复现出来的，不是靠论证。还原
  `App.svelte` 得到精确 SHA `a5ca3fd1`。
- 把 `refreshPresent` 换成一个清掉 `greeted` 并置上 `rosterChanged` 的实现，**三条**单元与
  源契约判红。还原 `peer-caps.svelte.ts` 得到精确 SHA `4d53ceeb`。
- 删掉 `multipage-sibling-reachable` 那个 act，**两条**台账契约判红。还原 `mixed-link.mjs`
  得到精确 SHA `43ea22da`。

每处变异都被还原成变异前的原样，所以这一刀的改动仍然只有上面点名的那七个文件。那一轮
发生在合入之前；关掉第 7 条的托管证据是上面"当前状态"里那两次 PR 与 exact-main run。

**C3b-8 —— 测不出来的中继池照样要用，而它连不成的那条连接照样要有个了结。** 第 8 条是
最后一行，和第 7 条一样以**独立一幕**落地，不是往旅程里再加 act：它需要在**启动前**就
给两个标签页装上 `/api/ice` 应答，而那条二十幕旅程的全部意义是一条**连得上**的链路，
一个标签页不可能两者都是。现有的二十个和五个 act 一个字没动，这一刀只是在旁边加第三幕。

它对的是这样一桩真实故障：跨网传输一直显示"正在建立加密连接"、进度 0%，约 30 秒后报
连接失败，而服务端日志干干净净。原因不在超时。App 只有在 `measureRelay` 选出赢家时才用
中继池；探测超时——手机上是常态，射频从空闲唤醒加上 TURN 长期凭据的两轮 Allocate 就能
吃掉预算——它就退回去读**遗留的顶层 `iceServers`** 找中继。而"只用我自己的节点"的用户、
以及任何节点池部署，顶层根本没有 TURN：于是策略退回 `all`，刚刚发下来的池凭据被丢在
地上，两端只剩穿不过 CGNAT 的 host/srflx 候选。

搭台就是这一幕本身，所以把它说准。两页启动时都装上一个**只**应答 `/api/ice` 的 `fetch`，
body 是池形状：顶层只有 STUN，唯一的中继在 `relays` 里，它那条 TURN URL 指向
`192.0.2.1`——RFC 5737 的 TEST-NET-1，保留给文档、没有人通告，所以 Allocate 是真的永远
不会完成。用域名不行：一个解析不出来的名字在有些解析器上毫秒级失败、在另一些上会挂住，
两种都不是"一台起着但够不到的中继"。发下去的凭据**刻意不是** TURN REST 的
`<unix-expiry>:<token>` 形状，因为 `relayDeadline` 会从那个形状里读出到期时间并据此
装一个客户端终局界限——REST 形状的用户名会让这条链路结束在**凭据时钟**上，而这一幕却
报告说它证明了**不可能的传输**有界结束。

四个 act，冻结顺序：

1. *`relay-pool-only-ice`* —— 两页确实请求并跑在那份应答上（一页要是压根没 fetch 过，
   它会跑在空 ICE 列表上，然后"没有选中中继"因为一个和缺陷毫无关系的理由成立），应答
   里仍然**没有顶层中继**，而且 A 页拿到恰好一个可用的 `.open-workspace`。runner 会
   拒绝在带顶层 TURN 的应答上开跑，而不是指望自己那个常量永远保持 `stun:`：加一条上去，
   即使产品把池丢了链路照样中继，也就是"坏着却过"。
2. *`relay-probe-spent-its-budget`* —— 探测是真跑了、也真跑完了。等的是一个可观察的产品
   事实，不是睡过去：`measureRelay` 在 `finally` 里关掉它那条连接，所以"这一页建过的每
   一条连接都已关闭"是页面自己说的"测量结束了"，而同样长度的一次 sleep 在一个压根没探测
   的构建上照样能过。每一份捕获到的配置还要被验成**这个池的探测**——relay-only、就是那
   一台中继、就是那副凭据——而不是只数个数。随后捕获被清空，并且**把清空读回来**，因为
   下面每一条都建立在"点下去那一刻数组是空的"之上。
3. *`relay-only-link-attempt`* —— 用产品自己的控件打开工作区，它建出来的那条连接必须
   保住那台黑洞中继、**连同发下来的那副精确凭据**，并且 `iceTransportPolicy: "relay"`。
   这三条里任何一条单独成立时产品都可能仍然是坏的：一条中继都没有就是那桩故障本身；
   有 URL 却把凭据丢了，等于 allocate 不了任何东西；中继在但策略是 `all`，会先花 ~20 秒
   在根本不可能成的候选上再退回来。这一幕还要求顶层那条 **STUN** 出现在这份配置里，
   于是不用第二个观察者就同时钉死两件事——`chooseRtcConfig` 的"没选中"回落是把顶层列表
   和池**合并**出来的，所以 STUN 这个记号只会出现在产品配置里、不会出现在任何一次探测
   配置里；而一台**被选中**的中继用的是它自己那份列表，里面没有 STUN。"这份捕获属于本次
   尝试而不是探测"和"黑洞中继从来没被选中"，就是这样一起被定下来的。
4. *`relay-bounded-named-failure`* —— 这条链路建不起来，而它**不许**做的是永远停在
   "正在连接"，或者悄悄卸掉、把设备选择器还回来、故障哪儿都不报。先证明工作区 header
   是**活的**并读下它当时那句话，因为"从来没出现过的工作区"和"失败了的工作区"渲染出来
   的 `.wh-disconnect` 都是零。终局读回按产品语言写：header 还在、恰好一个 `.wh-restart`
   且没有 `.wh-disconnect`、不再声称任何路径，而且那句话相对连接中那句**确实变了**——
   最后这条才是与语言无关的部分，因为"它说了点什么"在一个还在说"正在连接"的 header 上
   同样成立。

点下去之后的一切共用**一个** deadline，`RELAY_FAILURE_BUDGET_MS`，而且这个预算刻意比
产品自己最坏情况下的终局界限更大（`webrtc.ts` 的 `SETUP_DEADLINE_MS` 是 90 秒，链路请求
和鉴权各 30 秒）。runner 的界限必须是外面那个，否则一次判红分不出"产品从来没终结过"
——那正是缺陷本身——和"runner 先没耐心了"。用掉的时间会打进 act 那一行，所以 119 秒才过
和 35 秒就过，看得出来不是一回事。

**这一幕不能代表什么。** 它是桌面 Chromium 打一个保留地址，不是手机，也不是真的跨网路径
或真 NAT。老那一幕伪造了安卓 UA，这里**刻意没有**沿用：UA 对被测代码没有任何影响
（`chooseRtcConfig` 根本不读它），留着只会把一个桌面结果打扮成移动结果。现场让探测超时的
那种移动端压力，在这里由"一台根本不会应答的中继"代替——对同一个判断来说是同一种输入。
这一幕也**没有**控制台报错扫描，同样是刻意的：它让 Chromium 去 allocate 一个没人应答的
地址，断言"安静"是在断言浏览器的日志，不是断言产品。

*这次改动碰了哪些文件*：四个，全是测试与文档——`web/e2e/mixed-link.mjs`、
`web/e2e/go-server.test.mjs`、本文件和 `docs/TESTING.md`。产品源码、workflow、依赖包、
原生和 ops 一个都没动，`lan-transfer.mjs` 也刻意留着。

**当前状态：已在 exact-main `74ac85db83a636f747581cc35b580749d7cf0344` 托管通过。**
源码经 PR #94 合入，合入门 run `33287525259` 所有 24 条选中道次通过（另有六条按设计
skip），其中包含 `mixed-link-e2e`；exact-main Web run `33287720721` 五个 job 全过，
复现了同样的 29 个有序 act 和同样 30.9 秒的终局结果。所以第 8 条现在是**已托管覆盖**，
不再是本地迁移待 CI。下面这份是作者在合入之前的**本地**记录，原样保留：它记的是当时
手工跑了什么，不是托管结论。

| 命令 | 结果 |
|---|---|
| 对 `e2e/mixed-link.mjs` 与 `e2e/go-server.test.mjs` 跑 `node --check` | **通过**——两个都解析干净。值得手动跑：没有任何门会去解析 `e2e/mixed-link.mjs`（`go-server.test.mjs` 是把它当**文本**读的）。 |
| 定向 `npx vitest run e2e/go-server.test.mjs` | **通过**——**136/136**，含这一幕新增的契约 |
| `node e2e/mixed-link.mjs`（自己起服务器） | **通过**——**20/20 mixed link acts，接着 5/5 多页设备身份 acts，再接着 4/4 有界中继失败 acts**。探测被捕获**一次**，黑洞链路在 **30.9 秒**走到那张有名字的 `Connection failed` 终局卡——是产品自己收的界，离 runner 那 120 秒的 `RELAY_FAILURE_BUDGET_MS` 还远，不是卡在预算上。 |
| `npx vitest run`（Web 全量） | **通过**——233 个文件、4441 条测试，另有 2 文件 / 3 测试 skipped |
| `npm run check` | **通过**——0 error，0 warning |
| `npm run build` | **通过**——447 个生成页面，12 份 per-route SPA 外壳 |

随后对契约做了故意变异，一次一处、每处还原后再做下一处，以证明它们不是白过的：

- 从"链路尝试"那一 act 里删掉顶层 **STUN 记号**判断：判红 **1** 条——正是这条把产品那份
  合并出来的回落配置，同探测配置、以及一台**被选中**的中继区分开。
- 把 `POOL_STUN` 从 `stun:` 改成 `turn:`：判红 **1** 条——那样池应答就长出了遗留的顶层
  中继，而这恰恰是"产品把池丢了链路照样中继"的形状。
- 把共用的 `left()` 预算之一换成字面量 `120000`：判红 **1** 条。共用一个 deadline 才是
  那个主张；每个 wait 各带一个字面量，正是"有界"悄悄变成 3 × 120 秒的方式。
- 删掉那个"探测连接已关闭"的可观察等待：判红 **1** 条。等一个产品事实而不是睡过去，
  才让"探测真跑了、也真跑完了"这句话有意义。
- 删掉最后一个 act `relay-bounded-named-failure`：判红 **2** 条。

每处变异都已还原，还原后的文件哈希回到被审阅的那份源码——`e2e/mixed-link.mjs` 的
SHA-256 前缀 `7da4db13`、`e2e/go-server.test.mjs` 的 `97cd90f7`——所以这一刀的改动仍然
只有上面点名的那四个文件。

**C3b-9 —— 连不上的那个对端，究竟被告知了什么。**

**状态：已托管，而且是在合入后的那份字节上托管。** `mixed-link-e2e` 在托管 PR 道次
33290134608 上把四幕清单跑绿——先 20/20 mixed link acts，再 5/5 多页设备身份 acts，再
4/4 有界中继失败 acts，最后 5/5 不支持对端 acts——那份源码合入后就是 exact main
`9d815c84`；随后同样这四份清单又在那个 exact main 上跑绿了一次，在 Web 道次
33290357209 的 `mixed-link-e2e` job 99200800583 里，打印 `Mixed link E2E passed`，job
结论 `success`。那次 Web 道次的其余部分不在这条结论里：`9d815c84` 上的 workflow 整体
是红的，红在另一个 `test` job 的 page-shell 断言上，本文件不把 exact-main Web 道次
称作绿的。

这是那条只属于老路的断言里**渲染出来的那一半**（见下面"两件这次迁移不许做的事"），
也曾是托管 `main` 和阶段四之间最后剩下的东西。它是这个 runner 的**第四幕**
`unsupportedPeerScenario`，自带两个标签页和自己那份冻结的五个 act；前三幕的二十、五、
四个 act 一个字没动，清单侧现在查的是字面量 `EXPECTED_SCENARIO_COUNT = 4`。

**这是名义上的迁移，实质上的加强。** 退役的 `capsSuppressedScenario` 只断言一件事——
从不通告 `text/1` 的对端拿不到消息控件——而那条规则已经不是现在的产品规则了。现在既没有
"每张卡片一个消息控件"可以扣下，"扣下"本身也只是产品做的一半：不精确通告 `link/1` 的
对端会拿到一句明确的、不可交互的 `<p class="pa-unsupported">`，用用户自己的语言说出来。
"没有控件"和"没有控件，并且被告知了原因"是两种产品，而这里是后一种。所以迁过来的这一幕
保留了老那条证明的"不存在"，再加上取代沉默的那个"存在"，再加上——一张卡片在**一个控件都
没有**的情况下仍然可能骗人的四种方式。

**为什么是第四幕而不是往旅程里加 act。** 和多页、中继两幕同一个理由：它要在**启动前**给
其中一页装上线上过滤器，而那条二十幕旅程的全部意义是一条**连得上**的链路，一个标签页不
可能两者都是。

**那个仪器，说准确。** 一页以 `SUPPRESS_CAPS_HELLO` 启动，它在测试侧改写
`WebSocket.prototype.send`，只丢掉名册 hello——`data` 里除了 `caps` 什么都没有的那一帧，
正是 `peer-caps.svelte.ts` 拿来路由的那一帧。是**整帧丢掉**而不是把列表清空，因为那才复现
产品真正要处理的那种对端：从来没通告过，于是 `peerCapsKnown` 为假，没有第三种状态可以藏。
它是线上过滤器，**不是产品开关**——产品里放一个运行期降级旗标，等于给所有能设它的人发了
一条降协议的路，`src/lib/link-only-surface.test.ts` 就是防这件事的。

**让每一条"不存在"都站得住的，是那个对照。** 被掐的那一页**接收**照常，所以在它眼里另一页
就是一个普通的可达对端，卡片上就是那一个普通动作。于是"新页这边一样都没有"的每一条，都在
一个标签页之外、同一个浏览器、同一个房间、同一个产物上有一个**活的正对照**：控件在那边是
在的、拖拽高亮在那边是给的、强调色在那边是刷的——只是不给一个连不上的对端。一条旁边没有
正对照的"不存在"，和"这一页根本没渲染出来"没法区分，而那正是这一幕最容易掉进去的坑。这也
是为什么老那一幕的做法——连采 8 秒、由沉默推出不存在——**没有**被沿用：一个采样窗口只能
证明 runner 有耐心，它在"页面从没渲染"、"名册把对端弄丢了"、"探针的选择器不再匹配"上
一模一样地通过。

五个 act，冻结顺序：

1. *`unsupported-caps-suppressed-on-the-wire`* —— 一页的真实通告确实被掐掉了，而且两端
   仍然彼此**各看见恰好一个**。三个计数器堵住三种空转：`sawLink` 证明这个产物在过滤器
   动手**之前**确实通告了 `link/1`（没有它，一个不再通告任何能力的产品会让下面每一条
   "不存在"因为完全错误的理由通过）；`suppressed` 证明过滤器真的开火了；`otherCapsFrames`
   证明没有别的帧绕过 hello 把能力列表送上线。另外单独查新页**没有**装这个过滤器，否则
   "两边都没有控件"就是一句关于 harness 的话，而不是关于能力路由的话。互相可见排在最前，
   因为一个从名册里消失的对端同样没有控件、也没有卡片。
2. *`unsupported-one-noninteractive-statement`* —— 卡片上恰好一句、整页也恰好一句，而且
   在**每一种维护中的语言**下都成立。它是一个 `<p>`，没有 `role`、没有 `tabindex`、没有
   `aria-disabled`；最后这个是最像的那种错——它说的是"一个控件，现在不可用"，也就是
   "先别急"，而真相是"不是这台设备"，这是对"我该不该等"的两个不同回答。这句话还必须在
   `en` 和 `zh` 之间**变**：两种维护语言渲染出同样的字节，正是那种能通过全部结构检查、
   而产品其实已经不翻译这句话了的形状。
3. *`unsupported-no-control-no-affordance`* —— 卡片里零控件、零"拒绝态"元素，整页零
   `.open-workspace`；然后是一张没有控件的卡片仍然能带着的三种"像能按"：一次**真**的
   左键点击（`Input.dispatchMouseEvent`，落点由 `elementFromPoint` 证明确实打在卡片上，
   并由一个捕获阶段的监听器数下来——"什么都没发生"只有在"点击确实发生过"之后才作数）
   什么也打不开；`ondragover` 会加的那个拖拽高亮被扣下；单对端的强调色填充和 pointer
   光标都不给。拖拽探针的正对照是**先派发、先判过**：可达那张卡片先被拖过、先被验，
   之后才轮到不可达那张被拖——不是"两张都拖完再按顺序读"——所以只有在探针被证明**能**
   点亮一张真卡片之后，不可达那张才被记作"拒绝被点亮"。
   点击那一半是故意证两遍的。浏览器能证的是"真点一下什么也没变"，而这一条本身分不开
   "根本没有处理器"和"有一个处理器、跑了一下就 return 了"；补上这个缺口的，是一条对着
   真实 `src/App.svelte` 的源码形状契约：`.pcard` 的 `onclick` 必须以 `unifiedPeer`
   为条件，而在连不上的对端那一支上必须是 `undefined`。浏览器那半边**保留**、不是被
   替换掉：源码说"根本没挂监听器"，旅程说"硬按一下也什么都不会发生"。
4. *`unsupported-drop-refused-with-that-sentence`* —— 真实性的锚点，也是唯一一条证明这句话
   是**事实**而不只是渲染出来又不可点的检查。一次真的文件 drop 硬落在卡片上时，产品必须
   **接管**它（`dispatchEvent` 返回 false，即页面调了 `preventDefault`）并且答复，而它弹出
   的那句提示必须和卡片上已经写着的那句**逐字节相同**。页面不理的 drop 会留给浏览器；页面
   接管了却什么也不做的 drop，就是文件消失、哪儿都不说一声。因为比的是"卡片那句"对"提示
   那句"，所以它在**没有把任何一条 locale 字符串写进 runner** 的前提下，把"声称"和"执行"
   钉成了同一件事。
5. *`unsupported-quiet-suppressed-tab`* —— 老那一幕的另一半，保留：老对端不许被塞一张
   "接收失败"卡、一个幽灵会话，或者任何一页因为够不着对方而自己编出来的东西。由
   `ARM_BACKGROUND_LATCH` 盯着，它的 `chooser` 字段就是它自带的反空转半边——被掐那一页
   **确实**有那个控件，所以"其余全零、chooser 非零"只能由一个真的在看活 DOM、且选择器仍然
   匹配的观察器达成。随后两页一起扫控制台报错。

**语言口径是落到实处的，不是提一句。** runner 冻结 `MAINTAINED_LANGS = ["en", "zh"]`
——正是 `i18n/types.ts` 维护的那两种——并且只要这一幕的代码区域里出现任何一个
`FROZEN_LANGS` 代码（ja、ko、de、fr、ar、es、pt），源契约就判红。对着一门已归档的翻译
断言，会让这一幕因为一个没人在维护的 locale 变红，那是一次关于真实口径的假回归。**任何**
locale 的句子——包括维护中的那两门——都没有被写进 runner：`en.ts` 或 `zh.ts` 改一句文案
不许把它弄红，而一个把某一门语言写死的产物也不许让它变绿。

**这一幕不能代表什么。** 它是一个 headless Chromium 的两页，不是两台设备，也不是两个产品
版本：这个对端"老"只体现在它的 hello 没进房间。它没说真正的老客户端在**自己**屏幕上会渲染
成什么样，没说卡片旁边那条 `LanPathRail` 或雷达，也没说那两门维护语言之外的任何 locale。

*这次改动碰了哪些文件*：四个，全是测试与文档——`web/e2e/mixed-link.mjs`、
`web/e2e/go-server.test.mjs`、`docs/TESTING.md` 和本文件。产品源码、workflow、依赖包、
服务端、原生和 ops 一个都没动；`lan-transfer.mjs` 和它那条 npm 脚本也刻意留着，要等这一幕
托管之后才轮到。

**当前状态：已在 exact main `9d815c84` 托管通过，并且是在合入后的那份字节上通过的。**
`mixed-link-e2e` 道次在托管 PR 道次 33290134608 上把这一幕跑绿——**20/20、5/5、4/4、
5/5** 个有序 act——那份源码合入后就是 exact main `9d815c84`；在那个 exact main 上，Web
道次 33290357209 的 `mixed-link-e2e` job 99200800583 又把同样四份清单跑绿一次
（**20/20、5/5、4/4、5/5**，`Mixed link E2E passed`，job 结论 `success`）。所以那条
"渲染出来的不支持对端"形状是**托管**迁移，而且证了两遍：一遍在被审阅的源码上，一遍在
真正落在 `main` 上的字节上。承载那个 job 的 Web 道次本身是红的——红在另一个 `test` job，
原因是与此无关的 page-shell 那件事（见下面阶段四）——本节没有任何一条结论依赖它。下面
这张表是合入之前的**本地**记录，原样保留：它记的是审阅方当时在被审阅的源码上手工跑了
什么，不是托管结论。

| 门 | 结果 |
|---|---|
| 对 `e2e/mixed-link.mjs` 与 `e2e/go-server.test.mjs` 跑 `node --check` | **通过**——两个都解析干净。值得手工跑：没有任何门会去解析 `e2e/mixed-link.mjs`（`go-server.test.mjs` 是把它当**文本**读的）。 |
| 对 `e2e/go-server.test.mjs` 跑定向 Vitest | **通过——150/150**（验收当时），含这一幕的源契约和更新过的清单契约 |
| 真浏览器 runner，对着本地构建出来的 Go 服务器，四幕全跑 | **通过——20/20、5/5、4/4、5/5** 个有序 act，真 headless Chromium |
| Web 全量测试 | **通过——4,455 条通过、3 条 skip**（那 3 条是套件自己预期的 skip） |
| `npm run check` | **通过——零 error、零 warning** |
| `npm run build` | **通过——447 页 + 12 个 shell** |

150 是**验收当时**的数。本节末尾记的那次窄修订新增了一条契约，所以当前源码上定向套件读作
**151/151**；上表里浏览器、全量、check 与 build 四项都是修订之前跑的，且因为这次修订只动
测试与文档文件，它们原样沿用。

随后审阅方独立做了七处变异，一次一处、每处都还原回被审阅的精确哈希再做下一处，以证明这些
契约不是白过的：

- 删掉那道真实的 `sawLink` 反空转检查：判红 **1** 条——它是"这个对端是老的"和"这个产品
  什么也不通告"之间唯一的分界。
- 削弱"恰好渲染一句"：判红 **1** 条。
- 删掉"零控件"那道闸：判红 **1** 条。
- 删掉"真点击确实落在卡片上"那道判断：判红 **1** 条——没有它，"什么都没发生"会被一次根本
  没送达的点击满足。
- 删掉提示与卡片那句话的相等判断：判红 **1** 条：那句话就只被证明"渲染出来了、且不可点"，
  从来没被证明是**真的**。
- 把维护语言收窄成一门：判红 **1** 条。
- 绕过这一幕本身、或绕过它最后一个 act：判红 **2** 条。

七处变异，1/1/1/1/1/1/2，每处都还原回被审阅的精确哈希再做下一处，一处也没有被提交。

作者自己在验收之前跑的那一轮记在这里，因为它说清了"这个 worktree 里还没有门的时候，手工
跑了什么"：对两个文件跑 `node --check`，以及十二处一次一处的变异——由一个带最小 `expect`
垫片的独立 Node 小执行器执行，不是 Vitest：从真实文件里切出 **91/91** 个契约块，对着真实
的 `e2e/mixed-link.mjs` 跑。那是**真的在执行断言**、不是解析，但它从来不是那道门；上面那
张表才是。

十二处垫片变异，一次一处、每处还原后再做下一处。验收当时两个文件都哈希回被审阅的那份
源码——`e2e/mixed-link.mjs` 的 SHA-256 前缀 `fcf50699`、`e2e/go-server.test.mjs` 的
`964636a7`。

**验收之后的那次修订，改了什么。** 验收提了两条，都是关于**说法**而不是关于行为的，两条
都在同样这四个文件的范围内闭掉：

1. 拖拽探针的正对照实际是**第二个派发**的，而文字说它先跑。两次拖拽在任何一个被判定之前
   就都已经在飞，于是那次"负向"测量是用一个还没被证明能工作的探针做的。现在可达那张卡片
   先被拖过、先被验，之后不可达那张才被拖；源契约钉的是四个位置——派发正对照、验正对照、
   派发负向、判负向——而不再只钉那两条断言的先后。
2. act 和文档说"没有点击处理器"，而活测试证的只是"真点一下没效果"。这是两句不同的话，而
   "整个函数体就是一句 guard return"的处理器恰好能满足后一句。上面 act 3 里写的那条
   `App.svelte` 源码形状契约，把前一句从产品源码上证出来；浏览器那条"没效果"的证明保留在
   它旁边。

这次修订还把一句被从中间劈成两半拼接的报错句子重新拼顺了，它产出的字符串逐字节不变。

修订之后的复验：两个文件 `node --check` **通过**，定向 Vitest **151/151**。当前源码哈希是
`e2e/mixed-link.mjs` 的 SHA-256 前缀 `f094520f`、`e2e/go-server.test.mjs` 的 `e2cadf0a`，
审阅方从这里复验。改动仍然只有上面点名的那四个文件。

**阶段三：有界的中继失败——C3b-8 已在 exact-main `74ac85db` 托管通过。** 第 7 条在
C3b-7 搬走后，这一阶段只剩第 8 条。它放到最后，因为它需要前面用不到的搭台：那份池形状
的 `/api/ice` 响应、一个连不上的 TURN 主机，以及一个真的会走完的探测预算。

**阶段四：删掉 `lan-transfer.mjs` 和它的 `test:e2e` npm 脚本。** 只在托管 `main` 带着
阶段一到三**以及**那条渲染出来的"不支持对端"形状全绿之后——按 C3b-9 之后的状态，也就是
只在**第四幕**在 `main` 上跑过 `mixed-link-e2e` 之后。阶段一到三已经在 `74ac85db` 越过
这条线；C3b-9 先在托管 PR 道次 33290134608 上越过、合入后即 exact main `9d815c84`，随后
按这条线的字面意思也越过了——**第四幕**确实在 `main` 上跑过 `mixed-link-e2e`，就在 Web
道次 33290357209 的 job 99200800583 里，20/20 + 5/5 + 4/4 + 5/5，并打印
`Mixed link E2E passed`。这条结论只到"那个 job 通过"为止；包着它的那次 Web 道次是红的，
原因见下。删早了会丢掉那条当时还在等托管跑的断言；第 1、2、3、6、7、8 条
搬走且第 4、5 条按上面记录的确定性证据退役后，已经没有搁浅的了。而留着比没用更糟——一个
永远退不出 0 的脚本，教会所有人忽略一次红。阶段四现在**已解锁但尚未做**，是单独一件活，
本文件不声称它已经做了。

**exact main `9d815c84` 上有一个托管 job 是红的，但不是这一个。** 上面那条
`mixed-link-e2e` 结果是解锁阶段四的那一条——而它就是这里点名的这次道次**里面**的一个
job。`9d815c84` 上的 Web 道次 **33290357209** 同时装着 `mixed-link-e2e`（job
99200800583，`success`）和挂掉的 `test` job（99200800702）；workflow 整体结论 `failure`
只是后者一个 job 带来的，所以本文件按 job 粒度记这次道次，并且从不把它称作绿的。那个
`test` job 挂在 `test:e2e:page-shell` 的 `/apps` 移动端触摸目标断言上：Linux
Chromium 把一个 CSS 44px 的 CTA 量成 `43.999969482421875`，而那一幕当时拿原始高度去比
一个裸 `< 44`。同一份源码在 PR #95 的同一个 job 上是绿的，因为亏的那点是
`getBoundingClientRect()` 里 2⁻¹⁵ px 的 float32 尾数，不是一个矮下去的按钮。
**状态：修法已写，待托管 CI**——44px 仍然是写死的要求，三处触摸测量统一走一个
`undersizedTouchTarget()`，容差是具名的 `TOUCH_TARGET_EPSILON_PX = 1 / 1024`，
而这条论证本身由 `apps-hierarchy-contract.test.mjs` 钉住。详见下面 `page-shell.mjs`
一节里的"44px 触摸地板"。在托管 Web 道次跑绿之前，那个修法是**本地**结论——和
33290134608 之前的 C3b-9 一模一样。

两件这次迁移**不许**做的事：不许把删掉的控件加回来，不许加降级开关。真正只属于老路的
那部分，缩成了一条关于"不存在"的断言——不通告 `link/1` 的对端拿不到任何控件，并且被
如实告知。

这条断言的两半**状态完全不同**，别混着说：

- **当前在跑的**：`src/lib/link-only-surface.test.ts`（删掉分叉的同一个提交加的）。
  它是确定性的 Vitest 源码级门——production 源码里不 import 任何老会话模块，工作区
  路由器手上没有可回退的传输——每次推送都在 `test` 作业的 `npm test` 那一步跑。
- **C3b-9 已迁移，已在 exact main `9d815c84` 托管**：`capsSuppressedScenario` 当初是
  设计来在真浏览器里钉观察方那一侧的形状（从不通告 caps 的对端拿不到任何控件，老对端那边也不冒出任何
  假卡片）。它是 `main()` 里的**最后**一幕，位于上面说的非执行尾巴的最深处，已经好几周
  无论本地还是 CI 都不跑。它的形状现在落在 `mixed-link.mjs` 的**第四幕**
  `unsupportedPeerScenario` 里，详见上面 C3b-9 一节——那里也写清了为什么迁过来的断言
  比退役那条**实质更强**，而不是改个名字。

也就是说：源码那一半一直有门守着，渲染出来那一半现在也覆盖上了——而且是托管的，所以缺口
是关上了，不只是变窄。`mixed-link-e2e` 在托管 PR 道次 33290134608 上跑过第四幕，那份源码
合入后即 exact main `9d815c84`，合入后的那份字节又在 exact-main Web 道次 33290357209 的
job 99200800583 上跑绿一次，本文件因此可以把渲染那一半记作**已托管**迁移——被审阅的那份
源码上是、真正在 `main` 上的那份源码上也是。那次 Web 道次整体是红的，红在另一个 `test`
job，这句话不声称相反的事。这里以前写的是"浏览器侧的'不支持对端'形状和独有断言第 8 条
一起在等阶段三"；第 8 条在 C3b-8 搬走、这个形状在 C3b-9 搬走，它仍然是一件单独的活，不属于上面
任何一行编号。这里不需要真的做一次老式传输，因为已经没有老式传输可做。

每一条断言迁移完都要真跑一次、绿了，才可以在文档里重新称它是自动化覆盖。改到不抛异常
为止、背后没有一次记录在案的绿色运行，正是这一节要防的那种"什么也没测出来的断言"。

### 它测的是什么（设计意图；见上，尾巴当前未执行）

vitest 那些测试**一行都覆盖不到实时传输管道**：收发两条管道原本长在 App.svelte 里、
现在在 `mixed-file-session.svelte.ts` / `mixed-text-session.svelte.ts` 那条统一
`link/1` 链路里，两者都需要两个真实的浏览器上下文、一条真 WebSocket 信令和一个真
RTCPeerConnection 才跑得起来。这个脚本**当年**是它们唯一的回归网；`mixed-link.mjs` 和
`code-room.mjs` 出现之后已经不是了（见上面那份重复/独有的拆分）。下面五条按原样保留，
但读的时候要带上两个限定：**它们现在一条都没在跑**，而且其中大部分在那两套里有等价
断言；当年真正搁浅的是上表那八条，而那八条现在也全部改了状态（见上表）。

1. **握手到落盘的全链路**：两个标签页进同一个 LAN 房间 → 互相发现 → 塞进一个 3MB 文件
   → commit-reveal → DataChannel → 分块 AES-GCM → 流控 ACK → 逐文件完整性校验 → 落盘。
   最后按 **SHA-256 比对收到的字节**，不是"看见进度条到 100% 就算过"。
2. **文件名出现在确认卡片上** —— 那是用户做信任决策的地方。
3. **两侧 SAS 一致**（中间人防护里用户看得见的那一半）。SAS 只在传输**进行中**显示，
   所以是从点下"接受"起后台采样的；采不到就算失败，而不是悄悄跳过。
4. **断线续传**：传输中途（第一 MB 落盘之后）把两端的连接同时判死，然后断言
   续传后的文件与发出的字节**逐字节一致**、总字节数正好等于文件大小（从 0 重来会超），
   且收方确实新建过至少两个 RTCPeerConnection —— 最后这条是防"掉线注入还没落地就传完了"
   的假绿。断线续传是这条链路上最复杂的一段（connectResume + checkpoint + chain hash
   恢复 + pausedRecv 状态机），也是手机上最常发生的事。
5. **建连途中失败要报得干净**：第二幕给收方注入一个"数据通道打开前就 failed"的
   RTCPeerConnection。这一窗口出过真 bug（掉线处理函数当时还在 TDZ 里，抛
   ReferenceError 而不是失败卡片），所以用例直接断言"没有 ReferenceError"。

### 只桩掉一样东西

`showSaveFilePicker`（操作系统的另存为对话框，无头浏览器开不出来）被换成一个把字节
攒进内存的假句柄。除此之外全是真的：真服务器、真信令、真 WebRTC、真加密。

### 已知的环境坑

- **必须关掉 mDNS 候选隐藏**（`--disable-features=WebRtcHideLocalIpsWithMdns`）。
  Chrome 默认把本机 IP 藏成 `.local` 候选，无头环境里没有解析器，两个标签页于是永远
  配不出可用候选对，ICE 直接 failed。
- **Go 服务器的 CSP 必须带 `'wasm-unsafe-eval'`**（`server/spa.go`）。libsodium 是
  WASM，缺这个 token 浏览器拒绝编译它，应用连信令都连不上。有 Go 单测钉着。
- 脚本启动时会先 `pkill` 掉上一轮残留的浏览器：它们的标签页还挂着 WebSocket，攒够
  几个就会撞上服务器的**每 IP 并发 /ws 上限**，新标签页静默连不上——那种失败看起来
  和真回归一模一样。两个脚本用不同的 `--remote-debugging-port`（9444 / 9445），
  所以谁也不会顺手打死对方的浏览器。

### 它为什么是**降级**回归，以及那个过滤器

默认产物在无配对码的 LAN 房间里是会通告 `link/1` 的。所以这套用例在开出第一个标签页
之前调一次 `setDefaultInit(STRIP_LINK_CAP)`：**每一个**标签页（包括以后新加的场景）
都被套上一个测试侧的线上过滤器，把离开 socket 的每一帧里的 `link/1` 及与它耦合的
`preupload/1` 抹掉——名册那一帧和 SDP 上捎带的那一份都抹，正是一个老版本
Web/原生/CLI 对端会发出的东西。

页面本身是原封不动的发行构建、原封不动的策略。**产品里没有降级开关**：放一个进去，
等于给所有能碰到它的人发了一条把协议降级的路。

消息那一幕上钉了两件事，缺一件都证明不了什么（它本来就要等 caps 到达，不额外花时间）：

- `__legacyPeer.sawLink > 0` —— 这个产物在 LAN 房间里**确实**通告了 `link/1`。哪天谁
  把通告整个关掉，下面所有"老路照旧工作"的断言都会因为错误的原因通过。
- `__legacyPeer.hello === ["text/1"]` —— 但对端收到的是老对端的那一份，且页面里一个
  统一工作区节点都不挂。

上面这两条现在也随尾巴一起不执行。而且要看清这个过滤器如今意味着什么：`d175f863`
之后，一个只通告 `text/1` 的对端在产品里**没有任何可驱动的传输入口**，卡片上给的是
`.pa-unsupported` 那句话。所以"降级回归"这个身份对传输类场景已经不成立了——不是选择器
改个名的事。这正是上面"迁移方向"里说的：传输类的几幕摘掉 `STRIP_LINK_CAP` 走统一工作区，
而只属于老路的部分退化成"没有控件、并且说清楚"这一条关于不存在的断言。
`STRIP_LINK_CAP` 这个机制本身留着——不是因为 `capsSuppressedScenario` 眼下在用它（那一幕
也不执行），而是因为迁移后的那条"不存在"断言仍然需要一个真的老对端才能制造出来。在那之前，
守着这条不变式的是源码级的 `src/lib/link-only-surface.test.ts`，不是这个过滤器。
**产品里依旧没有降级开关**，这条纪律不因为要修绿而松动。

---

## `mixed-link.mjs` — 一条真的统一链路（`link/1`）

`npm run test:e2e:mixed`（CI 的 `mixed-link-e2e` 作业里跑）

跑的是**普通的默认产物**，不需要任何专门构建，也不需要你先起服务器：

```bash
cd web && npm run build && npm run test:e2e:mixed
#   自起端口：--port 8124（默认；刻意避开手工那台的 8098 和 device-inbox 的 8123）
#   留证据：  --screenshots [目录]（默认 web/e2e-screenshots，已 gitignore）
#   调试：    --keep 保留 Chrome 的临时 profile，以及自起服务器的临时目录
```

服务器由 `go-server.mjs` 从 `./server` 构建、起在一个自己的临时数据库上，跑完（成功、
失败、看门狗超时都一样）连临时目录一起收掉。五条它会**当场拒绝**而不是慢慢超时的情况：

- `--port` 给的不是一个 1–65535 的整数。这一条排在最前面，因为 Node 对"没有端口"的两种
  写法反应并不一样：`listen(undefined)` 会绑一个内核随便挑的空闲端口，所以程序里直接
  `startGoServer({ port: undefined })` 那种调用能骗过"这个端口没人占"，花掉一次完整的
  Go 构建，最后由子进程拿着 `RELAYIUM_ADDR=127.0.0.1:undefined` 去死——报的是服务器，
  不是那个缺掉的值；而命令行上的 `--port`（后面什么都没有）经 `Number()` 变成 `NaN`，
  `listen(NaN)` 直接抛 `RangeError`：红得是早，可既没说 `--port`，也没说这是哪套用例。
  现在两种都在最前面被同一条检查拦下，报的是那个值本身。
- `web/dist/index.html` 不存在，或者比 `web/src` 里任何一个源文件旧。旧 dist 是这套
  用例最会骗人的一种失败——每一页都加载得出来，然后在某一幕深处对着这份 checkout 里
  已经没有的代码红掉。
- 那个端口上已经有人在听。它**不接管**：那台服务器有它自己的库、自己的 dist、可能
  还有开发者的真配置，对着它跑绿什么也证明不了。
- 子进程还没应答 `/healthz` 就退出了。报的是"退出了"，并给出抓下来的日志路径，
  而不是等满整个就绪预算再报一个指向错误方向的超时。
- 给了 `--url` 却没给地址：后面什么都没有、`--url ""`、或者后面跟着的是下一个开关。
  前两种以前都是 falsy，于是这套用例转头去自起一台本地服务器——绿是绿了，绿的不是你
  点名的那台；第三种把开关当成地址吞下去。三种现在都在构建和浏览器之前，以
  `Mixed link E2E` 的名义报出来。

要打一台**你自己起着**的服务器，显式给 `--url`（这条手工快路保留）：

```bash
cd server && RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=:8098 go run .
cd web    && node e2e/mixed-link.mjs --url http://localhost:8098
```

### 作用域在哪：能力，不是房间，更不是构建旗标

`peer-caps.svelte.ts` 里是两样分开的东西：

- `LINK_BUILD_SUPPORT` —— 这个**构建**实现了 link/1 吗。一个普通常量，不读环境变量。
  以前它是 `VITE_RELAYIUM_LINK_E2E` 的构建期替换，意味着"发行版说不说这条协议"取决
  于有没有人记得设那个变量，而唯一证明这条路的 E2E 跑的是一个从没被部署过的产物。
- `linkRoomActive()` —— 现在允许用吗。**每个房间都允许**，LAN 和配对码一视同仁
  （DECISION-LOG 2026-08-10 取代了 2026-08-04 的 LAN-only 作用域）。中继链路换来的
  不是拒绝说这条协议，而是一条有界的寿命：`relay-deadline.ts` 从服务器签发的 TURN
  凭据里推出一个带时钟偏移余量的边界，`mixed-session` 到点让链路进入可信的终局态。
  这个谓词留着，是为了让"通告"和"路由"永远只有**一个**开关。

跟着房间一起走掉的**不是**降级边界：`peerSupportsLink()` 仍然是精确匹配，只认
`link/1` 这一个字符串。老版本浏览器、原生客户端和 CLI 都只通告 `text/1`，而它们会把
任何入站 offer 读成一次文件传输、然后等一个永远不来的 manifest——所以对它们的投机性
双通道 offer 是**这条协议唯一真正的危险动作**，两个房间里都不许发生。

`advertisedCaps()` 是名册通告和 SDP 确认（`localCaps()`）的**同一个**来源，
`peerSupportsLink()` 读的是**同一个** `linkRoomActive()`——所以不会出现"通告了却拒绝
路由"或者反过来的不对称。两边的行为覆盖在 `peer-caps.test.ts` 和
`peer-workspace.test.ts` 的 "link/1 routing scope"（含精确匹配的降级用例、伪造/畸形
名册声明、入站请求/应答、换房间清场）。

脚本第一件事就是读页面**真正发出去的**名册通告；不做这件事的话，"服务器指着旧 dist"
会伪装成"链路建不起来"——一条看起来像回归的假红。

### 它跑的是**默认的 LAN 界面**

这一点先说，因为它决定了脚本里的每一个选择器：在无配对码的 LAN 房间里，一个能说
`link/1` 的对端**只有一个**主动作 `.open-workspace`。它打开的工作区自带草稿框和附件
控件（`.attach-file` / `.attach-folder`），而对端卡片和"可以发消息"那条提示在工作区
活着的时候整个收走。老的"文件 / 文件夹 / 消息"三选一**已经不存在了**：`d175f863` 把它
连同 `.pa-files` / `.file-pick-input` 一起删了，说不了这条协议的对端现在拿到的是
`.pa-unsupported` 那一句话，一个控件都没有。（这里以前写着"那条路由 `lan-transfer.mjs`
的降级套件覆盖"——两半都已过期：那条路由没了，而那套降级套件也不再执行。）配对码房间
走的是和这里同一套界面，由 `code-room.mjs` 覆盖。

两边的工作区都会为一条新链路**自动开一次**文本通道（否则只有点了按钮的那一边有草稿
框，另一边连一个能点的东西都没有）。两个请求撞在一起时协议按 `link.role` 收敛成一个
会话、一次同意提示，而那次提示落在哪一边取决于真实网络时序——所以脚本等的是"有且只有
一边在问"，不是"B 在问"。

### 它测的是什么

一条链路，两条通道，全程真东西：真 caps → 真 link 请求/应答 → 真 commit-reveal →
**一条** PeerConnection 上的两条 DataChannel → 两条通道各自的同意状态机。

1. **默认卡片只有一个动作**：`.peer-actions` 里正好一个控件，一个 `.open-workspace`，
   零个 `.file-pick-input`。点它就出工作区。
2. **一条链路一个 SAS**。这是这套 UI 最核心的规矩，所以它是一个在每个阶段都复用的
   断言：数**整页**的 `.sas` 必须是 1 且在头部里，同时点名文件进度卡、请求卡和消息
   面板那三个历史渲染点必须是 0。路径徽标同理。两个标签页的六位码必须一致。
3. **工作区一活起来就独占屏幕**：`.peers`、`.peer-actions`、`.open-workspace` 和那条
   可用性提示在两个标签页上都归零，断开之后又一起回来。
4. **第一条同意边念一次码，后面的边不再念**：这条链路的第一次同意（文本通道）必须在
   live region 里带上那六位码；同一条链路上后来的文件同意边必须**不**再念一遍——码一直
   挂在钉住的头部里。跨链路的那一份在第 10 幕单独验。
5. **手机上下一步就在第一屏**：390×844 下，消息同意卡和 40 个文件的同意卡，SAS 与同意
   按钮都在视口内，没有横向溢出，也没有替用户聚焦任何"接受/发送"。
6. **粘性头部**：长清单滚下去之后，唯一那个 SAS 仍然钉在验证语境里（先断言页面确实
   可滚，否则这条检查什么也证明不了）。
7. **队列可见可取消**：传输中再从工作区选文件不会禁用附件控件，而是排成一条带取消按钮
   的队列；同一时刻草稿框仍在。选文件这个动作本身就会在控件是 `disabled` 时抛错。
8. **文件同意可以拒绝**，而链路**和会话**都活下来——拒绝一批文件不等于断开一条链路。
9. **两条通道同时可用**：打字打到一半时附件控件仍然可用、发送键仍然可按；正文**逐字节
   一致**（比 UTF-8 十六进制，含 tab、空行、CJK、阿拉伯语和星平面 emoji）。
10. **手机上一个 picker 都不开，文件仍逐字节到手**（2026-08-30 / C3b-6，从
    `lan-transfer.mjs` 搬来的独有断言第 1 条）：同一条链路上临时给接收页换安卓 UA 与
    platform，并装上**两个真能用**的 picker（先在运行时证明各调一次、吞下 8 字节，再清零）
    外加 Blob/anchor 下载捕获。点"接受"之前，共享的 `.savehint` 必须是唯一一条、不是 retry
    版、没有内存提示，并且既承诺下载目录又不是"选择保存位置"那句。点完之后：两个 picker
    计数与句柄字节数精确为零；恰好一次下载，名字、声明长度和字节模式逐项精确；它那张按
    文件名唯一限定的传输卡成功、无在途进度条、状态无"取消"字样；link、SAS、草稿框和附件
    控件都还在。四个边界与 UA 在一个不会抛的 `finally` 里按**同一性**还原，紧接着的桌面
    picker 那一幕据此仍能证明它自己的两次调用。**这是伪造 UA 的桌面 Chromium 加浏览器
    边界桩，不是真安卓设备、真系统 picker 或真下载管理器**；它证明的是产品主动的手机策略
    （`filesink.ts` 的 `pickersAllowed()`），不是那两桩真机故障本身。
11. **真 Chromium 的 SCTP 缺省上限**（2026-08-30 / C3b-5，从 `lan-transfer.mjs`
    搬来的独有断言第 3 条）：先删除远端 SDP 的非零 `a=max-message-size` 通告并证明真的删过，
    再用原生 DataChannel 精确探测 65,536 可发、65,537 不能保持成功且开放；probe 清零后，
    两页的初始产品 PC 和续传后的全部 replacement PC 都必须精确报告 65,536。它不等于
    `TEXT_MAX_BYTES`，后者是明文产品上限。
12. **传输进行中的活进度条**（2026-08-29 / Phase 3D C3b-1，从 `lan-transfer.mjs`
    搬来的独有断言第 6 条）：在 5 MiB 那次传输的**中途**——接收方已经落了两个 durable
    chunk、强制掐断还没发生——先证明主体在（发送与接收两侧各一条 `.progress-bar`、
    `role="progressbar"`、`aria-labelledby` 指到卡片自己那个标题 id
    `xfer-label-{send,recv}` 且解析得出非空名字、`0 ≤ aria-valuenow ≤ 100`、卡片还没
    进终局），然后才以 `XFER.card` 为 context 扫一次 axe。顺序不能反：一个 context
    什么都没匹配到的 `axe.run` 报的是零违规，看起来和"干净"一模一样。
13. **真断线后按字节续传**：强制换掉 PeerConnection（并断言真的换了），5 MiB 文件按
    durable checkpoint 续完、逐字节校验、不重新同意、SAS 不变；会话被传输中断关掉但
    **记录还在**，而且重开是一颗显式的 `.restart`，不是自动重连。
14. **320/390px、中英文与深色**：三种组合下头部和附件行都不溢出、SAS 和断开按钮都在
    视口里、断开按钮留在行尾、粘性头部有不透明背景，每一格都跑一次 axe。
    `--screenshots` 会把每一格存成 PNG，但每条几何规矩下面都有真断言钉着。运行时维护
    语言目前都为 LTR；若恢复 RTL 语言，必须先恢复逻辑属性镜像的真实运行时门禁。
15. **一次活过了自己那条链路的待决同意**：挂着不答就断链，再连回同一个对端——reveal
    去重键（peer+lane，不含世代）算出来是同一个，所以新链路的第一条边必须念它**自己**
    那串新码。顺带钉住：断开之后统一草稿框和附件不许留在屏幕上。
16. **显式断开收干净**：一次点击关掉两条通道，两个标签页的头部、队列和输入框都消失，
    对端也跟着收——然后那个对端重新可选，而且回来的仍然是那一个动作。

最后和默认那一套一样：两页都不许有 console 错误。

### 第二幕：多页设备身份（C3b-7）

这个 runner 还跑**第二幕** `multiPageDeviceScenario`，它开自己的三页、用自己的种子、
并且把高级验证关掉，和上面那条二十幕旅程完全独立（详见前面 C3b-7 一节）：

17. **一个浏览器的两页 = 一台设备**：两页共用一个显式 LAN 种子，第三页自己一个；
    第三台设备的名册**精确**只有一条，而那两页谁也不把自己的兄弟页列出来。
18. **焦点在两个方向上决定代表页，而且没人离开**：先切 A2 再切回 A1，第三台设备的
    名册两次都要跟着精确变；同时离开台账在交接前后都必须是空的——换代表不许表现成
    "设备掉线又回来"。
19. **请求跟着焦点走**：用 `.open-workspace` 从第三台设备开工作区，当前那页和发起方
    都拿到草稿框；后台那页上一张**事先装好**的闩必须精确为零（同时它数的那个"后台页
    确实有的控件"必须非零，否则这串零什么也不证明）。
20. **关掉代表页 → 精确的离开 + 精确的回落**：真关标签页，第三台设备必须只看到**这一页**
    离开，名册精确回落到活着的兄弟页。
21. **回落之后设备真的还能用**：先把幸存页切成当前页（这一步会重发它的能力 hello，见上面
    那条产品缺陷），用产品自己的控件把关页留下的工作区答掉——`.wh-disconnect` 或
    `.wh-restart`，哪个在屏幕上就答哪个，一个 deadline、无 sleep、拒绝什么都不做——然后 B
    必须重新拿回**恰好一个可用动作**，再用它开**第二个**工作区，必须够到幸存页并打开发起方
    自己的草稿框。

### 一幕不等于一条断言：冻结的逐 act 执行台账

上面第 1-16 条被拆成**二十个具名 act**（一条编号里含多个 act 的地方，是因为它们各自
能单独失效），第 17-21 条是第二幕自己的**五个** act，第三幕另有**四个**、第四幕另有
**五个**。每个 act 在自己的断言全部通过之后调一次 `act(name, message)`——它同时负责打印
那行 ✓ 和记台账，所以"报告成功"和"记录为执行过"是同一句话，拆不开。四幕共用同一个
`newLedger(acts)` 工厂，所以"名字不在清单里"和"同一个 act 记了两次"这两道守卫不可能在
一幕里有、在另一幕里被忘掉。

跑完 `runScenarios()` 对**每一幕**三样一起查：成员、**顺序**，以及那一幕自己的字面量
计数——`EXPECTED_ACT_COUNT = 20`、`EXPECTED_MULTIPAGE_ACT_COUNT = 5`、
`EXPECTED_RELAY_ACT_COUNT = 4` 和 `EXPECTED_UNSUPPORTED_ACT_COUNT = 5`。这里必须是
字面量，不能写 `ACTS.length`——数组和它自己的长度在有人删掉一项之后仍然彼此同意，于是
一次少了一幕的运行会干干净净地报 `19/19`。同样的道理，`EXPECTED_SCENARIO_COUNT = 4`
单独存在，但它保护不了多少：一个被改到只剩第一条断言的 `mixedScenario` 照样能让整套
报 `4/4`。真正起作用的仍然是那四个 act 数。四份清单刻意不合并成一份三十四条的平表，
因为那样"某一幕根本没起来"和"少了一个 act"会报成同一种失败。

`e2e/go-server.test.mjs` 对着这个 runner 的**源码**钉住整个形状（每次推送都跑）：
四份冻结的 act 名单与顺序、五个字面量计数（以及"清单项里不许出现 `.length`"）、
`ran++` 和场景调用之间没有 `catch`、活进度条那一扫确实落在"接受"和"强制掐断"之间、
这个 runner 手里不再有任何一份 `.request` / `.xfer` / `.progress-bar` 的私抄，外加
第二幕自己那一组：种子必须是"两同一异"且都显式、必须有反向那次 activate、后台闩必须
在请求之前装好且带反空转计数、离开与回落必须是精确比较而不是 `includes`、幸存页必须在
恢复之前被切成当前页、B 必须在调用点上重新拿回"恰好一个可用动作"、`returnToChooser`
不许再长回答控件循环、以及不许用信令帧读数或退役选择器抄近路。第三幕和第四幕各自也有
一组，见上面 C3b-8 / C3b-9 两节。

同一个文件还钉住这次**产品**修复的接线（见上面那条能力剪枝缺陷）：当前页转换的那个回调
必须同时做 `sendActivate` 和 `capsAnnouncer.refreshPresent(otherPeerIds())`；两条通告路径
共用同一个"名册减去自己"的表达式；`watchCurrentPage` 只在真转换上回调、初次挂载不回调；
接收路径只 `didHearFrom`、绝不回发；`refreshPresent` 只发送——不碰 greeted/pending、不装
定时器、不花重试预算；以及 `link/1` 的 fail-closed 精确准入一字未改。

---

## `a11y-scan.mjs` — 已构建产物的无障碍扫描

`npm run test:a11y`（CI 在 `npm run build` **之后**跑同一条命令）

```bash
cd web && npm run build && npm run test:a11y
#   另存机读结果：--json a11y-report.json（全量，永远不聚合）
#   只跑某几格：  --only pricing
#   展开 incomplete：--verbose-incomplete
#   打一个已经跑着的服务器：--url http://localhost:8099
```

不给 `--url` 时它自己起一个 `vite preview` 吐 `dist`，跑完收掉。不自己写 HTTP 服务器
是有意的：手写一份就得重现 nginx 的 `try_files` 规则，而那份复制品一定会和
`server/spa.go` 漂移，然后用一条测不准的路由给出一条测不准的结论。

### 为什么必须是真浏览器

SPA 壳的 `<body>` 里只有一个 `<noscript>`——真正的界面全靠 JS 挂上去。扫原始 HTML
等于在扫一段给爬虫看的备份文案，一条违规也发现不了却显示全绿。颜色对比度同理：它要的
是**计算后**的样式，不是源码里的变量名。

### 扫什么

15 格，表在 `a11y-targets.mjs`（单独一个模块，好让 `a11y-core.test.mjs` 能 import 它
去断言——`a11y-scan.mjs` 顶层就跑完整轮扫描，谁 import 它谁就等于跑了一次 CI）。

静态那 7 格覆盖全部 6 种模板（landing / article / guides-index / legal /
mode / 404）：landing 的代表页本身是 RTL，article 再加一份 RTL 分支；mode 模板只有本地化
语言有静态页（英文走 SPA 路由），所以它那一格是 `/zh/cross-network/`。SPA 那 6 格覆盖首页
的桌面浅色与移动深色、cross-network / pricing / apps / cli。另外 **2 格是动态决策态**，
都挂在账户弹窗上（账户按钮只在 cross / offline / pricing / me 四条路由上渲染）：一格是
登出态的登录表单，一格是**已登录免费用户展开的内联档位网格**。

Pricing 这个组件有**两处**嵌入，两格各扫一处：独立的 `/pricing`（`h1` 之下），和账户
弹窗里 `role="dialog"` 内的那一份。只扫前者就等于宣称这个组件是干净的，而弹窗里那一份
从来没被看过——那是另一套语境、另一种可视宽度、另一种会话状态。

每格都钉死视口、`prefers-color-scheme` 和 `prefers-reduced-motion`，等的是各自的
readySelector 而不是固定 sleep——固定 sleep 在快机器上浪费时间，在慢机器上给出一张
还没画完的页面，然后同一份代码今天绿明天红。readySelector 要选**真正想扫的内容**：
`ready` 加可选的 `readyCount` 判「至少这么多个节点在了」，两个定价格子要的是四张真卡
全到齐，而不是骨架屏还在时的那个容器。

### 定价那两格为什么带一份浏览器端 API 夹具

`vite preview` 只吐 `dist`，`/api/*` 后面什么都没有。于是 `/pricing` 的 `onMount` 拿到
一份 HTML、`res.json()` 抛错、组件停在 loadError 分支——而 `.pricing-page` 这个外壳**照样
在**。这一格因此长期在扫一句红色的错误提示：四张真卡、它们的标题层级、价格排版和 CTA
一个都没进过 axe。那里正好藏着一条真的 `heading-order` 违规（`h1 → h3`），它只在
`/api/plans` 真的解析成功之后才出现，所以这道门一次都没看见过它。

修法是 `a11y-fixtures.mjs`：一段用 `Page.addScriptToEvaluateOnNewDocument` 注进去的
`window.fetch` 补丁，**只**给需要的那两格。不接真后端是有意的——那会给一条纯前端的 CI
门加上 Go 服务器 + 数据库 + 迁移 + 种子数据的依赖，而它们任何一个抖一下，红的都是无障碍
扫描，一个指向完全错误方向的失败。补丁本身守四条纪律（`a11y-fixtures.test.mjs` 逐条钉着）：
认 `Request` 也认字符串/`URL`（`String(new Request(u))` 是 `[object Request]`，只看字符串
会静默失配）、只接管同源 GET、没匹配上的**原样**放行（连参数对象都不重建，重建会悄悄丢掉
`signal`/`credentials`/`body`）、返回真的 `Response`。注入是按标签页会话下发的，而每一格
各开各的标签页，所以夹具不会漏到别的目标上。

拿掉夹具这两格不会变绿，会**超时报错**：readySelector 要的是四张真卡，没有真数据就到不了。

### 规则口径与允许清单

范围是 WCAG 2.0/2.1/2.2 的 A 与 AA，外加 10 条**逐条点名**的 best-practice 规则
（每条在 `a11y-core.mjs` 里都写了为什么要它）。按 tag 圈定范围不是压制违规，它是一条
写下来、可被复核的验收线。

`e2e/a11y-allowlist.json` 目前是**空的**，而且应当保持为空。每条记录必须精确到
「哪个目标、哪条规则、哪个节点」，外加理由、负责人和到期日。三种情况一律判红：
没被认领的违规、**这一轮什么都没匹配到**的陈旧条目、过期条目。通配符和多规则条目在
加载阶段就被拒掉——这张表只能用来记账，不能用来消音。

`incomplete`（axe 自己算不出来的那些，绝大多数是"背景是渐变，测不了对比度"）默认只按
目标/规则聚合计数，**从不判红**；要逐节点看用 `--verbose-incomplete`，`--json` 里永远
是全量。

### 真场景里的那几格（在上面两套 E2E 里）

静态扫描器没有对端也没有信令服务器，所以它永远到不了同意态、进行中的进度条和消息记录
——而那恰好是这个产品里最需要读屏的三个地方：用户正在那里做信任决策。所以
`scanLiveState()`（`a11y-core.mjs` 导出）被挂进了三套真 E2E——但三套里只有
`code-room.mjs` 那一套在 CI 里跑，所以下面这三行的执行状态各不相同，逐条标在后面：

- `lan-transfer.mjs`：文件同意卡（accept 之前）、传输进行中（`role="progressbar"`
  唯一活着的时候）、掉线续传完成后的终态、消息会话（`role="log"` + 输入框）。
  **这四格挂在该脚本的尾巴上，眼下随尾巴一起不执行**（见上面的"现状"）——所以这四个
  真场景的无障碍覆盖目前是空的，迁移完成前不要把它算进任何"已覆盖"的口径。其中
  "传输进行中"那一格已经在 C3b-1 搬进 `mixed-link.mjs`（下一条），并且**本地跑绿过、
  也做过删主体的对抗性变异**（见上面的验证状态表）；剩下的三格仍然是空的。
- `mixed-link.mjs`（CI，`mixed-link-e2e` 作业）：统一工作区头部、390px 下的 40 文件
  同意卡、文本通道同意后两条通道都活着的状态，以及 **C3b-1 新加的**"5 MiB 传输真的
  在进行中"那一格——两个方向各扫一次，context 收在 `XFER.card` 上，而且扫之前先证明
  那条 `role="progressbar"` 确实在。
- `code-room.mjs`（CI）：配对码房间里的统一工作区（390px）、切换到中文后的同一工作区，
  以及文件同意卡。归档阿拉伯语的 RTL 渲染由静态模板与 axe 目标继续覆盖；运行时恢复
  RTL 语言前，需要另行补回工作区逻辑属性镜像门禁。

这一层**不读允许清单**，是有意的：真场景状态本来就少、本来就该干净，接上清单等于给它们
开一条可以静音的口子。有违规就抛，`incomplete` 只打印。

这几格不是摆设——它们上线当天就抓到了静态扫描看不见的四类真问题：进度条没有可访问名、
`<ol role="log">` 顶掉列表语义让 40 个 `<li>` 变成孤儿、消息面板把 `opacity` 叠在本来
就是次要色的 `--text` 上（掉到 3.3:1）、以及 40 文件同意清单滚得动却聚不上焦点。

## `page-shell.mjs` — 托管的页面外壳契约（不是传输契约）

`npm run test:e2e:page-shell`（CI 的 web / test 作业里跑，紧跟 a11y 扫描）

```bash
cd web && npm run build && npm run test:e2e:page-shell
```

四幕，全部单标签页，2026-08-29（Phase 3D C2）从 `lan-transfer.mjs` 搬过来——它们从来
不碰对端卡片、信令或分块传输，测的是页面本身：

1. `authLandingScenario` —— `/magic-link`、`/verify-email`、`/reset-password`：标题
   文字与字号、共享的 `.ui-card`、`canonical` 为空、零条 `hreflang` 备用链接、
   `robots: "noindex, nofollow"`、label 与输入框的对应关系、中性（非报错）输入框边框、
   320px 移动端不溢出且触摸目标 ≥44px（中英文各一遍）。然后导航回 `/`，断言**路由
   隔离**：`canonical`/`og:url` 恢复、3 条 `hreflang`、`robots` 以 `index, follow`
   开头——私密 auth 路由被压制的 SEO head 不能泄漏进公开路由，也不能在离开后残留。
2. `appsHierarchyScenario` —— `/apps` 的卡片模型从 `AppsPage.svelte` 和
   `native-releases.json` **推导**（`appsCardModel`），不是抄一份卡片 id 清单：标题
   层级计数、可用/未来卡片 id、CTA 链接、未来卡片零控件、明暗两个主题下对比度/不透明度
   ≥4.5:1（连同一条钉住的 EXERCISED/NOT-EXERCISED 披露）、390px 下中英文都不溢出、
   真 Tab 键在 `.cmd` 上留下的键盘焦点环。
3. `pricingHierarchyScenario` —— 第一档的位置、价格/标题字号、价格先于长解释出现的
   DOM 顺序、账户控件存在、390px 下 44px 循环切换目标与 `dir="ltr"` 的价格隔离
   （中英文各一遍）。
4. `unsupportedLayoutScenario` —— **当前布局契约**。加载前把 `isSecureContext` 强制
   设为 `false`，断言单列兜底：`.lan-workspace` 不是 `grid`，没有 `two-col`/紧凑英雄区
   类，不支持横幅存在，`.peers` 不存在，零横向溢出。

**不需要 Go 服务器，只对 `vite preview`。** 四幕里没有一条断言依赖真实的 `/api/*`
响应内容：`authLandingScenario` 的三个组件自己的 `onMount` 都不发请求；
`appsHierarchyScenario` 读的是打包进产物的 `native-releases.json`，不是运行时请求；
`pricingHierarchyScenario` 需要 `/api/plans` 解析成功才会渲染卡片，用
`a11y-fixtures.mjs` 已经导出的 `PRICING_ROUTES`（和 `PricingPage.test.ts` 同一份档位
表）在页面自己的进程里同源应答；`unsupportedLayoutScenario` 完全不碰任何 API 调用。
`Nav.svelte`→`Account.svelte` 触发的匿名会话探测（`GET /api/me`）在四条路由上都会打，
但 `refreshSession()` 把任何非 2xx 都当"未登录"处理，不抛异常，所以不需要专门为它
搭一份夹具。

`/api/plans` 因此换了口径：以前 `pricingHierarchyScenario` 打的是真 Go 服务器，现在
量的是这份手工维护的夹具表，和 `server/account/settings.go` 的真实档位定义有第二处
需要人工同步的地方——但这一幕从来只验证**几何**（第一档在折叠线以上、价格/标题字号、
卡片顺序），从不验证金额，所以这不是一次覆盖回归。

反悄悄丢场景：`main()` 按一个写死的 `EXPECTED_SCENARIO_COUNT = 4` 校验跑过的幕数，
而不是拿 `SCENARIOS.length` 自证——删掉数组里一项会让两者一起缩水，那样"3/3"照样
打印成功。`page-shell-contract.test.mjs` 是这条防线的源码层护栏：钉住四个函数名都还在
`SCENARIOS` 里、钉住比较的是这个写死常量、钉住计数循环里没有把某一幕的异常吞掉的
`catch`、也钉住 `.github/workflows/web.yml` 里那一步没有 `if:` 或
`continue-on-error: true`。

### 44px 触摸地板，以及它容忍的那一个渲染器偏差

**状态：修法在 `test/page-shell-touch-rounding`（起点 exact main `9d815c84`）上写好、
本地跑绿，待托管 CI。本小节没有任何一句是托管结论。**

托管 Web 道次 **33290357209**（exact main `9d815c84`）的 `test` job 挂在
`appsHierarchyScenario`：Linux Chromium 把 `/apps` 的 CTA——一个高度只由全局
`@media (pointer: coarse) { .btn { min-block-size: 44px } }` 决定的按钮——量成了
`43.999969482421875`，而那一幕拿这个原始高度去比一个裸 `< 44`。同一份源码在 PR #95
的同一个 job 上是绿的，而且同一次 exact-main 道次里的 `mixed-link-e2e` job 是过的：
挂的是一个 job 的一条断言，不是这个提交。亏的那点是 2⁻¹⁵ px ≈ 0.000031px：
`getBoundingClientRect()` 在合成路径上过了一趟 float32。所以裸 `< 44` 断言的是那台 runner 这一次的浮点尾数，
不是产品几何——它会在一棵没人动过的源码树上反复变色。

让那条道次变绿有两个方向，只有一个是修。**把 44 降下来**、或者**把容差放宽到反正不会
红**，两条都立刻见效，两条都把这条断言悄悄退役掉。所以修法被写成一条可以被测的论证：

- **44px 仍然是写死的要求。** `page-shell.mjs` 里 `MIN_TOUCH_TARGET_PX = 44` 是唯一
  出处，没有任何一处再拿字面量去比。
- **容差有名字，而且它的界不是"够用就行"。** `TOUCH_TARGET_EPSILON_PX = 1 / 1024`
  比观察到的那次偏差宽 32 倍（够吸收尾数），同时**严格小于** Chromium 自己的
  LayoutUnit（1/64 px）。任何在布局层面真的没到 44px 的元素至少亏一个 LayoutUnit，
  所以一条小于这个量子的容差买不到任何一个真实的亏空。实际地板是 43.9990234375px。
- **只有一处比较，而且它 fail closed。** `undersizedTouchTarget()` 是唯一比地板的
  地方，非有限值直接判不合格：空选择器会让 `Math.min(...[])` 返回 `Infinity`，而
  `Infinity >= 44` 为真——"一个都没量到"本来会长得和"全都够大"一模一样。三处触摸测量
  全走它：auth 落地页的 `.auth-action`、`/apps` 的 `.cta`、`/pricing` 的 `.toggle-btn`。
- **`/pricing` 同时丢掉了一条没写下来的 ±0.5px 容差。** 它的 `cycleTargets` 以前是
  `Math.round(height)`——比真正需要的那点尾数宽 512 倍，足以放过一个 43.5px 的控件。
  现在量原始高度、共用那一处比较，而且量到零个挡位是红的，不是白过。

`apps-hierarchy-contract.test.mjs` 把这条论证钉成源码契约，于是那两个省事的"非修法"
都是红的：它从 `page-shell.mjs` 里读出两个常量的**值**，断言 `44` 恰好、并且
`观察偏差 < epsilon < 1/64`；断言 fail-closed 那一笔和三处调用点都在；并且在挖掉比较
函数、去掉注释之后，断言整份源码里不再有第二处拿地板或一个新抄的 `44` 去比。常量若
写成它读不懂的表达式，判红而不是跳过。

**复查触发条件：** 如果某次托管跑报出一个落在这个界之外的测量——亏得比 1/1024px 多、
又不到一个 LayoutUnit——那 float32 这个解释就盖不住了。先去查渲染器，别先动这两个数；
把 epsilon 放宽过 1/64，正是这些契约存在的意义所在。

## `code-room.mjs` — 配对码房间里的同一套统一工作区

`npm run test:e2e:code-room`（CI 的 web / test 作业里跑，紧跟 build 与 a11y 扫描）

```bash
cd web && npm run build && npm run test:e2e:code-room
#   换端口：--port 4184
#   留证据：--screenshots [目录]（默认 web/e2e-screenshots，已 gitignore）
#   调试：  --keep 保留 Chrome 的临时 profile
```

这个脚本跑**三幕**，各用各的房间码（BroadcastChannel 是按房间字符串分的，共用一个码
会让上一幕没关干净的标签页混进来，变成偶发红）：

1. `483920` —— 统一工作区本身：一个动作、一条链路、一个 SAS、两条通道、中英文与断开。
2. `915273` —— **预置队列**遇上统一对端。走的是产品里"先选文件、再铸码"那条真入口
   （所以这一幕的发方是**登录**状态，`/api/pair` 也被夹具答掉）。它钉的是那个洞：
   确认栏在对端刚进房的那一刻就弹出来，而链路——以及它让人核对的那串校验码——那时
   还不存在。此刻栏里**不该有发送按钮**，只有"打开工作区"；打开工作区建链路、出
   SAS，但一个字节都不排空；然后按一次取消，验证工作区里那条常驻的重新武装路径；
   最后确认发送，字节按 SHA-256 核对。
3. `604118` —— **相关性丢失**：传输进行中，把收方的**信令** socket 单独掐掉
   （`window.__e2eDropSignaling()`，页面和 DataChannel 一个字不动）。房间因此给发方
   发一帧 `left`。发方必须**留着**那条健康的链路（头部还在、SAS 还是那一个），只是
   如实告知它掉了就回不来了；而正在传的那个文件必须照样传完、字节对得上。这是这条
   不变式在真浏览器里唯一能被制造出来的样子。

**不需要 Go 服务器**，也不需要账号（第二幕的"登录"同样是夹具答的）。缺的服务器职责由
`code-room-fixture.mjs` 在页面里补上：

- **会合**：`window.WebSocket` 被换成一条 BroadcastChannel 上的假房间，按
  `docs/protocol/relayium-signaling-v1.md` 复刻 join/welcome/peers/signal/left 这五帧
  ——**只**复刻这五帧。两个标签页的 peer id 是**显式**给的（`aaaa1111` / `bbbb2222`），
  因为 initiator/responder 按 `selfId < peerId` 定，随机 id 会让角色分配每次运行都不同，
  一个只在某一半角色上出现的回归就变成偶发红。
- **ICE**：`/api/ice` 返回**空**的 iceServers，于是两个标签页用 host 候选在环回上直连。
- **账号与铸码**（只有第二幕用）：`/api/me` 给一个已登录用户，`POST /api/pair` 答一个
  固定的码。这两样是"先选文件、再铸码"那条入口的前置条件，本来就是服务器的职责。
- **单独掐信令**（只有第三幕用）：`window.__e2eDropSignaling()` 关掉这个标签页的假
  socket（房间因此广播它走了），并且**不让它连回来**——真实世界里重连拿到的是一个新
  的 peer id，让夹具用同一个 id 连回来会把那一幕变成另一回事。

页面本身是原样的构建产物，跑原样的策略；产品里没有因此多出任何开关。它证明的是：一个
配对码房间里的升级过的对端，拿到的是和 LAN 一样的**一个**主动作 `.open-workspace`；
它打开的工作区默认就有草稿框、下面挂着发送文件/发送文件夹；一条链路只有**一个** SAS
（整页只有一个 `.sas`，通道卡片里一个都没有）；文本和一个真文件走**同一条**连接、
收方仍然独立同意、落盘字节按 SHA-256 逐一核对；中文下 390px 不横向溢出；
断开之后两边的工作区都收走、选择器回来、房间还在；一个预置的批次在**校验码出现之前
没有任何办法被放走**；以及对端的信令没了不等于那条数据通道没了。

它**不**证明的：服务器对配对码的准入、TURN 中继本身、以及中继凭据的到期边界
（理由见开头那两条"覆盖不到"）。
