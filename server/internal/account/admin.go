package account

import (
	"crypto/subtle"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	adminCookie       = "relayium_admin"
	adminSessionTTL   = 12 * time.Hour
	adminUsersPerPage = 50
)

// adminListHref builds a /admin list link, keeping only non-default params, URL-encoded.
func adminListHref(search, sort, dir string, page int) string {
	v := url.Values{}
	if search != "" {
		v.Set("q", search)
	}
	if sort != "" {
		v.Set("sort", sort)
	}
	if dir != "" {
		v.Set("dir", dir)
	}
	if page > 1 {
		v.Set("page", strconv.Itoa(page))
	}
	if len(v) == 0 {
		return "/admin"
	}
	return "/admin?" + v.Encode()
}

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

func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		s.renderAdminLogin(w, http.StatusOK, "")
		return
	}
	q := r.URL.Query()
	search := strings.TrimSpace(q.Get("q"))
	sortBy := q.Get("sort")
	if sortBy != "email" && sortBy != "relayed" {
		sortBy = "created"
	}
	dir := "desc"
	if strings.EqualFold(q.Get("dir"), "asc") {
		dir = "asc"
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}

	now := s.now().Unix()
	metrics, err := s.store.AdminMetrics(r.Context(), now)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	rows, total, err := s.store.AdminListUsers(r.Context(), AdminUserQuery{
		Search: search, SortBy: sortBy, SortDir: dir,
		Limit: adminUsersPerPage, Offset: (page - 1) * adminUsersPerPage,
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	totalPages := int(math.Ceil(float64(total) / float64(adminUsersPerPage)))
	if totalPages < 1 {
		totalPages = 1
	}
	if page > totalPages { // clamp to the last page and re-fetch it
		page = totalPages
		rows, total, err = s.store.AdminListUsers(r.Context(), AdminUserQuery{
			Search: search, SortBy: sortBy, SortDir: dir,
			Limit: adminUsersPerPage, Offset: (page - 1) * adminUsersPerPage,
		})
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}

	// Sort link for a column header: non-current column -> desc; current column -> toggle direction. Resets to page 1.
	sortHref := map[string]string{}
	for _, col := range []string{"created", "email", "relayed"} {
		nd := "desc"
		if sortBy == col && dir == "desc" {
			nd = "asc"
		}
		sortHref[col] = adminListHref(search, col, nd, 1)
	}
	prev, next := "", ""
	if page > 1 {
		prev = adminListHref(search, sortBy, dir, page-1)
	}
	if page < totalPages {
		next = adminListHref(search, sortBy, dir, page+1)
	}

	st := s.resolveSettings(r.Context())
	data := adminHomeData{
		Metrics: metrics, Users: rows, Total: total, Page: page, TotalPages: totalPages,
		Search: search, Sort: sortBy, Dir: dir,
		PrevHref: prev, NextHref: next, SortHref: sortHref,
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

func (s *Service) renderAdminLogin(w http.ResponseWriter, status int, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = adminLoginTmpl.Execute(w, adminLoginData{Error: errMsg, TOTP: s.AdminTOTPEnabled()})
}
