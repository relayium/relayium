package account

import (
	"crypto/subtle"
	"html/template"
	"net/http"
	"strconv"
	"time"
)

const (
	adminCookie     = "relayium_admin"
	adminSessionTTL = 12 * time.Hour
)

// AdminEnabled 报告是否配置了管理员密码。
func (s *Service) AdminEnabled() bool { return s.cfg.AdminPassword != "" }

// RegisterAdmin 在根 mux 上挂载 /admin 路由（仅当配置了密码）。
func (s *Service) RegisterAdmin(mux *http.ServeMux) {
	if !s.AdminEnabled() {
		return
	}
	mux.HandleFunc("GET /admin", s.handleAdminHome)
	mux.HandleFunc("POST /admin/login", s.handleAdminLogin)
	mux.HandleFunc("POST /admin/logout", s.handleAdminLogout)
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
	pass := r.FormValue("password")
	if subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.AdminPassword)) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		renderAdminLogin(w, "密码错误")
		return
	}
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

func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		renderAdminLogin(w, "")
		return
	}
	rows, err := s.store.AdminListUsers(r.Context())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := adminUsersTmpl.Execute(w, rows); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}

func renderAdminLogin(w http.ResponseWriter, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = adminLoginTmpl.Execute(w, map[string]string{"Error": errMsg})
}

var adminLoginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin</title>
<style>body{font:15px system-ui;max-width:360px;margin:80px auto;padding:0 16px}
input,button{font:inherit;padding:8px 10px;width:100%;box-sizing:border-box;margin:6px 0}
.err{color:#c00}</style></head>
<body><h1>Relayium 后台</h1>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<form method="post" action="/admin/login">
<input type="password" name="password" placeholder="管理员密码" autofocus>
<button type="submit">登录</button>
</form></body></html>`))

var adminUsersTmpl = template.Must(template.New("users").Funcs(template.FuncMap{
	"ts":    func(sec int64) string { return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04") },
	"bytes": humanBytes,
}).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin · 用户</title>
<style>body{font:14px system-ui;margin:24px}h1{font-size:18px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f5f5f5}.top{display:flex;justify-content:space-between;align-items:center}</style></head>
<body>
<div class="top"><h1>注册用户（{{len .}}）</h1>
<form method="post" action="/admin/logout"><button type="submit">退出</button></form></div>
<table><thead><tr>
<th>邮箱</th><th>显示名</th><th>注册时间(UTC)</th><th>登录方式</th><th>设备</th><th>中继流量</th>
</tr></thead><tbody>
{{range .}}<tr>
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
