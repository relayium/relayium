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

	// defaultAdminUser is the admin username used when AdminUser is unconfigured
	// (deployments that only set a password).
	defaultAdminUser = "admin"

	// stepUpGraceSecs 是一次成功步进之后，同一会话内高危操作免再验第二因子的窗口。
	//
	// 存在的理由是 TOTP：totp.go 的单调计数器让同一个 30 秒窗口的验证码只能用一次，
	// 没有宽限期的话连续两次高危操作必须干等下一个码。**确认页不受影响，照常展示**，
	// 所以防误点击的能力一点没打折 —— 免掉的只是重复掉码。
	stepUpGraceSecs = 60
)

// adminSession is the state kept for a logged-in admin session token.
type adminSession struct {
	expires      int64  // unix 秒
	auth         string // "password" | "passkey"，建立会话时用的方式
	lastStepUpAt int64  // 上次步进成功的 unix 秒；0 = 从未步进
}

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
	// StorableBytes is what placement will actually offer on this node right
	// now: the minimum of all three conditions in SQLiteStore.StorageNodes,
	// and 0 when any of them excludes the node outright. See storableBytes.
	//
	// It used to be the 70% headroom term alone, which lied: a 100 GB volume
	// with 8 GB left advertised 5.6 GB while the volume reserve had already
	// dropped it out of the placement pool entirely. Purely derived; not
	// stored and not reported by the node.
	StorableBytes     int64
	TrafficLimitBytes int64
	// EffectiveTrafficLimitBytes 是这台节点真正生效的月度上限：节点自己配的值，
	// 或（为 0 时）全局默认。直接显示 TrafficLimitBytes 会让继承默认的节点显示
	// ∞，与实际行为矛盾。
	EffectiveTrafficLimitBytes int64
	DiskLimitBytes             int64
	LastSeenAt                 int64
}

func nodeViews(nodes []Node, monthly map[string]int64, now time.Time, st Settings) []adminNodeView {
	cutoff := now.Add(-nodeOnlineWindow).Unix()
	out := make([]adminNodeView, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, adminNodeView{
			ID: n.ID, OwnerType: n.OwnerType, Label: n.Label, Host: nodeHost(n.URLs),
			Region: n.Region, Version: n.Version,
			Online:                     n.LastSeenAt >= cutoff,
			RelayedBytes:               n.RelayedBytes,
			MonthRelayedBytes:          monthly[n.ID],
			StoredBytes:                n.StoredBytes,
			StorageEnabled:             n.StorageEnabled,
			StorageTotal:               n.StorageTotal,
			StorageFree:                n.StorageFree,
			StorableBytes:              storableBytes(n),
			TrafficLimitBytes:          n.TrafficLimitBytes,
			EffectiveTrafficLimitBytes: resolveNodeTrafficLimit(n, st),
			DiskLimitBytes:             n.DiskLimitBytes,
			LastSeenAt:                 n.LastSeenAt,
		})
	}
	return out
}

// storableBytes 是这台节点的**容量**上还能接收多少字节——放置过滤的三道容量闸
// 取最小值，任一道把它整台排除时为 0。
//
// 只算容量，不算在线状态：StorageNodes 还有一道 last_seen_at >= since，离线节点
// 在放置里是完全排除的，但这里仍会显示一个非零的容量数。这是刻意的——判在线要
// 一个时钟参数，而相邻的「状态」列已经写着离线了，同一行里不会读错。所以别把这
// 个数读成「放置现在会往这台机器放这么多」，它是「这台机器的盘还剩这么多可用」。
//
// 必须与 SQLiteStore.StorageNodes 的 WHERE 保持一致：那边是「够不够放下这一个
// 文件」的布尔判断，这边是「还能放多少」的数值，同一组条件的两种问法。改一边就
// 要改另一边——这是这两处之间唯一的耦合，没有更好的共享方式（SQL 里算不出 min，
// 而且这个数只给后台看，不参与放置决策）。
//
// 镜像的是 StorageNodes（owner_type='fleet'），不是 UserStorageNodes——后者的闸
// 不一样（没有 70% 余量、没有管理员限额，只有裸的 storage_free 和整卷保留）。
// 后台节点表只渲染 fleet 行（模板里的 {{if eq .OwnerType "fleet"}}），所以现在
// 对得上；哪天那张表开始显示用户自带节点，这个函数对它们就是错的。
func storableBytes(n Node) int64 {
	// 闸 2（整卷保留）是全有全无的：过了线就整台退出放置池，不是把额度压小。
	// storage_total = 0（节点从未上报盘信息）在 SQL 里是豁免的，这里照样豁免——
	// 那种节点通常 storage_free 也是 0，闸 1 自己就会算出 0。
	if n.StorageTotal > 0 && n.StorageFree*volumeReserveDen < n.StorageTotal {
		return 0
	}
	// 闸 1：70% 余量。
	b := usableBytes(n.StorageFree)
	// 闸 3：管理员硬盘限额的剩余额度（0 = 无限）。管理员可以把限额调到低于已存
	// 量，此时余量是负的、SQL 那边必然排除该节点，所以下面统一夹到 0——这一列
	// 绝不能显示负数。
	if n.DiskLimitBytes > 0 {
		if remaining := n.DiskLimitBytes - n.StoredBytes; remaining < b {
			b = remaining
		}
	}
	if b < 0 {
		return 0
	}
	return b
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
	// DailyQuotaMB 是该档的每日上传额度（MiB）；0 = 用全局「每账号每日额度」。
	DailyQuotaMB int64
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
			DailyQuotaMB:         p.DailyQuotaBytes >> 20,
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
		return defaultAdminUser
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
	// It is high-risk (see the reversed exemption note on
	// handleAdminPasskeyDelete in passkey_register.go) so it also goes
	// through requireStepUp, same as the other five below.
	mux.Handle("POST /admin/passkey/delete",
		s.csrfGuard(s.requireStepUp(AuditPasskeyDelete, s.handleAdminPasskeyDelete)))
	// These six are high-risk writes: requireStepUp intercepts the POST,
	// stashes it as a pending action, and renders a confirmation page
	// showing the diff instead of applying it directly. The actual write
	// only happens via POST /admin/confirm (handleAdminConfirm) below.
	mux.Handle("POST /admin/settings",
		s.csrfGuard(s.requireStepUp(AuditSettings, s.handleAdminSettings)))
	mux.Handle("POST /admin/plans",
		s.csrfGuard(s.requireStepUp(AuditPlanUpsert, s.handleAdminUpsertPlan)))
	mux.Handle("POST /admin/users/plan",
		s.csrfGuard(s.requireStepUp(AuditUserPlan, s.handleAdminSetUserPlan)))
	mux.Handle("POST /admin/nodes/token",
		s.csrfGuard(s.requireStepUp(AuditTokenMint, s.handleAdminMintToken)))
	mux.Handle("POST /admin/nodes/{id}/delete",
		s.csrfGuard(s.requireStepUp(AuditNodeDelete, s.handleAdminDeleteNode)))
	mux.Handle("POST /admin/confirm", s.csrfGuard(http.HandlerFunc(s.handleAdminConfirm)))
	// Low-risk writes (no lockout/destructive-at-scale potential) apply
	// directly — no confirmation page.
	mux.Handle("POST /admin/nodes/token/{id}/revoke", s.csrfGuard(http.HandlerFunc(s.handleAdminRevokeToken)))
	mux.Handle("POST /admin/nodes/{id}/limits", s.csrfGuard(http.HandlerFunc(s.handleAdminNodeLimits)))
	mux.Handle("POST /admin/nodes/{id}/label", s.csrfGuard(http.HandlerFunc(s.handleAdminNodeLabel)))
}

// newAdminSession mints a session token and records how it was established
// (auth: "password" | "passkey") so the audit trail can report it later.
func (s *Service) newAdminSession(auth string) string {
	tok := randToken()
	s.adminMu.Lock()
	s.adminSessions[tok] = adminSession{
		expires: s.now().Add(adminSessionTTL).Unix(), auth: auth,
	}
	s.adminMu.Unlock()
	return tok
}

func (s *Service) validAdmin(tok string) bool {
	if tok == "" {
		return false
	}
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	sess, ok := s.adminSessions[tok]
	if !ok {
		return false
	}
	if s.now().Unix() >= sess.expires {
		delete(s.adminSessions, tok)
		return false
	}
	return true
}

// markStepUp 记下这次步进成功的时刻，开启宽限期。
func (s *Service) markStepUp(tok string) {
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	if sess, ok := s.adminSessions[tok]; ok {
		sess.lastStepUpAt = s.now().Unix()
		s.adminSessions[tok] = sess
	}
}

// stepUpFresh 报告该会话是否仍在宽限期内。
func (s *Service) stepUpFresh(tok string) bool {
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	sess, ok := s.adminSessions[tok]
	if !ok || sess.lastStepUpAt == 0 {
		return false
	}
	return s.now().Unix()-sess.lastStepUpAt < stepUpGraceSecs
}

func (s *Service) isAdminReq(r *http.Request) bool {
	c, err := r.Cookie(adminCookie)
	return err == nil && s.validAdmin(c.Value)
}

// adminUsername 返回配置的管理员用户名，用于审计的 actor 列。管理员不是 users
// 表里的行，而是配置身份，所以审计里的 actor 恒等于它 —— 真正有区分度的是 IP。
func (s *Service) adminUsername() string {
	return s.adminUser()
}

// adminAuthMethod 报告当前会话是怎么建立的（password / passkey），供审计记录使用。
func (s *Service) adminAuthMethod(r *http.Request) string {
	c, err := r.Cookie(adminCookie)
	if err != nil {
		return ""
	}
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	if sess, ok := s.adminSessions[c.Value]; ok {
		return sess.auth
	}
	return ""
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
		// 只记"有人试过且失败了"。绝不记录尝试的用户名或密码：
		// 用户名常被误输成密码，把它记下来等于把密码写进日志。
		s.writeAudit(r, AuditLoginFail, "-", nil, StepUpNone)
		return
	}

	if s.AdminTOTPEnabled() {
		s.commitAdminTOTPStep(totpStep)
	}
	s.adminLogins.reset(ip)
	tok := s.newAdminSession("password")
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionTTL / time.Second),
	})
	// adminAuthMethod 从 r 的 cookie 反查会话；这个请求本身还没带上刚铸造的
	// cookie（它只被写进了响应），所以这里手动补一份到 r 上，writeAudit 才能
	// 读出 auth=password 而不是空字符串。
	r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
	s.writeAudit(r, AuditLoginOK, "-", nil, StepUpNone)
	http.Redirect(w, r, "/admin", http.StatusFound)
}

func (s *Service) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	// writeAudit 在删除会话之前调用：它经 adminAuthMethod 从 r 的 cookie 反查
	// s.adminSessions 得到 auth，删除之后就查不到了，记出来的 auth 会永远是空。
	s.writeAudit(r, AuditLogout, "-", nil, StepUpNone)
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

	// st is resolved here (rather than down by CentralStoredBytes below) because
	// nodeViews needs it to derive each node's EffectiveTrafficLimitBytes.
	st := s.resolveSettings(r.Context())

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
		nodeVs = nodeViews(ns, monthly, s.now(), st)
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
	// so the list is part of the security surface, not just a convenience. A
	// failed read must therefore never render as an empty table. It must not
	// 500 the page either — that would take down the user list, nodes, plans
	// and settings just as the operator starts diagnosing the database. So
	// carry on like the fetches above and flag it, and the template swaps the
	// table for an explicit error.
	passkeys, pkerr := s.store.ListAdminCredentials(r.Context())
	passkeysErr := pkerr != nil
	if pkerr != nil {
		log.Printf("passkey: ListAdminCredentials failed: %v", pkerr)
		passkeys = nil
	}
	return adminHomeData{
		Metrics: metrics, Users: rows, Total: total, Page: page, TotalPages: totalPages,
		Search: search, Sort: sortBy, Dir: dir, Period: period, Months: months,
		PrevHref: prev, NextHref: next, SortHref: sortHref,
		Nodes: nodeVs, FleetNodeCount: fleetNodeCount, FleetTokens: tokenVs,
		Plans: planVs, ActivePlans: activePlanVs,
		CentralStoredBytes: centralStored,
		Passkeys:           passkeys,
		PasskeysErr:        passkeysErr,
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
			NodeTrafficDefaultGB:   st.NodeTrafficDefault / (1024 * 1024 * 1024),
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
	_, ok1 := mbMax("max_file_size_mb")
	_, ok2 := mbMax("daily_quota_mb")
	defH, ok3 := atoi("default_ttl_hours")
	maxH, ok4 := atoi("max_ttl_hours")
	defRetention, ok5 := enumi("default_retention")
	defMaxDL, ok6 := atoi("default_max_downloads")
	maxMaxDL, ok7 := atoi("max_max_downloads")
	_, ok8 := func() (int64, bool) {
		n, ok := enumi("storage_disk_cap_mb")
		return n, ok && n <= maxConfigMB
	}()
	// node_traffic_default_gb must allow 0 (0 = unlimited), so it uses enumi
	// (n >= 0) rather than atoi (n > 0) — same reasoning as default_retention above.
	_, ok9 := func() (int64, bool) {
		n, ok := enumi("node_traffic_default_gb")
		return n, ok && n <= maxConfigMB // 复用同一个上界，远超任何真实盘/流量规模
	}()
	if !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8 && ok9) ||
		defH > maxH || defRetention > retentionCount || defMaxDL > maxMaxDL {
		http.Error(w, "invalid settings (positive integers; default_ttl <= max_ttl; "+
			"default_retention in 0..2; default_max_downloads <= max_max_downloads; "+
			"*_mb / *_gb fields <= 1073741824)", http.StatusBadRequest)
		return
	}
	// Bounds are enforced above; parseSettingsForm supplies the actual bytes/
	// seconds to write, so the write path and the confirmation-page/audit
	// diff (beforeImageFor) share the exact same unit conversion.
	now := s.now().Unix()
	for key, v := range parseSettingsForm(r.Form) {
		n := int64(0)
		switch t := v.(type) {
		case int64:
			n = t
		case bool:
			if t {
				n = 1
			}
		}
		if err := s.store.SetSetting(r.Context(), key, n, now); err != nil {
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
	p, err := parsePlanForm(r.Form)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Never leave zero active plans. Fail closed: any store error here
	// blocks the deactivation rather than silently allowing it.
	if !p.Active {
		n, err := s.store.CountActivePlans(r.Context())
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		cur, ok, err := s.store.GetPlan(r.Context(), p.ID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if ok && cur.Active && n <= 1 {
			http.Error(w, "at least one plan must stay active", http.StatusBadRequest)
			return
		}
	}
	p.UpdatedAt = s.now().Unix()
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
	trafficBytes, diskBytes := tGB<<30, dGB<<30
	before, _, err := s.store.GetNode(r.Context(), id)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := s.store.SetNodeLimits(r.Context(), id, trafficBytes, diskBytes); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	s.writeAudit(r, AuditNodeLimits, "node:"+id, []ChangeField{
		{Field: "traffic_limit_bytes", Old: before.TrafficLimitBytes, New: trafficBytes},
		{Field: "disk_limit_bytes", Old: before.DiskLimitBytes, New: diskBytes},
	}, StepUpNone)
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminNodeLabel renames an official (fleet) node.
func (s *Service) handleAdminNodeLabel(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	label := strings.TrimSpace(r.FormValue("label"))
	if len(label) > 64 {
		label = label[:64]
	}
	before, _, err := s.store.GetNode(r.Context(), id)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := s.store.SetNodeLabel(r.Context(), id, label); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	s.writeAudit(r, AuditNodeLabel, "node:"+id,
		[]ChangeField{{Field: "label", Old: before.Label, New: label}}, StepUpNone)
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
	id := r.PathValue("id")
	revokedAt := s.now().Unix()
	if err := s.store.RevokeFleetToken(r.Context(), id, revokedAt); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// 只记 token id，绝不记明文 —— 明文只在铸造时内联显示一次，库里存的是哈希。
	s.writeAudit(r, AuditTokenRevoke, "token:"+id,
		[]ChangeField{{Field: "revoked_at", Old: int64(0), New: revokedAt}}, StepUpNone)
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
