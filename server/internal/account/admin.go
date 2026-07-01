package account

import (
	"crypto/subtle"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	adminCookie     = "relayium_admin"
	adminSessionTTL = 12 * time.Hour
)

// AdminEnabled 报告是否配置了管理员密码。账号有默认值，故只以密码为开关。
func (s *Service) AdminEnabled() bool { return s.cfg.AdminPassword != "" }

// adminUser 返回有效管理员账号，未配置时默认为 "admin"（向后兼容只设密码的部署）。
func (s *Service) adminUser() string {
	if s.cfg.AdminUser == "" {
		return "admin"
	}
	return s.cfg.AdminUser
}

// RegisterAdmin 在根 mux 上挂载 /admin 路由（仅当配置了密码）。
func (s *Service) RegisterAdmin(mux *http.ServeMux) {
	if !s.AdminEnabled() {
		return
	}
	mux.HandleFunc("GET /admin", s.handleAdminHome)
	mux.HandleFunc("POST /admin/login", s.handleAdminLogin)
	mux.HandleFunc("POST /admin/logout", s.handleAdminLogout)
	mux.HandleFunc("POST /admin/settings", s.handleAdminSettings)
}

func (s *Service) newAdminSession() string {
	tok := randToken()
	s.adminMu.Lock()
	s.adminSessions[tok] = s.now().Add(adminSessionTTL).Unix()
	s.adminMu.Unlock()
	return tok
}

func (s *Service) validAdmin(tok string) bool {
	if tok == "" {
		return false
	}
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	exp, ok := s.adminSessions[tok]
	if !ok {
		return false
	}
	if s.now().Unix() >= exp {
		delete(s.adminSessions, tok)
		return false
	}
	return true
}

func (s *Service) isAdminReq(r *http.Request) bool {
	c, err := r.Cookie(adminCookie)
	return err == nil && s.validAdmin(c.Value)
}

func (s *Service) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.adminLogins.locked(ip, s.now()) {
		s.renderAdminLogin(w, http.StatusTooManyRequests, "尝试过于频繁，请稍后再试")
		return
	}

	user := r.FormValue("username")
	pass := r.FormValue("password")
	// Compare both fields in constant time and combine without short-circuit,
	// so neither a wrong username nor a wrong password is distinguishable by timing.
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.adminUser()))
	passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.AdminPassword))
	credsOK := userOK&passOK == 1
	totpStep, totpOK := int64(0), true
	if s.AdminTOTPEnabled() {
		totpStep, totpOK = s.matchAdminTOTPStep(r.FormValue("totp"))
	}

	if !credsOK || !totpOK {
		s.adminLogins.recordFail(ip, s.now())
		s.renderAdminLogin(w, http.StatusUnauthorized, "账号、密码或验证码错误")
		return
	}

	if s.AdminTOTPEnabled() {
		s.commitAdminTOTPStep(totpStep)
	}
	s.adminLogins.reset(ip)
	tok := s.newAdminSession()
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionTTL / time.Second),
	})
	http.Redirect(w, r, "/admin", http.StatusFound)
}

func (s *Service) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(adminCookie); err == nil {
		s.adminMu.Lock()
		delete(s.adminSessions, c.Value)
		s.adminMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: "", Path: "/admin", MaxAge: -1,
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, "/admin", http.StatusFound)
}

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

func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		s.renderAdminLogin(w, http.StatusOK, "")
		return
	}
	rows, err := s.store.AdminListUsers(r.Context())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	st := s.resolveSettings(r.Context())
	data := adminHomeData{
		Users: rows,
		Settings: adminSettingsView{
			MaxFileSizeMB: st.MaxFileSize / (1024 * 1024),
			DailyQuotaMB:  st.DailyQuota / (1024 * 1024),
			DefaultTTLHrs: st.DefaultTTL / 3600,
			MaxTTLHrs:     st.MaxTTL / 3600,
		},
	}
	if err := adminUsersTmpl.Execute(w, data); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}

func (s *Service) handleAdminSettings(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	atoi := func(k string) (int64, bool) {
		n, err := strconv.ParseInt(strings.TrimSpace(r.FormValue(k)), 10, 64)
		return n, err == nil && n > 0
	}
	mb, ok1 := atoi("max_file_size_mb")
	quota, ok2 := atoi("daily_quota_mb")
	defH, ok3 := atoi("default_ttl_hours")
	maxH, ok4 := atoi("max_ttl_hours")
	if !(ok1 && ok2 && ok3 && ok4) || defH > maxH {
		http.Error(w, "invalid settings (positive integers; default_ttl <= max_ttl)", http.StatusBadRequest)
		return
	}
	now := s.now().Unix()
	updates := []struct {
		key string
		val int64
	}{
		{SettingMaxFileSize, mb * 1024 * 1024},
		{SettingDailyQuota, quota * 1024 * 1024},
		{SettingDefaultTTL, defH * 3600},
		{SettingMaxTTL, maxH * 3600},
	}
	for _, u := range updates {
		if err := s.store.SetSetting(r.Context(), u.key, u.val, now); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

type adminLoginData struct {
	Error string
	TOTP  bool // render the 6-digit code field
}

func (s *Service) renderAdminLogin(w http.ResponseWriter, status int, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = adminLoginTmpl.Execute(w, adminLoginData{Error: errMsg, TOTP: s.AdminTOTPEnabled()})
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
