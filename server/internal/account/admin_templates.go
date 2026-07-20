package account

import (
	"html/template"
	"strconv"
	"time"
)

type adminSettingsView struct {
	MaxFileSizeMB int64
	DailyQuotaMB  int64
	DefaultTTLHrs int64
	MaxTTLHrs     int64
	// DefaultRetention: 0=burn, 1=ttl, 2=count (see retentionBurn/TTL/Count).
	DefaultRetention       int64
	DefaultMaxDownloads    int64
	MaxMaxDownloads        int64
	StorageDiskCapMB       int64 // global logical storage ceiling (MiB); 0 = unlimited
	DisableCentralFallback bool  // when true, uploads never fall back to the app server's own disk
	NodeTrafficDefaultGB   int64 // default monthly relay traffic cap for official nodes (GB); 0 = unlimited
}

type adminHomeData struct {
	Metrics     AdminMetrics
	Users       []AdminUserRow
	Total       int64
	Page        int
	TotalPages  int
	Search      string
	Sort        string
	Dir         string
	Period      string            // 选定月 'YYYYMM'
	Months      []string          // 最近 12 个月（下拉，最新在前）
	PrevHref    string            // empty = no previous page
	NextHref    string            // empty = no next page
	SortHref    map[string]string // column key ("created"/"email"/"relayed"/"upload"/"download"/"storage") -> sort link on click
	Nodes       []adminNodeView
	Plans       []planView
	ActivePlans []planView // subset of Plans with Active==true; used for the per-user plan dropdown
	Settings    adminSettingsView
	// Passkeys are the registered admin credentials, listed so a never-used
	// entry (an attacker's planted credential) is visible. PasskeysErr marks a
	// failed read so the template can show an error instead of an empty table —
	// "could not read" must never be mistaken for "none registered".
	Passkeys    []AdminCredential
	PasskeysErr bool

	FleetTokens      []adminFleetTokenView
	FleetNodeCount   int    // count of Nodes with OwnerType == "fleet" (matches table body's guard)
	MintedToken      string // set once, right after minting; shown inline then gone
	MintedInstallCmd string // install one-liner for the freshly minted token
	// CentralStoredBytes is the ciphertext currently held on the app server's own
	// disk (node_id unset) — the default fallback store, shown so the operator can
	// see how much rides on central and decide whether to disable it.
	CentralStoredBytes int64
}

type adminFleetTokenView struct {
	ID         string
	Name       string
	NodeID     string
	CreatedAt  int64
	LastUsedAt int64
}

type adminLoginData struct {
	Error   string
	TOTP    bool // render the 6-digit code field
	Passkey bool // render the passkey button (only when a credential exists)
}

// passkeyB64JS is the base64url <-> ArrayBuffer pair WebAuthn needs on both the
// login page and the dashboard. Defined once here and pulled into each page's
// inline <script> with {{template "passkeyB64"}}, so the two never drift apart.
const passkeyB64JS = `{{define "passkeyB64"}}
  function dec(s){
    s = s.replace(/-/g,'+').replace(/_/g,'/');
    var pad = s.length % 4 ? '='.repeat(4 - s.length % 4) : '';
    var bin = atob(s + pad), out = new Uint8Array(bin.length);
    for (var i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function enc(buf){
    var b = new Uint8Array(buf), s = '';
    for (var i=0;i<b.length;i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
{{end}}`

// withPasskeyJS associates the shared passkeyB64 snippet with t. Both admin
// pages are parsed separately, so each has to be given its own association.
func withPasskeyJS(t *template.Template) *template.Template {
	return template.Must(t.Parse(passkeyB64JS))
}

var adminLoginTmpl = template.Must(withPasskeyJS(template.New("login")).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin</title>
<style>:root{--a:#7c3aad;--bg:#faf9fb;--fg:#1a1420;--bd:#e5e4e7;--card:#fff;--muted:#6b6375}
@media(prefers-color-scheme:dark){:root{--a:#c084fc;--bg:#16171d;--fg:#f3f4f6;--bd:#2e303a;--card:#1c1d25;--muted:#9ca3af}}
*{box-sizing:border-box}
body{font:15px system-ui;max-width:360px;margin:80px auto;padding:0 16px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0 0 16px}
form{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px}
input{font:inherit;padding:9px 11px;width:100%;margin:6px 0;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;font-weight:500;padding:10px 11px;width:100%;margin:10px 0 0;border:0;border-radius:8px;background:var(--a);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.07)}
:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.err{color:#e5484d;margin:0 0 10px}
.muted{color:var(--muted);margin:0 0 10px}
[hidden]{display:none!important}</style></head>
<body><h1>Relayium 后台</h1>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<form method="post" action="/admin/login">
<input type="text" name="username" placeholder="管理员账号" autofocus autocomplete="username">
<input type="password" name="password" placeholder="管理员密码" autocomplete="current-password">
{{if .TOTP}}<input type="text" name="totp" placeholder="6 位验证码" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6">{{end}}
<button type="submit">登录</button>
</form>
{{if .Passkey}}
<button type="button" id="passkey-login" style="margin-top:12px;background:transparent;color:var(--a);border:1px solid var(--bd)">使用 passkey 登录</button>
<p class="err" id="passkey-error" style="margin-top:10px" hidden></p>
<script>
(function(){
  var btn = document.getElementById('passkey-login');
  var err = document.getElementById('passkey-error');
  // Progressive enhancement: on anything without WebAuthn the button vanishes
  // and the password form above is untouched.
  if (!window.PublicKeyCredential || !navigator.credentials) { btn.hidden = true; return; }
{{template "passkeyB64"}}
  btn.addEventListener('click', function(){
    err.hidden = true; btn.disabled = true;
    fetch('/admin/passkey/login/begin', {method:'POST'})
      .then(function(r){
        if (r.ok) return r.json();
        // A non-JSON body (a proxy's 502 page) must not surface as a parser
        // error; fall back to the status so the operator can diagnose it.
        return r.json().then(function(j){ return j.error; }, function(){ return null; })
          .then(function(m){ throw new Error(m || '服务器错误 ' + r.status); });
      })
      .then(function(o){
        var pk = o.publicKey;
        pk.challenge = dec(pk.challenge);
        if (pk.allowCredentials) pk.allowCredentials.forEach(function(c){ c.id = dec(c.id); });
        return navigator.credentials.get({publicKey: pk});
      })
      .then(function(c){
        return fetch('/admin/passkey/login/finish', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            id: c.id, rawId: enc(c.rawId), type: c.type,
            response: {
              clientDataJSON: enc(c.response.clientDataJSON),
              authenticatorData: enc(c.response.authenticatorData),
              signature: enc(c.response.signature),
              userHandle: c.response.userHandle ? enc(c.response.userHandle) : null
            }
          })
        });
      })
      .then(function(r){
        if (r.ok) { location.href = '/admin'; return; }
        return r.json().then(function(j){ return j.error; }, function(){ return null; })
          .then(function(m){ throw new Error(m || '验证失败（服务器 ' + r.status + '）'); });
      })
      .catch(function(e){
        btn.disabled = false;
        if (e && e.name === 'NotAllowedError') {
          // WebAuthn fuses "user cancelled" and "no usable credential here"
          // into one NotAllowedError on purpose (it refuses to let a page
          // enumerate who is enrolled), and nothing on the client can split
          // them back apart. So say the one thing true of both, in muted text
          // rather than red: neither case is a failure the operator caused.
          err.className = 'muted';
          err.textContent = '已取消，或这台设备上没有可用的 passkey。可用下方密码登录后在设置里添加';
        } else {
          err.className = 'err';
          err.textContent = (e && e.message) || '登录失败，请改用下方密码登录';
        }
        err.hidden = false;
      });
  });
})();
</script>
{{end}}
</body></html>`))

var adminUsersTmpl = template.Must(withPasskeyJS(template.New("users").Funcs(template.FuncMap{
	"ts":    func(sec int64) string { return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04") },
	"bytes": humanBytes,
	"gib":   func(b int64) int64 { return b / (1 << 30) },
	"period": func(p string) string {
		if t, err := time.Parse("200601", p); err == nil {
			return t.Format("2006-01")
		}
		return p
	},
})).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin · 用户</title>
<style>:root{--a:#7c3aad;--bg:#faf9fb;--fg:#1a1420;--muted:#6b6375;--bd:#e5e4e7;--card:#fff;--soft:#f4f3ec}
@media(prefers-color-scheme:dark){:root{--a:#c084fc;--bg:#16171d;--fg:#f3f4f6;--muted:#9ca3af;--bd:#2e303a;--card:#1c1d25;--soft:#1f2028}}
*{box-sizing:border-box}
body{font:14px system-ui;margin:0 auto;max-width:1080px;padding:24px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px}
button{font:inherit;font-weight:500;padding:8px 14px;border:0;border-radius:8px;background:var(--a);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.07)}
:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 28px}
.card{border:1px solid var(--bd);border-radius:12px;padding:14px 18px;min-width:150px;background:var(--card)}
.card .n{font-size:22px;font-weight:600;color:var(--a)}.card .l{color:var(--muted);font-size:12px;margin-top:4px}
.settings{margin:0 0 28px}.settings h2{margin-bottom:12px}
.settings .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;max-width:520px}
.settings label{display:flex;flex-direction:column;font-size:13px;gap:4px;color:var(--muted)}
.settings input{font:inherit;padding:7px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg)}
.settings button{grid-column:1/-1;width:max-content}
.search{display:flex;gap:8px}
.search input[type=text]{font:inherit;padding:7px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg)}
table{border-collapse:separate;border-spacing:0;width:100%;background:var(--card);border:1px solid var(--bd);border-radius:12px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--bd)}
th{background:var(--soft);font-weight:600;font-size:13px}
tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--soft)}
th a{text-decoration:none;color:inherit}th a:hover{color:var(--a)}
.pager{display:flex;gap:16px;align-items:center;margin:18px 0}
.pager a{color:var(--a);text-decoration:none}.pager a:hover{text-decoration:underline}
.pager .off{color:var(--muted);opacity:.55}
.mint{display:flex;gap:8px;margin:12px 0}
.mint input{font:inherit;padding:7px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg)}
.minted{background:var(--soft);border:1px solid var(--bd);border-radius:10px;padding:12px 14px;margin:12px 0}
.minted pre{white-space:pre-wrap;word-break:break-all;background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:8px}
.lim{display:flex;gap:6px;align-items:center}
.lim input{width:70px;font:inherit;padding:5px 7px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg)}
.lim button,td .danger{padding:5px 10px;font-size:12px}
.plan-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.plan-row input,.plan-row button{font:inherit;padding:5px 7px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg)}
.plan-row input[type=text]{width:110px}
.plan-row input[type=number]{width:70px}
.plan-row button{background:var(--a);color:#fff;border:0;cursor:pointer;font-size:12px}
.plan-row label{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted)}
.danger{background:#e5484d}
.passkeys{margin:0 0 28px}.passkeys h2{margin-bottom:12px}
.passkeys .mint{flex-wrap:wrap;margin-top:12px}
.never{color:#e5484d;font-weight:600}
.err{color:#e5484d;margin:10px 0 0}
/* [hidden] alone loses to .mint's display:flex, so state it outright. */
[hidden]{display:none!important}</style></head>
<body>
<div class="top"><h1>后台概览</h1>
<form method="post" action="/admin/logout"><button type="submit">退出</button></form></div>

<section class="cards">
<div class="card"><div class="n">{{.Metrics.TotalUsers}}</div><div class="l">总用户数</div></div>
<div class="card"><div class="n">{{.Metrics.ActiveStoredFiles}}</div><div class="l">未过期暂存文件</div></div>
<div class="card"><div class="n">{{bytes .Metrics.ActiveStoredBytes}}</div><div class="l">占用存储(近似)</div></div>
<div class="card"><div class="n">{{bytes .Metrics.UploadBytes}}</div><div class="l">上传 · {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.DownloadBytes}}</div><div class="l">下载 · {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.RelayBytes}}</div><div class="l">中继 · {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .CentralStoredBytes}}</div><div class="l">中央本地存储{{if .Settings.DisableCentralFallback}}（已关闭兜底）{{end}}</div></div>
</section>

<section class="nodes">
<h2>官方节点（{{.FleetNodeCount}}）</h2>

{{if .MintedToken}}
<div class="minted">
<p>新节点 Token（仅显示一次，请立即复制）：</p>
<pre>{{.MintedToken}}</pre>
<p>在官方服务器上执行以下命令安装并启动节点：</p>
<pre>{{.MintedInstallCmd}}</pre>
</div>
{{end}}

<form method="post" action="/admin/nodes/token" class="mint">
<input type="text" name="name" placeholder="节点备注名（如 cn-shanghai-1）">
<button type="submit">生成节点 Token</button>
</form>

<table>
<thead><tr><th>备注 / ID</th><th>IP</th><th>区域</th><th>状态</th><th>中继(本月/累计) / 上限</th><th>存储 / 硬盘上限</th><th>盘 剩余/总量</th><th>可存储(70%)</th><th>版本</th><th>备注名 · 限额(GB)</th><th></th></tr></thead>
<tbody>
{{range .Nodes}}{{if eq .OwnerType "fleet"}}
<tr>
<td>{{if .Label}}<b>{{.Label}}</b><br>{{end}}<span style="color:var(--muted);font-size:12px">{{.ID}}</span></td>
<td>{{if .Host}}{{.Host}}{{else}}—{{end}}</td>
<td>{{.Region}}</td>
<td>{{if .Online}}在线{{else}}离线{{end}}</td>
<td>{{bytes .MonthRelayedBytes}} / {{bytes .RelayedBytes}} / {{if .EffectiveTrafficLimitBytes}}{{bytes .EffectiveTrafficLimitBytes}}{{else}}∞{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StoredBytes}}{{else}}—{{end}} / {{if .DiskLimitBytes}}{{bytes .DiskLimitBytes}}{{else}}∞{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StorageFree}} / {{bytes .StorageTotal}}{{else}}—{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .UsableBytes}}{{else}}—{{end}}</td>
<td>{{.Version}}</td>
<td>
<form method="post" action="/admin/nodes/{{.ID}}/label" class="lim">
<input type="text" name="label" value="{{.Label}}" placeholder="备注名" title="节点备注名" style="width:110px">
<button type="submit">改名</button>
</form>
<form method="post" action="/admin/nodes/{{.ID}}/limits" class="lim">
<input type="number" name="traffic_limit_gb" min="0" value="{{gib .TrafficLimitBytes}}" title="流量上限 GB/月，0=用全局默认">
<input type="number" name="disk_limit_gb" min="0" value="{{gib .DiskLimitBytes}}" title="硬盘上限 GB，0=无限">
<button type="submit">保存</button>
</form>
</td>
<td><form method="post" action="/admin/nodes/{{.ID}}/delete" onsubmit="return confirm('删除该官方节点？')"><button type="submit" class="danger">删除</button></form></td>
</tr>
{{end}}{{end}}
</tbody></table>

{{if .FleetTokens}}
<h2>活跃节点 Token（{{len .FleetTokens}}）</h2>
<table>
<thead><tr><th>备注名</th><th>创建时间(UTC)</th><th>最后使用</th><th>绑定节点</th><th></th></tr></thead>
<tbody>
{{range .FleetTokens}}
<tr>
<td>{{.Name}}</td><td>{{ts .CreatedAt}}</td>
<td>{{if .LastUsedAt}}{{ts .LastUsedAt}}{{else}}—{{end}}</td>
<td>{{if .NodeID}}{{.NodeID}}{{else}}—{{end}}</td>
<td><form method="post" action="/admin/nodes/token/{{.ID}}/revoke" onsubmit="return confirm('撤销该 Token？')"><button type="submit" class="danger">撤销</button></form></td>
</tr>
{{end}}
</tbody></table>
{{end}}
</section>

<section class="plans">
<h2>套餐（{{len .Plans}}）</h2>
<table>
<thead><tr><th>ID</th><th>名称</th><th>存储(MB)</th><th>流量(GB/月)</th><th>暂存天数</th><th>月付(分)</th><th>年付(分)</th><th>排序</th><th>启用</th><th>Stripe 月付价格ID</th><th>Stripe 年付价格ID</th><th></th></tr></thead>
<tbody>
{{range .Plans}}
<tr><td colspan="12">
<form method="post" action="/admin/plans" class="plan-row">
<input type="hidden" name="id" value="{{.ID}}">
<span>{{.ID}}</span>
<input type="text" name="name" value="{{.Name}}" title="名称" required>
<input type="number" name="storage_mb" min="0" value="{{.StorageMB}}" title="存储(MB)">
<input type="number" name="traffic_gb" min="0" value="{{.TrafficGB}}" title="流量(GB/月)">
<input type="number" name="retention_days" min="0" value="{{.RetentionDays}}" title="暂存天数">
<input type="number" name="price_monthly_cents" min="0" value="{{.PriceMonthlyCents}}" title="月付(分)">
<input type="number" name="price_yearly_cents" min="0" value="{{.PriceYearlyCents}}" title="年付(分)">
<input type="number" name="sort_order" min="0" value="{{.SortOrder}}" title="排序">
<label><input type="checkbox" name="active" value="1"{{if .Active}} checked{{end}}> 启用</label>
<input type="text" name="stripe_price_monthly_id" value="{{.StripePriceMonthlyID}}" title="Stripe 月付价格ID" placeholder="price_...">
<input type="text" name="stripe_price_yearly_id" value="{{.StripePriceYearlyID}}" title="Stripe 年付价格ID" placeholder="price_...">
<button type="submit">保存</button>
</form>
</td></tr>
{{end}}
</tbody></table>
</section>

<section class="settings">
<h2>暂存传输设置</h2>
<form method="post" action="/admin/settings" class="grid">
<label>单文件上限 (MiB)<input type="number" name="max_file_size_mb" min="1" value="{{.Settings.MaxFileSizeMB}}"></label>
<label>每账号每日额度 (MiB)<input type="number" name="daily_quota_mb" min="1" value="{{.Settings.DailyQuotaMB}}"></label>
<label>默认有效期 (小时)<input type="number" name="default_ttl_hours" min="1" value="{{.Settings.DefaultTTLHrs}}"></label>
<label>最长有效期 (小时)<input type="number" name="max_ttl_hours" min="1" value="{{.Settings.MaxTTLHrs}}"></label>
<label>默认保留策略<select name="default_retention">
<option value="0"{{if eq .Settings.DefaultRetention 0}} selected{{end}}>阅后即焚</option>
<option value="1"{{if eq .Settings.DefaultRetention 1}} selected{{end}}>保存N天</option>
<option value="2"{{if eq .Settings.DefaultRetention 2}} selected{{end}}>限定次数</option>
</select></label>
<label>默认下载次数上限<input type="number" name="default_max_downloads" min="1" value="{{.Settings.DefaultMaxDownloads}}"></label>
<label>下载次数上限的上限<input type="number" name="max_max_downloads" min="1" value="{{.Settings.MaxMaxDownloads}}"></label>
<label>全局存储上限 (MiB，0=无限)<input type="number" name="storage_disk_cap_mb" min="0" value="{{.Settings.StorageDiskCapMB}}"></label>
<label>节点默认流量上限 (GB/月，0=不限)<input type="number" name="node_traffic_default_gb" min="0" value="{{.Settings.NodeTrafficDefaultGB}}"></label>
<label style="flex-direction:row;align-items:center;gap:8px;grid-column:1/-1"><input type="checkbox" name="disable_central_fallback" value="1" style="width:auto"{{if .Settings.DisableCentralFallback}} checked{{end}}>关闭中央兜底：无可用存储节点时上传直接失败，不再落到本站服务器磁盘</label>
<button type="submit">保存设置</button>
</form>
</section>

<section class="passkeys">
<h2>Passkey 登录{{if not .PasskeysErr}}（{{len .Passkeys}}）{{end}}</h2>
{{if .PasskeysErr}}
<p class="err">凭据列表读取失败，请查看服务端日志</p>
{{else}}
<table>
<thead><tr><th>名称</th><th>添加时间(UTC)</th><th>最后使用</th><th></th></tr></thead>
<tbody>
{{range .Passkeys}}
<tr>
<td>{{.Name}}</td>
<td>{{ts .CreatedAt}}</td>
<td>{{if .LastUsedAt}}{{ts .LastUsedAt}}{{else}}<span class="never">从未使用</span>{{end}}</td>
<td><form method="post" action="/admin/passkey/delete" onsubmit="return confirm('删除这枚 passkey？')">
<input type="hidden" name="id" value="{{.ID}}"><button type="submit" class="danger">删除</button></form></td>
</tr>
{{else}}
<tr><td colspan="4">尚未添加 passkey</td></tr>
{{end}}
</tbody></table>
{{end}}

<form id="passkey-add" class="mint" hidden>
<input type="text" name="name" placeholder="设备名称，如 MacBook" required>
<input type="text" name="username" placeholder="管理员账号" autocomplete="username" required>
<input type="password" name="password" placeholder="管理员密码" autocomplete="current-password" required>
<input type="text" name="totp" placeholder="6 位验证码（如已启用）" inputmode="numeric" autocomplete="one-time-code">
<button type="submit">添加 passkey</button>
</form>
<p class="err" id="passkey-add-error" hidden></p>
<script>
(function(){
  var form = document.getElementById('passkey-add');
  var err = document.getElementById('passkey-add-error');
  // The form ships hidden and is revealed only here, so a browser without
  // WebAuthn (or with JS off) never shows a control that cannot work.
  if (!window.PublicKeyCredential || !navigator.credentials) return;
{{template "passkeyB64"}}
  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    err.hidden = true;
    fetch('/admin/passkey/register/begin', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams(new FormData(form)).toString()
    })
      .then(function(r){
        if (r.ok) return r.json();
        return r.json().then(function(j){ return j.error; }, function(){ return null; })
          .then(function(m){ throw new Error(m || '验证失败（服务器 ' + r.status + '）'); });
      })
      .then(function(o){
        var pk = o.publicKey;
        pk.challenge = dec(pk.challenge);
        pk.user.id = dec(pk.user.id);
        if (pk.excludeCredentials) pk.excludeCredentials.forEach(function(c){ c.id = dec(c.id); });
        return navigator.credentials.create({publicKey: pk});
      })
      .then(function(c){
        return fetch('/admin/passkey/register/finish', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            id: c.id, rawId: enc(c.rawId), type: c.type,
            response: {
              clientDataJSON: enc(c.response.clientDataJSON),
              attestationObject: enc(c.response.attestationObject)
            }
          })
        });
      })
      .then(function(r){
        if (r.ok) { location.reload(); return; }
        return r.json().then(function(j){ return j.error; }, function(){ return null; })
          .then(function(m){ throw new Error(m || '注册失败（服务器 ' + r.status + '）'); });
      })
      .catch(function(e){
        // Cancelling the platform prompt is a normal action, not an error.
        if (e && e.name === 'NotAllowedError') return;
        err.textContent = (e && e.message) || '注册失败';
        err.hidden = false;
      });
  });
  // Revealed only now that the handler is attached, so the form can never be
  // submitted as a plain GET by a half-initialised page.
  form.hidden = false;
})();
</script>
</section>

<div class="top"><h2>用量月份</h2>
<form method="get" action="/admin" class="search">
<input type="hidden" name="q" value="{{.Search}}"><input type="hidden" name="sort" value="{{.Sort}}"><input type="hidden" name="dir" value="{{.Dir}}">
<select name="period" onchange="this.form.submit()">
{{$sel := .Period}}{{range .Months}}<option value="{{.}}"{{if eq . $sel}} selected{{end}}>{{period .}}</option>{{end}}
</select>
<noscript><button type="submit">切换</button></noscript>
</form></div>

<div class="top"><h2>注册用户（{{.Total}}）</h2>
<form method="get" action="/admin" class="search">
<input type="text" name="q" value="{{.Search}}" placeholder="搜索邮箱或显示名">
<input type="hidden" name="sort" value="{{.Sort}}"><input type="hidden" name="dir" value="{{.Dir}}"><input type="hidden" name="period" value="{{.Period}}">
<button type="submit">搜索</button>
</form></div>

<table><thead><tr>
<th><a href="{{index .SortHref "email"}}">邮箱</a></th>
<th>显示名</th>
<th><a href="{{index .SortHref "created"}}">注册时间(UTC)</a></th>
<th>登录方式</th><th>设备</th>
<th><a href="{{index .SortHref "upload"}}">上传</a></th>
<th><a href="{{index .SortHref "download"}}">下载</a></th>
<th><a href="{{index .SortHref "relayed"}}">中继</a></th>
<th><a href="{{index .SortHref "storage"}}">当前存储占用</a></th>
<th>套餐</th>
<th>订阅来源</th>
</tr></thead><tbody>
{{$plans := .ActivePlans}}
{{range .Users}}<tr>
<td>{{.Email}}</td><td>{{.DisplayName}}</td><td>{{ts .CreatedAt}}</td>
<td>{{range $i, $m := .Methods}}{{if $i}}, {{end}}{{$m}}{{end}}</td>
<td>{{.DeviceCount}}</td>
<td>{{bytes .UploadBytes}}</td><td>{{bytes .DownloadBytes}}</td>
<td>{{bytes .RelayedBytes}}</td><td>{{bytes .StorageBytes}}</td>
<td>
<form method="post" action="/admin/users/plan" class="plan-row">
<input type="hidden" name="user_id" value="{{.ID}}">
<select name="plan_id">
{{$cur := .PlanID}}{{range $plans}}<option value="{{.ID}}"{{if eq .ID $cur}} selected{{end}}>{{.Name}}</option>{{end}}
</select>
<button type="submit">分配</button>
</form>
</td>
<td>{{if eq .PlanSource "admin"}}{{.PlanID}} · admin{{else if eq .PlanSource "stripe"}}{{.PlanID}} · stripe/{{.SubscriptionStatus}}{{else}}—{{end}}</td>
</tr>{{end}}
</tbody></table>

<div class="pager">
{{if .PrevHref}}<a href="{{.PrevHref}}">← 上一页</a>{{else}}<span class="off">← 上一页</span>{{end}}
<span>第 {{.Page}} / {{.TotalPages}} 页</span>
{{if .NextHref}}<a href="{{.NextHref}}">下一页 →</a>{{else}}<span class="off">下一页 →</span>{{end}}
</div>
</body></html>`))

// humanBytes 把字节数格式化为人类可读字符串（使用 strconv 标准库）。
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	val := float64(n) / float64(div)
	return strconv.FormatFloat(val, 'f', 1, 64) + " " + string("KMGTPE"[exp]) + "iB"
}
