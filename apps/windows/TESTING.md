# Windows 本机自动验收

Windows 电脑不必连接开发用的 Mac。两边检出同一 Git 提交，在 Windows
本机运行下面的命令，交回证据目录即可。当前客户端仍在开发，没有公开签名发行。

当前对齐目标是 macOS 1.5.2 (50)，参见 [候选范围](CURRENT-PARITY.md)。
执行前需要交付方给出已完成审查的完整提交号；不要把旧测试包当作当前候选。

## 准备

使用独立的测试 checkout，保持工作区干净；不要在正在编辑的目录里运行。
需要 Git、Node.js **24**（官方签名 Windows 安装包）、Go（版本看
`native/go.mod`，当前最低 1.26.11）和 PowerShell **7**（`pwsh`）。
使用普通用户、可见桌面会话，允许测试窗口短暂打开；不要以管理员身份运行。
请先自行安装这些工具，测试脚本不会安装系统软件或要求提权。

在仓库根目录用 PowerShell 运行：

```powershell
git status --short
git rev-parse HEAD
node --version
go version
pwsh --version
npm ci --prefix web
if ($LASTEXITCODE -ne 0) { throw 'web dependencies failed' }
npm ci --prefix apps/windows
if ($LASTEXITCODE -ne 0) { throw 'Windows dependencies failed' }
Set-Location apps/windows
npm run qa
$qaExit = $LASTEXITCODE
Write-Host "QA exit: $qaExit"
```

依赖安装必须使用现有 lockfile。不要用 `npm install`、升级依赖、关闭签名检查、
修改断言或扩大超时来让测试变绿。若工具不存在，记录缺失项后停止。

## 自动执行的内容

| 检查 | 本机行为及证据 |
|---|---|
| 来源 | 必须是干净 Git checkout；记录完整提交、OS、架构、Node版本 |
| Windows原生准备 | 验证 Node 的 Authenticode 签名，构建三个 Go helper |
| 原生测试 | 真实 Windows 文件句柄、路径防护、DPAPI与更新验证；记录逐个跳过项 |
| 类型／单元／构建 | 执行现有完整 Windows 客户端检查和单元测试；保留 Vitest原始JSON |
| 界面冒烟 | 主窗口、驻留生命周期、文件入口、配对交接、账号、更新、Inbox、LAN和Link页面 |
| 本机服务 | 现有 SQLite冷启动和 Inbox真实服务端 fixture，使用测试数据 |
| 密钥持久性 | 独立临时profile的正常退出／强制退出及第二实例矩阵 |

测试使用临时目录和合成文件；密钥持久性矩阵仅结束它自己启动的进程。
不会安装或卸载 Relayium、修改开机启动、创建系统账户、挂载卷、
操作真实账号或连接线上生产后台。现有界面测试中的登录／更新交互是隔离fixture，
不是个人账号或公开更新渠道的验收。

首个失败即停止，后续步骤在 `notRun` 列表中，不允许使用失败构建留下的旧产物。
测试可能下载 Go依赖；网络／依赖／工具失败也是失败，不能标为应用测试通过。

## 结果与交回

开头会打印 `Evidence: ...`，目录位于当前用户临时目录，每次运行新建，结束后保留。
包含 `report.json`、逐步原始日志、原生测试stdout和单元JSON。只打包这次目录，
不要打包个人App数据、登录凭据或整个用户目录。日志含本机路径，分享前检查隐私。

| 退出码／状态 | 含义 |
|---|---|
| `0` / `PASS` | 所选profile执行成功，无已报告的原生／单元跳过 |
| `2` / `PASS_WITH_SKIPS` | 已执行的检查通过，但有未验证项；逐项查看 `tests.skipped` |
| `1` / `FAIL` | 检查失败；查看失败步骤日志和 `notRun` |
| `2` / 无报告 | 平台、参数、Node、npm或Git前置条件不满足，保留终端错误 |
| `RUNNING` | 中断或尚未结束，不能称通过 |

普通用户环境常缺少跨用户DPAPI和卷挂载fixture，所以出现明确的SKIP是预期边界，
不是可以删掉的测试；脚本不会替你创建用户／挂载卷去消除它们。

Mac只运行可移植检查：

```sh
npm run qa -- --profile=portable
```

该profile只检查类型、单元、构建，**不证明Windows原生或界面行为**。
默认命令在非Windows上直接拒绝。每份报告都附带验收限制。

## 给 Windows 上 AI 的任务

此次对齐新增的关键场景已经纳入单元、真实服务与界面测试：

- Share：先完成密文准备，再上传；回包丢失后恢复原任务，保持原密钥和原字节，
  不重复创建或计量；明确区分暂停、未确认和已发布。
- 设备 Inbox：按设备隔离会话和未发送草稿，准确复制完整文本；移除设备后保留历史名称；
  旧记录不猜测发送方；删除确认期间的新到达记录不被删除。
- Inbox：重启后只发现恢复项，不自动重发；拒绝过期确认；排队中可以取消，
  接收中拒绝取消，已保存不显示成取消；临时文件清理失败时保留密钥和恢复信息。

以下需要实际 Windows 桌面，自动测试不能代替人工观察：Explorer 入口、托盘隐藏后接收、
系统通知、开机启动开关、休眠唤醒、中文路径、键盘/Narrator，以及100%/150%/200%缩放。
真实异网、NAT/TURN和个人账号传输需另行安排；不要为了跑测试自行登录、付费、
安装证书或绕过 SmartScreen。未签名测试目录不等于安装器、升级或签名验证通过。

将以下文字交给Windows本机AI，替换预期提交号：

> 请只做Relayium Windows验收，不修改源码或系统设置。按
> `apps/windows/TESTING.md` 执行。先核对HEAD等于 `<预期完整提交号>`、工作区干净，
> 核对Git、Node24、Go与pwsh前置条件。已有依赖也按lockfile安装，逐条检查退出码。
> 使用普通用户和桌面会话运行 `npm run qa`，不要启动真实账号传输。
> 不重试来掩盖失败，不改测试、超时、签名检查、依赖、注册表、杀毒或防火墙，
> 不安装／卸载Relayium、不创建账户、不挂载卷、不终止非本次测试进程。
> 失败时保留第一次日志，分析到具体步骤即可；修复建议另写，不直接改代码。
> 返回HEAD、OS／架构、最终退出码、report.json、日志目录压缩包，以及全部SKIP和notRun。
> 如果卡住，记录进程／最后输出并报告未完成；不要通过杀进程后将其标为成功。

## 仍独立待验收的内容

本命令不覆盖签名安装／覆盖升级／卸载、真实Explorer关联和系统启动项、
真实账号、不同电脑间LAN／WAN及睡眠唤醒。安装器验收会改本机安装状态，
只适合另行选定的测试环境；不要在个人电脑上直接照搬CI的安装步骤。

Windows stored-upload丢失PATCH响应后的窗口恢复问题仍为已知HOLD；
本次测试入口不修改其上传／计量逻辑，也不把自动检查通过当作该问题已修复。
真实Windows测试结果回来后，再据其证据安排下一轮修复。
