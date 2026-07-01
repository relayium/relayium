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
	Users    []AdminUserRow
	Settings adminSettingsView
}

type adminLoginData struct {
	Error string
	TOTP  bool // render the 6-digit code field
}

var adminLoginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin</title>
<style>body{font:15px system-ui;max-width:360px;margin:80px auto;padding:0 16px}
input,button{font:inherit;padding:8px 10px;width:100%;box-sizing:border-box;margin:6px 0}
.err{color:#c00}</style></head>
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
<style>body{font:14px system-ui;margin:24px}h1{font-size:18px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f5f5f5}.top{display:flex;justify-content:space-between;align-items:center}
.settings{margin:18px 0 26px}.settings h2{font-size:16px}
.settings .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;max-width:520px}
.settings label{display:flex;flex-direction:column;font-size:13px;gap:4px}
.settings input{font:inherit;padding:6px 8px}
.settings button{font:inherit;padding:8px 14px;grid-column:1/-1;width:max-content}</style></head>
<body>
<div class="top"><h1>注册用户（{{len .Users}}）</h1>
<form method="post" action="/admin/logout"><button type="submit">退出</button></form></div>

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

<table><thead><tr>
<th>邮箱</th><th>显示名</th><th>注册时间(UTC)</th><th>登录方式</th><th>设备</th><th>中继流量</th>
</tr></thead><tbody>
{{range .Users}}<tr>
<td>{{.Email}}</td><td>{{.DisplayName}}</td><td>{{ts .CreatedAt}}</td>
<td>{{range $i, $m := .Methods}}{{if $i}}, {{end}}{{$m}}{{end}}</td>
<td>{{.DeviceCount}}</td><td>{{bytes .RelayedBytes}}</td>
</tr>{{end}}
</tbody></table>
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
