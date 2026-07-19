package account

import (
	"crypto/subtle"
	"log"
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

	// maxConfigMB bounds admin-supplied MB/GB fields before they're shifted
	// into bytes (<<20 for MB, <<30 for GB). Left unbounded, a huge value
	// (e.g. from a typo or malicious admin input) wraps negative on the
	// shift and is then read back as an unlimited (<=0) cap. 1<<30 MB is
	// ~1 PiB after the shift, safely under int64 max and far beyond any
	// sane plan/setting.
	maxConfigMB = int64(1) << 30
	// maxRetentionDays bounds retention_days before it's multiplied by
	// 86400 into seconds; 100 years is far beyond any sane retention.
	maxRetentionDays = int64(100 * 365)
)

// adminNodeView is a Node prepared for the admin template (online flag derived
// from last_seen against nodeOnlineWindow).
type adminNodeView struct {
	ID                string
	OwnerType         string
	Label             string
	Host              string
	Region            string
	Version           string
	Online            bool
	RelayedBytes      int64
	MonthRelayedBytes int64
	StoredBytes       int64
	StorageEnabled    bool
	StorageTotal      int64
	StorageFree       int64
	TrafficLimitBytes int64
	DiskLimitBytes    int64
	LastSeenAt        int64
}

func nodeViews(nodes []Node, monthly map[string]int64, now time.Time) []adminNodeView {
	cutoff := now.Add(-nodeOnlineWindow).Unix()
	out := make([]adminNodeView, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, adminNodeView{
			ID: n.ID, OwnerType: n.OwnerType, Label: n.Label, Host: nodeHost(n.URLs),
			Region: n.Region, Version: n.Version,
			Online:            n.LastSeenAt >= cutoff,
			RelayedBytes:      n.RelayedBytes,
			MonthRelayedBytes: monthly[n.ID],
			StoredBytes:       n.StoredBytes,
			StorageEnabled:    n.StorageEnabled,
			StorageTotal:      n.StorageTotal,
			StorageFree:       n.StorageFree,
			TrafficLimitBytes: n.TrafficLimitBytes,
			DiskLimitBytes:    n.DiskLimitBytes,
			LastSeenAt:        n.LastSeenAt,
		})
	}
	return out
}

// nodeRunCommandGo is the server-side twin of web/src/lib/nodes.ts
// nodeRunCommand: the one-liner an operator runs on an official box to install
// and start a fleet node bound to this admin-minted token. Kept in sync with
// that TS helper.
func nodeRunCommandGo(centralURL, token string) string {
	return "curl -fsSL " + centralURL + "/install-node.sh | sudo RELAYIUM_CENTRAL_URL=" + centralURL +
		" RELAYIUM_NODE_TOKEN=" + token + " RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs sh"
}

// planView is a Plan prepared for the admin template: stored bytes/secs/cents
// converted to the display units its edit form uses (MB/GB/days, cents as-is).
type planView struct {
	ID                string
	Name              string
	StorageMB         int64
	TrafficGB         int64
	RetentionDays     int64
	PriceMonthlyCents int64
	PriceYearlyCents  int64
	SortOrder         int64
	Active            bool
	// StripePriceMonthlyID/StripePriceYearlyID are the Stripe Price ids
	// mapped to this tier's monthly/yearly billing cycle; '' = unmapped.
	StripePriceMonthlyID string
	StripePriceYearlyID  string
}

func planViews(plans []Plan) []planView {
	out := make([]planView, 0, len(plans))
	for _, p := range plans {
		out = append(out, planView{
			ID: p.ID, Name: p.Name,
			StorageMB:            p.StorageBytes >> 20,
			TrafficGB:            p.TrafficBytes >> 30,
			RetentionDays:        p.RetentionSecs / 86400,
			PriceMonthlyCents:    p.PriceMonthly,
			PriceYearlyCents:     p.PriceYearly,
			SortOrder:            p.SortOrder,
			Active:               p.Active,
			StripePriceMonthlyID: p.StripePriceMonthlyID,
			StripePriceYearlyID:  p.StripePriceYearlyID,
		})
	}
	return out
}

// adminListHref builds a /admin list link, keeping only non-default params, URL-encoded.
func adminListHref(search, sort, dir, period string, page int) string {
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
	if period != "" {
		v.Set("period", period)
	}
	if page > 1 {
		v.Set("page", strconv.Itoa(page))
	}
	if len(v) == 0 {
		return "/admin"
	}
	return "/admin?" + v.Encode()
}

// recentMonths returns the last n billing periods ('YYYYMM', UTC), newest first,
// where index 0 is the month containing `now`.
func recentMonths(now int64, n int) []string {
	first := time.Unix(now, 0).UTC()
	first = time.Date(first.Year(), first.Month(), 1, 0, 0, 0, 0, time.UTC)
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, first.AddDate(0, -i, 0).Format("200601"))
	}
	return out
}

func contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
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
	// State-changing admin form posts go through the same Origin-based CSRF
	// guard as the API. The admin panel is server-rendered same-origin HTML, so
	// legitimate submissions carry a matching Origin; a cross-site forgery does
	// not. GET /admin (the login/dashboard page) is a safe method, left alone.
	mux.HandleFunc("GET /admin", s.handleAdminHome)
	mux.Handle("POST /admin/login", s.csrfGuard(http.HandlerFunc(s.handleAdminLogin)))
	mux.Handle("POST /admin/logout", s.csrfGuard(http.HandlerFunc(s.handleAdminLogout)))
	// The passkey endpoints are fetch-only, so a missing Origin (which csrfGuard
	// lets through for form posts and native clients) is a forgery signal here.
	mux.Handle("POST /admin/passkey/login/begin",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyLoginBegin))))
	mux.Handle("POST /admin/passkey/login/finish",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyLoginFinish))))
	mux.Handle("POST /admin/passkey/register/begin",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyRegisterBegin))))
	mux.Handle("POST /admin/passkey/register/finish",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyRegisterFinish))))
	// Delete is a plain form submission, not fetch, so it gets csrfGuard only.
	mux.Handle("POST /admin/passkey/delete",
		s.csrfGuard(http.HandlerFunc(s.handleAdminPasskeyDelete)))
	mux.Handle("POST /admin/settings", s.csrfGuard(http.HandlerFunc(s.handleAdminSettings)))
	mux.Handle("POST /admin/plans", s.csrfGuard(http.HandlerFunc(s.handleAdminUpsertPlan)))
	mux.Handle("POST /admin/users/plan", s.csrfGuard(http.HandlerFunc(s.handleAdminSetUserPlan)))
	mux.Handle("POST /admin/nodes/token", s.csrfGuard(http.HandlerFunc(s.handleAdminMintToken)))
	mux.Handle("POST /admin/nodes/token/{id}/revoke", s.csrfGuard(http.HandlerFunc(s.handleAdminRevokeToken)))
	mux.Handle("POST /admin/nodes/{id}/limits", s.csrfGuard(http.HandlerFunc(s.handleAdminNodeLimits)))
	mux.Handle("POST /admin/nodes/{id}/label", s.csrfGuard(http.HandlerFunc(s.handleAdminNodeLabel)))
	mux.Handle("POST /admin/nodes/{id}/delete", s.csrfGuard(http.HandlerFunc(s.handleAdminDeleteNode)))
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

// verifyAdminCreds runs the constant-time username/password comparison plus the
// TOTP match shared by password login and passkey-registration step-up. Both
// fields are combined without short-circuit, so neither a wrong username nor a
// wrong password is distinguishable by timing. It does NOT consume the TOTP
// step; callers commit it only after full success.
func (s *Service) verifyAdminCreds(user, pass, code string) (totpStep int64, ok bool) {
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.adminUser()))
	passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.AdminPassword))
	credsOK := userOK&passOK == 1
	step, totpOK := int64(0), true
	if s.AdminTOTPEnabled() {
		step, totpOK = s.matchAdminTOTPStep(code)
	}
	return step, credsOK && totpOK
}

func (s *Service) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if s.adminLogins.locked(ip, s.now()) {
		s.renderAdminLogin(w, http.StatusTooManyRequests, "尝试过于频繁，请稍后再试",
			s.adminPasskeyCount(r.Context()) > 0)
		return
	}

	totpStep, ok := s.verifyAdminCreds(
		r.FormValue("username"), r.FormValue("password"), r.FormValue("totp"))
	if !ok {
		s.adminLogins.recordFail(ip, s.now())
		s.renderAdminLogin(w, http.StatusUnauthorized, "账号、密码或验证码错误",
			s.adminPasskeyCount(r.Context()) > 0)
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

// buildAdminHomeData assembles the dashboard view model (metrics, users, nodes,
// settings, fleet tokens). Shared by handleAdminHome and handleAdminMintToken.
func (s *Service) buildAdminHomeData(r *http.Request) (adminHomeData, error) {
	q := r.URL.Query()
	search := strings.TrimSpace(q.Get("q"))
	sortBy := q.Get("sort")
	switch sortBy {
	case "email", "relayed", "upload", "download", "storage":
	default:
		sortBy = "created"
	}
	dir := "desc"
	if strings.EqualFold(q.Get("dir"), "asc") {
		dir = "asc"
	}
	page, perr := strconv.Atoi(q.Get("page"))
	if perr != nil || page < 1 {
		page = 1
	}

	now := s.now().Unix()
	months := recentMonths(now, 12)
	period := q.Get("period")
	if !contains(months, period) {
		period = months[0]
	}
	metrics, err := s.store.AdminMetrics(r.Context(), period, now)
	if err != nil {
		return adminHomeData{}, err
	}
	query := AdminUserQuery{Search: search, SortBy: sortBy, SortDir: dir, Period: period, Now: now,
		Limit: adminUsersPerPage, Offset: (page - 1) * adminUsersPerPage}
	rows, total, err := s.store.AdminListUsers(r.Context(), query)
	if err != nil {
		return adminHomeData{}, err
	}
	totalPages := int(math.Ceil(float64(total) / float64(adminUsersPerPage)))
	if totalPages < 1 {
		totalPages = 1
	}
	if page > totalPages {
		page = totalPages
		query.Offset = (page - 1) * adminUsersPerPage
		rows, total, err = s.store.AdminListUsers(r.Context(), query)
		if err != nil {
			return adminHomeData{}, err
		}
	}

	sortHref := map[string]string{}
	for _, col := range []string{"created", "email", "relayed", "upload", "download", "storage"} {
		nd := "desc"
		if sortBy == col && dir == "desc" {
			nd = "asc"
		}
		sortHref[col] = adminListHref(search, col, nd, period, 1)
	}
	prev, next := "", ""
	if page > 1 {
		prev = adminListHref(search, sortBy, dir, period, page-1)
	}
	if page < totalPages {
		next = adminListHref(search, sortBy, dir, period, page+1)
	}

	// Per-node monthly relayed bytes (current month) for the fleet traffic column.
	monthStart, _ := monthRange(periodOf(now))
	monthly, mErr := s.store.NodeRelayedSince(r.Context(), monthStart)
	if mErr != nil {
		log.Printf("admin: NodeRelayedSince failed: %v", mErr)
	}
	var nodeVs []adminNodeView
	if ns, nerr := s.store.ListNodes(r.Context()); nerr != nil {
		log.Printf("admin: ListNodes failed: %v", nerr)
	} else {
		nodeVs = nodeViews(ns, monthly, s.now())
	}
	fleetNodeCount := 0
	for _, nv := range nodeVs {
		if nv.OwnerType == "fleet" {
			fleetNodeCount++
		}
	}
	var tokenVs []adminFleetTokenView
	if fts, ferr := s.store.ListActiveFleetTokens(r.Context()); ferr != nil {
		log.Printf("admin: ListActiveFleetTokens failed: %v", ferr)
	} else {
		for _, ft := range fts {
			tokenVs = append(tokenVs, adminFleetTokenView{ID: ft.ID, Name: ft.Name, NodeID: ft.NodeID, CreatedAt: ft.CreatedAt, LastUsedAt: ft.LastUsedAt})
		}
	}

	st := s.resolveSettings(r.Context())
	centralStored, cerr := s.store.CentralStoredBytes(r.Context())
	if cerr != nil {
		log.Printf("admin: CentralStoredBytes failed: %v", cerr)
	}
	var planVs, activePlanVs []planView
	if plans, plerr := s.store.ListPlans(r.Context()); plerr != nil {
		log.Printf("admin: ListPlans failed: %v", plerr)
	} else {
		planVs = planViews(plans)
		for _, pv := range planVs {
			if pv.Active {
				activePlanVs = append(activePlanVs, pv)
			}
		}
	}
	// A passkey that was never used is how a planted credential shows itself,
	// so the list is part of the security surface, not just a convenience.
	// Unlike the other fetches here this one fails the whole page rather than
	// logging and carrying on: rendering an empty table on a failed query would
	// hide exactly the credential the table exists to expose.
	passkeys, err := s.store.ListAdminCredentials(r.Context())
	if err != nil {
		log.Printf("passkey: ListAdminCredentials failed: %v", err)
		return adminHomeData{}, err
	}
	return adminHomeData{
		Metrics: metrics, Users: rows, Total: total, Page: page, TotalPages: totalPages,
		Search: search, Sort: sortBy, Dir: dir, Period: period, Months: months,
		PrevHref: prev, NextHref: next, SortHref: sortHref,
		Nodes: nodeVs, FleetNodeCount: fleetNodeCount, FleetTokens: tokenVs,
		Plans: planVs, ActivePlans: activePlanVs,
		CentralStoredBytes: centralStored,
		Passkeys:           passkeys,
		Settings: adminSettingsView{
			MaxFileSizeMB:          st.MaxFileSize / (1024 * 1024),
			DailyQuotaMB:           st.DailyQuota / (1024 * 1024),
			DefaultTTLHrs:          st.DefaultTTL / 3600,
			MaxTTLHrs:              st.MaxTTL / 3600,
			DefaultRetention:       st.DefaultRetention,
			DefaultMaxDownloads:    st.DefaultMaxDownloads,
			MaxMaxDownloads:        st.MaxMaxDownloads,
			StorageDiskCapMB:       st.StorageDiskCap / (1024 * 1024),
			DisableCentralFallback: st.DisableCentralFallback,
		},
	}, nil
}

func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		s.renderAdminLogin(w, http.StatusOK, "", s.adminPasskeyCount(r.Context()) > 0)
		return
	}
	data, err := s.buildAdminHomeData(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
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
	// default_retention is a 0/1/2 enum where 0 (burn) is a valid value, so it
	// can't use atoi's ">0" requirement; only require a valid non-negative int.
	enumi := func(k string) (int64, bool) {
		n, err := strconv.ParseInt(strings.TrimSpace(r.FormValue(k)), 10, 64)
		return n, err == nil && n >= 0
	}
	// mbMax additionally bounds *_mb fields so the later *1024*1024 (or the
	// plan handler's <<20/<<30) can't wrap a huge value negative and read
	// back as an unlimited (<=0) cap.
	mbMax := func(k string) (int64, bool) {
		n, ok := atoi(k)
		return n, ok && n <= maxConfigMB
	}
	mb, ok1 := mbMax("max_file_size_mb")
	quota, ok2 := mbMax("daily_quota_mb")
	defH, ok3 := atoi("default_ttl_hours")
	maxH, ok4 := atoi("max_ttl_hours")
	defRetention, ok5 := enumi("default_retention")
	defMaxDL, ok6 := atoi("default_max_downloads")
	maxMaxDL, ok7 := atoi("max_max_downloads")
	storageCapMB, ok8 := func() (int64, bool) {
		n, ok := enumi("storage_disk_cap_mb")
		return n, ok && n <= maxConfigMB
	}()
	if !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8) ||
		defH > maxH || defRetention > retentionCount || defMaxDL > maxMaxDL {
		http.Error(w, "invalid settings (positive integers; default_ttl <= max_ttl; "+
			"default_retention in 0..2; default_max_downloads <= max_max_downloads; "+
			"*_mb fields <= 1073741824)", http.StatusBadRequest)
		return
	}
	// Unchecked checkboxes submit no value; present (any value) = on.
	disableCentral := int64(0)
	if strings.TrimSpace(r.FormValue("disable_central_fallback")) != "" {
		disableCentral = 1
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
		{SettingDefaultRetention, defRetention},
		{SettingDefaultMaxDownloads, defMaxDL},
		{SettingMaxMaxDownloads, maxMaxDL},
		{SettingStorageDiskCap, storageCapMB * 1024 * 1024},
		{SettingDisableCentralFallback, disableCentral},
	}
	for _, u := range updates {
		if err := s.store.SetSetting(r.Context(), u.key, u.val, now); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminUpsertPlan validates a plan-edit form and upserts the plan,
// refusing an edit that would leave zero active plans.
func (s *Service) handleAdminUpsertPlan(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	id := strings.TrimSpace(r.FormValue("id"))
	name := strings.TrimSpace(r.FormValue("name"))
	nn := func(k string) (int64, bool) { // non-negative int
		n, err := strconv.ParseInt(strings.TrimSpace(r.FormValue(k)), 10, 64)
		return n, err == nil && n >= 0
	}
	// nnMax additionally rejects values above maxVal, so storage_mb/traffic_gb
	// can't overflow int64 once shifted (<<20/<<30) into bytes and wrap
	// negative, which would silently read back as an unlimited (<=0) cap.
	nnMax := func(k string, maxVal int64) (int64, bool) {
		n, ok := nn(k)
		return n, ok && n <= maxVal
	}
	storageMB, ok1 := nnMax("storage_mb", maxConfigMB)
	trafficGB, ok2 := nnMax("traffic_gb", maxConfigMB)
	retDays, ok3 := nnMax("retention_days", maxRetentionDays)
	pm, ok4 := nn("price_monthly_cents")
	py, ok5 := nn("price_yearly_cents")
	sort, ok6 := nn("sort_order")
	active := r.FormValue("active") == "1"
	// Stripe price ids are free-form strings (e.g. "price_1AbCDe...") assigned
	// by the operator after creating Prices in the Stripe dashboard — no
	// numeric validation, just trim.
	stripePriceMonthlyID := strings.TrimSpace(r.FormValue("stripe_price_monthly_id"))
	stripePriceYearlyID := strings.TrimSpace(r.FormValue("stripe_price_yearly_id"))
	if id == "" || name == "" || !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6) {
		http.Error(w, "invalid plan (non-negative integers; id/name required; "+
			"storage_mb/traffic_gb <= 1073741824; retention_days <= 36500)", http.StatusBadRequest)
		return
	}
	// Never leave zero active plans. Fail closed: any store error here
	// blocks the deactivation rather than silently allowing it.
	if !active {
		n, err := s.store.CountActivePlans(r.Context())
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		cur, ok, err := s.store.GetPlan(r.Context(), id)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if ok && cur.Active && n <= 1 {
			http.Error(w, "at least one plan must stay active", http.StatusBadRequest)
			return
		}
	}
	p := Plan{
		ID: id, Name: name,
		StorageBytes: storageMB << 20, TrafficBytes: trafficGB << 30,
		RetentionSecs: retDays * 86400, PriceMonthly: pm, PriceYearly: py,
		SortOrder: sort, Active: active, UpdatedAt: s.now().Unix(),
		StripePriceMonthlyID: stripePriceMonthlyID,
		StripePriceYearlyID:  stripePriceYearlyID,
	}
	if err := s.store.UpsertPlan(r.Context(), p); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminSetUserPlan assigns a user to a billing plan. Only ACTIVE plans
// may be assigned (a deactivated plan is retired for new/changed
// assignments, though existing holders keep it until moved). Uses
// SetUserPlanAdmin so the assignment is recorded as plan_source='admin' and
// a later Stripe webhook for this user won't override it.
func (s *Service) handleAdminSetUserPlan(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	userID := strings.TrimSpace(r.FormValue("user_id"))
	planID := strings.TrimSpace(r.FormValue("plan_id"))
	if userID == "" || planID == "" {
		http.Error(w, "user_id and plan_id required", http.StatusBadRequest)
		return
	}
	p, ok, err := s.store.GetPlan(r.Context(), planID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok || !p.Active {
		http.Error(w, "unknown or inactive plan", http.StatusBadRequest)
		return
	}
	if err := s.store.SetUserPlanAdmin(r.Context(), userID, planID, s.now().Unix()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminMintToken mints an admin fleet-node token, stores its hash, and
// re-renders the dashboard with the plaintext token + install command shown
// once inline (never persisted, never shown again).
func (s *Service) handleAdminMintToken(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "official-node"
	}
	raw := randToken()
	if err := s.store.CreateFleetToken(r.Context(), FleetToken{
		ID: newID(), TokenHash: hashToken(raw), Name: name, CreatedAt: s.now().Unix(),
	}); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	data, err := s.buildAdminHomeData(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	data.MintedToken = raw
	data.MintedInstallCmd = nodeRunCommandGo(s.cfg.BaseURL, raw)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := adminUsersTmpl.Execute(w, data); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}

// handleAdminNodeLimits sets an official node's traffic/disk hard caps (GB in
// the form, stored as bytes; 0 = unlimited).
func (s *Service) handleAdminNodeLimits(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	gb := func(k string) (int64, bool) {
		n, err := strconv.ParseInt(strings.TrimSpace(r.FormValue(k)), 10, 64)
		// 0 allowed = unlimited; reject values whose GB->bytes shift would overflow int64.
		return n, err == nil && n >= 0 && n <= math.MaxInt64>>30
	}
	tGB, ok1 := gb("traffic_limit_gb")
	dGB, ok2 := gb("disk_limit_gb")
	if !ok1 || !ok2 {
		http.Error(w, "invalid limits (non-negative integers, GB)", http.StatusBadRequest)
		return
	}
	if err := s.store.SetNodeLimits(r.Context(), id, tGB<<30, dGB<<30); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminNodeLabel renames an official (fleet) node.
func (s *Service) handleAdminNodeLabel(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	label := strings.TrimSpace(r.FormValue("label"))
	if len(label) > 64 {
		label = label[:64]
	}
	if err := s.store.SetNodeLabel(r.Context(), r.PathValue("id"), label); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminDeleteNode deletes an official (fleet) node.
func (s *Service) handleAdminDeleteNode(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := s.store.DeleteFleetNode(r.Context(), r.PathValue("id")); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminRevokeToken revokes an admin-minted fleet token so it can no longer
// register/heartbeat a node.
func (s *Service) handleAdminRevokeToken(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := s.store.RevokeFleetToken(r.Context(), r.PathValue("id"), s.now().Unix()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// renderAdminLogin draws the login page. passkey controls only the extra
// passkey button; the password+TOTP form below it is the fallback channel and
// renders unconditionally.
func (s *Service) renderAdminLogin(w http.ResponseWriter, status int, errMsg string, passkey bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = adminLoginTmpl.Execute(w, adminLoginData{
		Error: errMsg, TOTP: s.AdminTOTPEnabled(), Passkey: passkey,
	})
}
