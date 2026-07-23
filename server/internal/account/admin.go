package account

import (
	"context"
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
	// auditPageSize is the audit page's page size (rows per /admin/audit page).
	auditPageSize = 100

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
// adminNodeView is a Node prepared for the admin template (online flag derived
// from last_seen against nodeOnlineWindow).
type adminNodeView struct {
	ID        string
	OwnerType string
	// OwnerUserID is the contributing user, for BYO (owner_type='user') rows —
	// empty on fleet rows.
	OwnerUserID string
	// OwnerEmail is OwnerUserID resolved to an email, so an operator draining
	// or removing a user's machine can see WHOSE it is (and act on it — search
	// the user, message them) without a raw opaque id round-tripping through a
	// separate lookup. Filled in by fillByoOwnerEmails, a single batched query
	// against the (already row-capped) BYO rows; empty if the user row is gone
	// (deleted account) or hasn't been resolved, in which case the template
	// falls back to OwnerUserID.
	OwnerEmail        string
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
	// Draining mirrors Node.Draining: out of new-upload placement, still
	// serving what it already holds.
	Draining bool
	// StoredFileCount is how many LIVE stored files (CountFilesOnNode's "live":
	// expires_at > now) still sit on this node.
	StoredFileCount int
	// SafeToUninstallAt is the largest ExpiresAt among this node's live files —
	// the earliest moment every file on it will have expired, and so the
	// earliest moment it is actually safe to remove. 0 means the node holds
	// nothing live: safe now, no wait.
	SafeToUninstallAt int64
	// Removed is set once the node has told central it was being uninstalled
	// (Node.RemovedAt). The row is kept for audit, but the machine is gone: it
	// is out of placement, out of ICE and never receives a download redirect.
	// Shown so the list is not just a growing pile of nodes that read "offline"
	// with no explanation; the delete button is how an operator retires the row.
	Removed bool
	// RemovedAt is the raw Node.RemovedAt timestamp (0 if not removed), used
	// only by the BYO removed section, which SQL ranks by most-recently-removed
	// first (see SQLiteStore.ListByoNodes). Not rendered directly.
	RemovedAt int64
}

func nodeViews(nodes []Node, monthly map[string]int64, fileCounts map[string]NodeFileCount, now time.Time, st Settings) []adminNodeView {
	cutoff := now.Add(-nodeOnlineWindow).Unix()
	out := make([]adminNodeView, 0, len(nodes))
	for _, n := range nodes {
		fc := fileCounts[n.ID]
		out = append(out, adminNodeView{
			ID: n.ID, OwnerType: n.OwnerType, OwnerUserID: n.OwnerUserID, Label: n.Label, Host: nodeHost(n.URLs),
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
			Draining:                   n.Draining,
			StoredFileCount:            fc.Count,
			SafeToUninstallAt:          fc.MaxExpiresAt,
			Removed:                    n.RemovedAt != 0,
			RemovedAt:                  n.RemovedAt,
		})
	}
	return out
}

// adminByoNodesShown 是自带节点表的**每页行数**。
//
// 机队节点是我们自己的机器，十几台，全列出来没问题；自带节点谁都能贡献一台，
// 数量**没有上界**，全渲染意味着后台首页会随用户增长而无限膨胀（一页几千行，
// 每行还带三个表单）。以前这里是"只渲染最该被看到的 N 行、其余的看不见也够
// 不着"；现在它是分页的页长 —— 第 N+1 行不再是永远消失，翻页或搜索就能到达。
// 过滤/排序/分页都在 SQL 里做（ListByoNodes）。**不搜索**的那一页排序由索引
// idx_nodes_byo_rank 直接给出，扫到 LIMIT 就停，页外的行确实没被读；带搜索时
// LIKE 条件走不了索引，仍要扫过 owner_type='user' 的那段索引范围来数匹配数
// （但不排序）。别把这句话夸大成"任何情况下只读 20 行"。
const adminByoNodesShown = 20

// adminByoRemovedShown 是"已卸载的自带节点"这个独立小节的**每页行数**。
//
// removed_at 一旦写上就再也不会自己清掉（只有管理员手动"恢复"才清），而自带
// 节点的数量没有上界——卸载只会单调累积。曾经把已卸载节点和在线/排空中的节点
// 混在同一张表、同一个 adminByoNodesShown 行数上限里排序，一旦累计卸载数超过
// 上限，整张表就会被清一色的墓碑行占满：不仅看不到真正在线、正在闹脾气的节点，
// "恢复"这个手动纠错入口也跟着从后台彻底消失——误卸载之后只能改数据库。现在
// 已卸载节点单独成节、单独限行，"恢复"入口只要还有已卸载节点就一定在页面上。
// 页长给得比 adminByoNodesShown 小很多：这里只是最近误操作的纠错入口，不是
// 卸载历史的存档视图（那是审计日志的活）。但它同样**分页**（参数 brp）：搜索
// 命中 5 台以上时，第 6 台不能就这么够不着——否则"多老的卸载都搜得到"就只对
// 窄搜索成立。
const adminByoRemovedShown = 5

// 排序口径住在 SQLiteStore.ListByoNodes 的 SQL 里（排空中优先、再按最后心跳
// 倒序、最后按 ID 兜底稳定）。这里曾经有一个 byoNodeViews：先 ListNodes 读全
// 表，再在 Go 里过滤+sort.Slice+截断，而且第 21 行的节点在界面上根本无法到达。
// 注意排序里原本还有一档"手上还压着未过期文件的排前面"，现已去掉：那一档要跨
// 表算 EXISTS，任何索引都给不出这个顺序，SQLite 只能把整批匹配行读出来排进临时
// B 树再取 LIMIT——也就是分页只限制了"画多少行"，没有限制"读多少行"。这一档
// 当初存在是因为只显示 20 行且看不到第 21 行；有了搜索和分页之后每台节点都够得
// 着，而"剩余文件"这一列本来就在行上，操作员动手前看的是那一列。

// fillByoOwnerEmails resolves each row's OwnerUserID to an email via a single
// batched lookup and returns the same slice with OwnerEmail populated.
// Deliberately called on ONE PAGE of rows (ListByoNodes has already applied
// the search and the LIMIT): the lookup set is bounded by the page size, not
// by the unbounded BYO population, so this can never become the per-row query
// the rest of this file works hard to avoid.
func fillByoOwnerEmails(ctx context.Context, byo []adminNodeView, emails func(ctx context.Context, ids []string) (map[string]string, error)) []adminNodeView {
	if len(byo) == 0 {
		return byo
	}
	ids := make([]string, len(byo))
	for i, nv := range byo {
		ids[i] = nv.OwnerUserID
	}
	m, err := emails(ctx, ids)
	if err != nil {
		log.Printf("admin: AdminUserEmailsByIDs failed: %v", err)
		return byo
	}
	for i := range byo {
		byo[i].OwnerEmail = m[byo[i].OwnerUserID]
	}
	return byo
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
// 官方节点表只渲染 fleet 行（模板里的 {{if eq .OwnerType "fleet"}}），所以对得
// 上；自带节点表是另一张表，它**故意不显示"可存储"这一列**，正是因为这个函数对
// 用户自带节点是错的。要给那张表加容量列，就得先照 UserStorageNodes 的闸另写一
// 个，别把这个直接套过去。
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

// adminPageLink is one numbered page link in a pager.
type adminPageLink struct {
	Num     int
	Href    string
	Current bool
}

// adminByoPageWindow is how many numbered page links flank the current one.
// A full 1..N list would itself grow without bound, which is the exact problem
// the pager exists to solve.
const adminByoPageWindow = 3

// BYO query params. Deliberately distinct from the user list's q/page: the two
// tables are paged independently, and the BYO pager must never reset the user
// list's search/sort/page — an operator three pages into the user list who
// clicks "next" on the node table would otherwise silently lose their place.
// Do not fold them together.
const (
	byoSearchParam  = "bq"  // BYO search term (shared by both BYO sections)
	byoPageParam    = "bp"  // live BYO table page
	byoRemPageParam = "brp" // removed BYO section page
)

// adminByoHref builds a /admin link that sets the BYO search (bq) and ONE of
// the two BYO pagers (pageKey), carrying every other query param — including
// the OTHER BYO pager and the whole user list's state — through untouched.
func adminByoHref(base url.Values, search, pageKey string, page int) string {
	v := url.Values{}
	for k, vals := range base {
		if k == byoSearchParam || k == pageKey {
			continue
		}
		v[k] = vals
	}
	if search != "" {
		v.Set(byoSearchParam, search)
	}
	if page > 1 && pageKey != "" {
		v.Set(pageKey, strconv.Itoa(page))
	}
	if len(v) == 0 {
		return "/admin"
	}
	return "/admin?" + v.Encode()
}

// adminByoClearHref drops the BYO search AND both BYO page numbers (a page
// number from a filtered result set means nothing once the filter is gone),
// while keeping the user list's own params — "clear" must not double as
// "reset the rest of the page".
func adminByoClearHref(base url.Values) string {
	v := url.Values{}
	for k, vals := range base {
		if k == byoSearchParam || k == byoPageParam || k == byoRemPageParam {
			continue
		}
		v[k] = vals
	}
	if len(v) == 0 {
		return "/admin"
	}
	return "/admin?" + v.Encode()
}

// adminByoPageParam reads a 1-based page number out of the query string,
// falling back to 1 for anything missing, non-numeric or below 1.
func adminByoPageParam(q url.Values, key string) int {
	p, err := strconv.Atoi(q.Get(key))
	if err != nil || p < 1 {
		return 1
	}
	return p
}

// listByoPage reads one page of a BYO section and returns the rows, the total
// number of matches, the page actually used, the page count and any error.
//
// A page number past the end (stale bookmark, nodes restored since) re-reads
// the last real page rather than rendering an empty table with no way back.
// On error it returns zero rows AND the error: the caller must render "the
// query failed", never an empty table that reads as "no such node".
func (s *Service) listByoPage(r *http.Request, q AdminByoNodeQuery, page, size int) (rows []Node, total int64, gotPage, totalPages int, err error) {
	q.Limit, q.Offset = size, (page-1)*size
	rows, total, err = s.store.ListByoNodes(r.Context(), q)
	if err != nil {
		return nil, 0, page, 1, err
	}
	totalPages = int(math.Ceil(float64(total) / float64(size)))
	if totalPages < 1 {
		totalPages = 1
	}
	if page > totalPages {
		page = totalPages
		q.Offset = (page - 1) * size
		rows, total, err = s.store.ListByoNodes(r.Context(), q)
		if err != nil {
			return nil, 0, page, totalPages, err
		}
	}
	return rows, total, page, totalPages, nil
}

// byoPageLinks renders the numbered links around the current page of one BYO
// section (pageKey selects which).
func byoPageLinks(base url.Values, search, pageKey string, page, totalPages int) []adminPageLink {
	from, to := page-adminByoPageWindow, page+adminByoPageWindow
	if from < 1 {
		from = 1
	}
	if to > totalPages {
		to = totalPages
	}
	out := make([]adminPageLink, 0, to-from+1)
	for p := from; p <= to; p++ {
		out = append(out, adminPageLink{Num: p, Href: adminByoHref(base, search, pageKey, p), Current: p == page})
	}
	return out
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
	// Read-only: no csrfGuard (GET is a safe method, same as GET /admin
	// above) and NOT wrapped in requireStepUp (that guard is for writes —
	// this handler never mutates anything).
	mux.HandleFunc("GET /admin/audit", s.handleAdminAudit)
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
	// Step-up passkey assertion challenge, issued to the confirmation page when
	// passkey is the offered factor. fetch-only like the other passkey
	// endpoints, so a missing Origin is a forgery signal.
	mux.Handle("POST /admin/stepup/passkey/begin",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminStepUpPasskeyBegin))))
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
	mux.Handle("POST /admin/nodes/{id}/draining", s.csrfGuard(http.HandlerFunc(s.handleAdminNodeDraining)))
	// Restore is the inverse of /api/nodes/deregister and the reason that endpoint
	// is no longer a one-way door. Same CSRF guard as its neighbours; no step-up,
	// because it returns a node to service rather than taking one out.
	mux.Handle("POST /admin/nodes/{id}/restore", s.csrfGuard(http.HandlerFunc(s.handleAdminRestoreNode)))
	// The other half of the same door: for when deregistration never happened at
	// all (central was unreachable when the uninstaller ran best-effort, and by
	// the time anyone notices state.json — and with it the token and node id —
	// is already gone, so there is nothing left to retry the API call with).
	// Reuses MarkNodeRemoved, the exact store method /api/nodes/deregister calls,
	// so a manually-marked node is indistinguishable from one that deregistered
	// itself: same placement/ICE/direct-download exclusion, same restore path.
	// Same CSRF guard as restore, no step-up: it is the admin-console mirror of
	// an action a node can already take on itself with nothing but a bearer
	// token, not a new capability.
	mux.Handle("POST /admin/nodes/{id}/remove", s.csrfGuard(http.HandlerFunc(s.handleAdminMarkNodeRemoved)))
	// 节点版本发布控制。**每条轨道一套独立路由**（track 在 path 里），不是一个
	// 带轨道下拉框的表单：机队轨和自带节点轨是两台各自独立的控制器，任何把它们
	// 合并成一个入口的做法都会把一条轨道的故障传染给另一条 —— 而"BYO 卡住时机队
	// 仍能照常发布"正是这套双轨设计存在的理由。
	//
	// 通配符叫 {id} 而不是 {track}：requireStepUp / putPending 只搬运名为 "id"
	// 的通配符，紧急发布要经过确认页往返，所以它必须叫 id；四个直接生效的动作
	// 也用同一个名字，免得同一组 handler 里两种读法。
	mux.Handle("POST /admin/rollout/{id}/target", s.csrfGuard(http.HandlerFunc(s.handleAdminRolloutTarget)))
	mux.Handle("POST /admin/rollout/{id}/rollback", s.csrfGuard(http.HandlerFunc(s.handleAdminRolloutRollback)))
	// BYO-only, and deliberately NOT on the {id} wildcard: this is the one
	// action that changes a target without consulting the byo-behind-fleet
	// gate, and the fleet track has no business reaching it.
	mux.Handle("POST /admin/rollout/byo/rollback-previous", s.csrfGuard(http.HandlerFunc(s.handleAdminRolloutByoRollbackPrevious)))
	mux.Handle("POST /admin/rollout/{id}/pause", s.csrfGuard(http.HandlerFunc(s.handleAdminRolloutPause)))
	mux.Handle("POST /admin/rollout/{id}/resume", s.csrfGuard(http.HandlerFunc(s.handleAdminRolloutResume)))
	// 紧急发布跳过分批、对整条轨道一次性放行 —— 没有金丝雀能再兜住这次发布了，
	// 所以它和删除节点一样走 requireStepUp：确认页展示 diff、校验第二因子、
	// 由 handleAdminConfirm 落审计。
	mux.Handle("POST /admin/rollout/{id}/emergency",
		s.csrfGuard(s.requireStepUp(AuditRolloutEmergency, s.handleAdminRolloutEmergency)))
}

// newAdminSession mints a session token and records how it was established
// (auth: "password" | "passkey") so the audit trail can report it later. The
// session lives in the store (shared across instances); an insert failure is
// returned so the caller aborts the login rather than handing out a cookie for a
// session that isn't recorded.
// adminCredFP fingerprints the admin credentials (password + TOTP secret). A
// session carries the fingerprint in force when it was minted; validAdmin
// rejects it once the live credentials differ, so rotating the password/secret
// and restarting revokes every prior session — the classic incident response for
// a leaked cookie, which persisting sessions had quietly broken.
func (s *Service) adminCredFP() string {
	return hashToken(s.cfg.AdminPassword + "\x00" + s.cfg.AdminTOTPSecret)
}

func (s *Service) newAdminSession(ctx context.Context, auth string) (string, error) {
	tok := randToken()
	if err := s.store.CreateAdminSession(ctx, tok, auth, s.adminCredFP(), s.now().Add(adminSessionTTL).Unix()); err != nil {
		return "", err
	}
	return tok, nil
}

func (s *Service) validAdmin(ctx context.Context, tok string) bool {
	if tok == "" {
		return false
	}
	// Fail closed on a store error: a DB blip must not admit an unverified admin.
	_, _, ok, err := s.store.AdminSession(ctx, tok, s.adminCredFP(), s.now().Unix())
	return err == nil && ok
}

// markStepUp 记下这次步进成功的时刻，开启宽限期。Best-effort: a failed write just
// means the operator re-enters the factor on the next high-risk action.
func (s *Service) markStepUp(ctx context.Context, tok string) {
	_ = s.store.MarkAdminStepUp(ctx, tok, s.now().Unix())
}

// stepUpFresh 报告该会话是否仍在宽限期内。Fail closed on a store error / missing
// session (require the factor).
func (s *Service) stepUpFresh(ctx context.Context, tok string) bool {
	_, lastStepUpAt, ok, err := s.store.AdminSession(ctx, tok, s.adminCredFP(), s.now().Unix())
	if err != nil || !ok || lastStepUpAt == 0 {
		return false
	}
	return s.now().Unix()-lastStepUpAt < stepUpGraceSecs
}

func (s *Service) isAdminReq(r *http.Request) bool {
	c, err := r.Cookie(adminCookie)
	return err == nil && s.validAdmin(r.Context(), c.Value)
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
	auth, _, ok, err := s.store.AdminSession(r.Context(), c.Value, s.adminCredFP(), s.now().Unix())
	if err != nil || !ok {
		return ""
	}
	return auth
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
		s.renderAdminLogin(w, r, http.StatusTooManyRequests, "尝试过于频繁，请稍后再试",
			s.adminPasskeyCount(r.Context()) > 0)
		return
	}

	totpStep, ok := s.verifyAdminCreds(
		r.FormValue("username"), r.FormValue("password"), r.FormValue("totp"))
	if !ok {
		s.adminLogins.recordFail(ip, s.now())
		s.renderAdminLogin(w, r, http.StatusUnauthorized, "账号、密码或验证码错误",
			s.adminPasskeyCount(r.Context()) > 0)
		// 只记"有人试过且失败了"。绝不记录尝试的用户名或密码：
		// 用户名常被误输成密码，把它记下来等于把密码写进日志。
		s.writeAudit(r, AuditLoginFail, "-", nil, StepUpNone)
		return
	}

	if s.AdminTOTPEnabled() {
		// Atomically spend the TOTP step (replay guard). A false result means the
		// code was already used — on this or any instance — so treat it exactly
		// like a bad credential: record the failure and show the generic error.
		if claimed, cerr := s.store.ClaimTOTPStep(r.Context(), totpStep); cerr != nil || !claimed {
			s.adminLogins.recordFail(ip, s.now())
			s.renderAdminLogin(w, r, http.StatusUnauthorized, "账号、密码或验证码错误",
				s.adminPasskeyCount(r.Context()) > 0)
			s.writeAudit(r, AuditLoginFail, "-", nil, StepUpNone)
			return
		}
	}
	s.adminLogins.reset(ip)
	tok, err := s.newAdminSession(r.Context(), "password")
	if err != nil {
		s.renderAdminLogin(w, r, http.StatusInternalServerError, "服务器错误，请稍后再试",
			s.adminPasskeyCount(r.Context()) > 0)
		return
	}
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
	// 会话拿到 auth，删除之后就查不到了，记出来的 auth 会永远是空。
	s.writeAudit(r, AuditLogout, "-", nil, StepUpNone)
	if c, err := r.Cookie(adminCookie); err == nil {
		_ = s.store.DeleteAdminSession(r.Context(), c.Value)
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
	// One grouped query for every node's live file count / safe-to-uninstall
	// time, same reasoning as monthly above: the nodes table renders every row
	// from a single read, never one query per node.
	//
	// THIS is where the measured per-render win of the BYO work actually
	// landed — stored_files.node_id was unindexed, so grouping by it meant a
	// row lookup per live file plus a sort. Measured with EXPLAIN QUERY PLAN:
	//
	//	before: SEARCH stored_files USING INDEX idx_stored_files_expires (expires_at>?)
	//	        USE TEMP B-TREE FOR GROUP BY
	//	after:  SEARCH stored_files USING COVERING INDEX idx_stored_files_node (node_id>?)
	//
	// i.e. it no longer touches a single stored_files ROW (everything it needs
	// is in the index) and no longer sorts the result set to group it. It is
	// still a whole-relation read — it is a GROUP BY over every node, and it
	// feeds the FLEET table too, so scoping it to the BYO page would just mean
	// a second query for the same data. One grouped read, never an N+1.
	fileCounts, fcErr := s.store.NodeFileCounts(r.Context(), now)
	if fcErr != nil {
		log.Printf("admin: NodeFileCounts failed: %v", fcErr)
	}
	var nodeVs []adminNodeView
	// allNodes is loaded ONCE and fed to both the fleet nodes section and the
	// two rollout panels; the panels used to re-query the same rows per track.
	//
	// BE HONEST ABOUT WHAT THIS STILL COSTS: this read is every node row,
	// including every BYO one. The BYO *table* no longer depends on it (it
	// pages in SQL, below), but the BYO rollout panel does — byoOpenBatchMembers
	// derives batch membership from the full ordered node set, and the panel
	// must not disagree with what /api/nodes/update-check will actually allow.
	// Bounding that means changing the rollout decision semantics, which is a
	// separate change with its own risk. So: one full node read per admin home
	// render remains, and it is the rollout panels that require it.
	var allNodes []Node
	nodesErr := false
	if ns, nerr := s.store.ListNodes(r.Context()); nerr != nil {
		log.Printf("admin: ListNodes failed: %v", nerr)
		nodesErr = true
	} else {
		allNodes = ns
		nodeVs = nodeViews(ns, monthly, fileCounts, s.now(), st)
	}
	fleetNodeCount := 0
	for _, nv := range nodeVs {
		if nv.OwnerType == "fleet" {
			fleetNodeCount++
		}
	}
	// The BYO tables are SEARCHED and PAGED IN SQL (ListByoNodes), not carved
	// out of nodeVs in Go, so an operator can reach a specific node instead of
	// only the top of a ranked list, and the unsearched live page stops reading
	// at the LIMIT (see ListByoNodes for the query plan and for the case —
	// search — where the whole matching index range is still walked to count).
	//
	// Four bounded queries per render: two counts + two page reads (live and
	// removed), plus one batched email lookup per table. Still O(1) queries per
	// page load, never O(rows) — a per-row query here would be the worst
	// possible place for an N+1.
	//
	// Search is CLAMPED (clampByoSearch) before it reaches SQL: past SQLite's
	// LIKE pattern limit the query errors, and an error rendered as "0 matches"
	// is a confident wrong answer in the one table where believing "there is no
	// such node" is expensive. When the query fails anyway, byoErr/remErr are
	// surfaced in the UI instead of an empty table.
	byoSearch := clampByoSearch(strings.TrimSpace(q.Get(byoSearchParam)))
	byoPage := adminByoPageParam(q, byoPageParam)
	byoRemPage := adminByoPageParam(q, byoRemPageParam)
	byoRows, byoNodeCount, byoPage, byoTotalPages, byoErr :=
		s.listByoPage(r, AdminByoNodeQuery{Search: byoSearch}, byoPage, adminByoNodesShown)
	if byoErr != nil {
		log.Printf("admin: ListByoNodes failed: %v", byoErr)
	}
	// The removed section is a SEPARATE, much shorter page: it is the entry
	// point to /restore for a recent mistake, not an archive of every uninstall
	// ever (that is the audit log's job). It IS searched and it IS paged — a
	// search matching six removed nodes must not leave the sixth unreachable,
	// or "findable however old the uninstall is" would only hold for searches
	// narrow enough to match five.
	byoRemovedRows, byoRemovedCount, byoRemPage, byoRemTotalPages, remErr :=
		s.listByoPage(r, AdminByoNodeQuery{Search: byoSearch, Removed: true}, byoRemPage, adminByoRemovedShown)
	if remErr != nil {
		log.Printf("admin: ListByoNodes(removed) failed: %v", remErr)
	}
	byoNodeVs := fillByoOwnerEmails(r.Context(),
		nodeViews(byoRows, monthly, fileCounts, s.now(), st), s.store.AdminUserEmailsByIDs)
	byoRemovedVs := fillByoOwnerEmails(r.Context(),
		nodeViews(byoRemovedRows, monthly, fileCounts, s.now(), st), s.store.AdminUserEmailsByIDs)
	byoPrev, byoNext := "", ""
	if byoPage > 1 {
		byoPrev = adminByoHref(q, byoSearch, byoPageParam, byoPage-1)
	}
	if byoPage < byoTotalPages {
		byoNext = adminByoHref(q, byoSearch, byoPageParam, byoPage+1)
	}
	byoRemPrev, byoRemNext := "", ""
	if byoRemPage > 1 {
		byoRemPrev = adminByoHref(q, byoSearch, byoRemPageParam, byoRemPage-1)
	}
	if byoRemPage < byoRemTotalPages {
		byoRemNext = adminByoHref(q, byoSearch, byoRemPageParam, byoRemPage+1)
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
	// Two independent builds, one per track. Neither reads the other's row or
	// nodes, and a failure in one sets Err on that panel only — the other
	// panel, and its controls, are unaffected. That independence is the point
	// of the two-track design, so keep these two calls separate.
	rolloutFleet := s.rolloutPanel(r.Context(), "fleet", "机队轨", s.now(), allNodes, nodesErr)
	rolloutByo := s.rolloutPanel(r.Context(), "byo", "自带节点轨", s.now(), allNodes, nodesErr)

	return adminHomeData{
		RolloutFleet: rolloutFleet, RolloutByo: rolloutByo,
		HaltedTracks: haltedRolloutTracks(rolloutFleet, rolloutByo),
		Metrics:      metrics, Users: rows, Total: total, Page: page, TotalPages: totalPages,
		Search: search, Sort: sortBy, Dir: dir, Period: period, Months: months,
		PrevHref: prev, NextHref: next, SortHref: sortHref,
		Nodes: nodeVs, FleetNodeCount: fleetNodeCount, FleetTokens: tokenVs,
		ByoNodes: byoNodeVs, ByoNodeCount: byoNodeCount,
		ByoRemovedNodes: byoRemovedVs, ByoRemovedNodeCount: byoRemovedCount,
		ByoSearch: byoSearch, ByoPage: byoPage, ByoTotalPages: byoTotalPages,
		ByoPrevHref: byoPrev, ByoNextHref: byoNext,
		ByoPages:       byoPageLinks(q, byoSearch, byoPageParam, byoPage, byoTotalPages),
		ByoClearHref:   adminByoClearHref(q),
		ByoErr:         byoErr != nil,
		ByoRemovedPage: byoRemPage, ByoRemovedTotalPages: byoRemTotalPages,
		ByoRemovedPrevHref: byoRemPrev, ByoRemovedNextHref: byoRemNext,
		ByoRemovedPages: byoPageLinks(q, byoSearch, byoRemPageParam, byoRemPage, byoRemTotalPages),
		ByoRemovedErr:   remErr != nil,
		Plans:           planVs, ActivePlans: activePlanVs,
		CentralStoredBytes: centralStored,
		Passkeys:           passkeys,
		PasskeysErr:        passkeysErr,
		Nonce:              CSPNonce(r),
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
		s.renderAdminLogin(w, r, http.StatusOK, "", s.adminPasskeyCount(r.Context()) > 0)
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

// adminAuditHref builds a /admin/audit list link, keeping only non-default
// params — mirrors adminListHref's approach for the user list above, so the
// same "no cookie leaves the URL to the last search" property applies here.
func adminAuditHref(action string, page int) string {
	v := url.Values{}
	if action != "" {
		v.Set("action", action)
	}
	if page > 1 {
		v.Set("page", strconv.Itoa(page))
	}
	if len(v) == 0 {
		return "/admin/audit"
	}
	return "/admin/audit?" + v.Encode()
}

// handleAdminAudit renders the read-only audit log page. It is the only new
// read endpoint in the step-up/audit feature and MUST NOT be gated by
// requireStepUp — that guard exists to confirm writes, and this handler never
// writes anything. Its one security property is the redirect below: an
// unauthenticated request must never see a single audit row.
func (s *Service) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	q := r.URL.Query()
	action := q.Get("action")
	page, perr := strconv.Atoi(q.Get("page"))
	if perr != nil || page < 1 {
		page = 1
	}
	offset := (page - 1) * auditPageSize
	entries, err := s.store.ListAudit(r.Context(), auditPageSize, offset, action)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	rows := make([]adminAuditRow, 0, len(entries))
	for _, e := range entries {
		rows = append(rows, adminAuditRow{
			Time:    time.Unix(e.At, 0).UTC().Format("2006-01-02 15:04:05"),
			Action:  e.Action,
			Target:  e.Target,
			Changes: renderAuditChanges(e.Changes),
			IP:      e.IP,
			Auth:    e.Auth,
			StepUp:  e.StepUp,
		})
	}
	prev, next := "", ""
	if page > 1 {
		prev = adminAuditHref(action, page-1)
	}
	// A full page doesn't guarantee a next page exists, but a short page
	// guarantees it doesn't — same "good enough" heuristic adminListHref's
	// caller uses via TotalPages elsewhere, without a second COUNT query here.
	if len(entries) == auditPageSize {
		next = adminAuditHref(action, page+1)
	}
	data := adminAuditData{
		Rows: rows, Actions: auditActions, Action: action, Page: page,
		PrevHref: prev, NextHref: next,
	}
	if err := adminAuditTmpl.Execute(w, data); err != nil {
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

// handleAdminNodeDraining is the operator toggle for the first half of a safe
// node uninstall: on=true takes the node OUT of new-upload placement while it
// keeps serving what it already holds (see Service.SetNodeDraining). Unscoped
// like handleAdminNodeLabel — an admin can drain any node, not just fleet
// ones, even though only fleet rows render this control today.
func (s *Service) handleAdminNodeDraining(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	on := r.FormValue("on") == "1"
	before, _, err := s.store.GetNode(r.Context(), id)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := s.store.SetNodeDraining(r.Context(), id, on); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	s.writeAudit(r, AuditNodeDraining, "node:"+id,
		[]ChangeField{{Field: "draining", Old: before.Draining, New: on}}, StepUpNone)
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminRestoreNode undoes a deregistration: it clears removed_at and puts
// the node back into placement, ICE and the direct-download path with its row,
// its files and its history untouched.
//
// It exists because deregistration was a one-way door. /api/nodes/deregister is
// authenticated by a token that does not bind to a node id, so anything holding
// the fleet token can name any fleet node — N calls take the entire fleet out of
// service at once — and the only way back was handleAdminDeleteNode, which
// destroys the row. Restoring must therefore be at least as easy as the mistake.
//
// Low-risk by design (no step-up): it puts capacity BACK. The destructive
// direction is delete, which keeps its step-up. Unscoped like the label and
// drain controls — an admin can restore any node, not just fleet ones.
func (s *Service) handleAdminRestoreNode(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	before, found, err := s.store.GetNode(r.Context(), id)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !found {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// A store failure is not "no such node": reporting a DB outage as 404 would
	// tell an admin the node is gone while it is still there, and the audit entry
	// below would be skipped with no trace of why.
	if err := s.store.ClearNodeRemoved(r.Context(), id); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.writeAudit(r, AuditNodeRestore, "node:"+id,
		[]ChangeField{{Field: "removed_at", Old: before.RemovedAt, New: int64(0)}}, StepUpNone)
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminMarkNodeRemoved is the manual recovery for a lost deregistration:
// the uninstaller's POST to /api/nodes/deregister is best-effort, and if
// central was unreachable at that moment the node is never marked removed —
// by the time anyone notices, state.json (and with it the token and node id)
// is already gone, so there is no way to retry the API call by hand. This is
// the admin-console equivalent, calling the SAME store method
// (Service.store.MarkNodeRemoved) that the deregister endpoint itself calls,
// so the outcome is identical: the node leaves the placement pool, the ICE
// candidate list and the direct-download path, its row and file history
// untouched, and /restore reverses it exactly as it would a self-reported
// deregistration.
//
// Unscoped like restore, label and drain — an admin can mark any node removed,
// not just fleet ones — and idempotent: marking an already-removed node keeps
// the first timestamp (see MarkNodeRemoved), so a double click changes nothing.
func (s *Service) handleAdminMarkNodeRemoved(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	before, found, err := s.store.GetNode(r.Context(), id)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !found {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	at := s.now().Unix()
	if err := s.store.MarkNodeRemoved(r.Context(), id, at); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.writeAudit(r, AuditNodeRemove, "node:"+id,
		[]ChangeField{{Field: "removed_at", Old: before.RemovedAt, New: at}}, StepUpNone)
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
func (s *Service) renderAdminLogin(w http.ResponseWriter, r *http.Request, status int, errMsg string, passkey bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = adminLoginTmpl.Execute(w, adminLoginData{
		Error: errMsg, TOTP: s.AdminTOTPEnabled(), Passkey: passkey, Nonce: CSPNonce(r),
	})
}
