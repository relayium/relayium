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
}

type adminHomeData struct {
	Metrics    AdminMetrics
	Users      []AdminUserRow
	Total      int64
	Page       int
	TotalPages int
	Search     string
	Sort       string
	Dir        string
	PrevHref   string            // empty = no previous page
	NextHref   string            // empty = no next page
	SortHref   map[string]string // column key ("created"/"email"/"relayed") -> sort link on click
	Settings   adminSettingsView
}

type adminLoginData struct {
	Error string
	TOTP  bool // render the 6-digit code field
}

var adminLoginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin</title>
<style>:root{--a:#7c3aad;--bg:#faf9fb;--fg:#1a1420;--bd:#e5e4e7;--card:#fff}
@media(prefers-color-scheme:dark){:root{--a:#c084fc;--bg:#16171d;--fg:#f3f4f6;--bd:#2e303a;--card:#1c1d25}}
*{box-sizing:border-box}
body{font:15px system-ui;max-width:360px;margin:80px auto;padding:0 16px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0 0 16px}
form{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px}
input{font:inherit;padding:9px 11px;width:100%;margin:6px 0;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;font-weight:500;padding:10px 11px;width:100%;margin:10px 0 0;border:0;border-radius:8px;background:var(--a);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.07)}
:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.err{color:#e5484d;margin:0 0 10px}</style></head>
<body><h1>Relayium 后台</h1>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<form method="post" action="/admin/login">
<input type="text" name="username" placeholder="管理员账号" autofocus autocomplete="username">
<input type="password" name="password" placeholder="管理员密码" autocomplete="current-password">
{{if .TOTP}}<input type="text" name="totp" placeholder="6 位验证码" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6">{{end}}
<button type="submit">登录</button>
</form></body></html>`))

var adminUsersTmpl = template.Must(template.New("users").Funcs(template.FuncMap{
	"ts":    func(sec int64) string { return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04") },
	"bytes": humanBytes,
}).Parse(`<!doctype html>
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
.pager .off{color:var(--muted);opacity:.55}</style></head>
<body>
<div class="top"><h1>后台概览</h1>
<form method="post" action="/admin/logout"><button type="submit">退出</button></form></div>

<section class="cards">
<div class="card"><div class="n">{{.Metrics.TotalUsers}}</div><div class="l">总用户数</div></div>
<div class="card"><div class="n">{{.Metrics.ActiveStoredFiles}}</div><div class="l">未过期暂存文件</div></div>
<div class="card"><div class="n">{{bytes .Metrics.ActiveStoredBytes}}</div><div class="l">占用存储(近似)</div></div>
<div class="card"><div class="n">{{bytes .Metrics.RelayedBytes24h}}</div><div class="l">中继流量 · 近 24h</div></div>
<div class="card"><div class="n">{{bytes .Metrics.RelayedBytes7d}}</div><div class="l">中继流量 · 近 7d</div></div>
<div class="card"><div class="n">{{bytes .Metrics.UploadedBytes24h}}</div><div class="l">上传量 · 近 24h</div></div>
</section>

<section class="settings">
<h2>暂存传输设置</h2>
<form method="post" action="/admin/settings" class="grid">
<label>单文件上限 (MiB)<input type="number" name="max_file_size_mb" min="1" value="{{.Settings.MaxFileSizeMB}}"></label>
<label>每账号每日额度 (MiB)<input type="number" name="daily_quota_mb" min="1" value="{{.Settings.DailyQuotaMB}}"></label>
<label>默认有效期 (小时)<input type="number" name="default_ttl_hours" min="1" value="{{.Settings.DefaultTTLHrs}}"></label>
<label>最长有效期 (小时)<input type="number" name="max_ttl_hours" min="1" value="{{.Settings.MaxTTLHrs}}"></label>
<button type="submit">保存设置</button>
</form>
</section>

<div class="top"><h2>注册用户（{{.Total}}）</h2>
<form method="get" action="/admin" class="search">
<input type="text" name="q" value="{{.Search}}" placeholder="搜索邮箱或显示名">
<input type="hidden" name="sort" value="{{.Sort}}"><input type="hidden" name="dir" value="{{.Dir}}">
<button type="submit">搜索</button>
</form></div>

<table><thead><tr>
<th><a href="{{index .SortHref "email"}}">邮箱</a></th>
<th>显示名</th>
<th><a href="{{index .SortHref "created"}}">注册时间(UTC)</a></th>
<th>登录方式</th><th>设备</th>
<th><a href="{{index .SortHref "relayed"}}">中继流量</a></th>
</tr></thead><tbody>
{{range .Users}}<tr>
<td>{{.Email}}</td><td>{{.DisplayName}}</td><td>{{ts .CreatedAt}}</td>
<td>{{range $i, $m := .Methods}}{{if $i}}, {{end}}{{$m}}{{end}}</td>
<td>{{.DeviceCount}}</td><td>{{bytes .RelayedBytes}}</td>
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
