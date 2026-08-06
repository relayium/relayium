package account

import (
	"encoding/json"
	"fmt"
	"html/template"
	"strconv"
	"strings"
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
	// Lang selects the console language for this request (admin_i18n.go).
	Lang        string
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

	// ByoNodes are USER-CONTRIBUTED nodes, in their own table with their own
	// controls. It is ONE PAGE, filtered/ranked/paged in SQL (ListByoNodes),
	// never a second {{if}} pass over Nodes: the population is unbounded
	// (anyone can contribute a node, and the dashboard must not grow with the
	// user base), and the two tables must never be able to render each other's
	// rows — draining "our machine" and draining "a user's machine" are very
	// different acts. ByoNodeCount is the total number of MATCHES, not the
	// page length.
	ByoNodes     []adminNodeView
	ByoNodeCount int64
	// BYO table search + pagination state. ByoSearch is the filter (node id /
	// owner email / label / region) shared by both BYO sections; the pager
	// links carry it, and the user list's own q/sort/dir/page params, through
	// unchanged.
	ByoSearch     string
	ByoPage       int
	ByoTotalPages int
	ByoPrevHref   string // empty = no previous page
	ByoNextHref   string // empty = no next page
	ByoPages      []adminPageLink
	// ByoClearHref drops the BYO search while keeping the user list's own
	// params — "clear" must not double as "reset the rest of the page".
	ByoClearHref string
	// ByoErr means the BYO query FAILED. It must render as a failure, not as
	// an empty table: "共 0 台 / {{t $.Lang "没有匹配"}}的自带节点" in answer to a query that
	// errored is a confident wrong answer, and this is the table where acting
	// on "there is no such node" costs the most.
	ByoErr bool
	// ByoRemovedNodes is a SEPARATE, small section rendered below the main BYO
	// table for already-uninstalled BYO nodes, so /admin/nodes/{id}/restore —
	// the documented manual recovery for a mistaken deregistration — always has
	// a reachable row: the main table above lists only NON-removed nodes (see
	// SQLiteStore.ListByoNodes), so a removed node would never earn a row
	// there at all. It is searched with the same term as the main table AND
	// paged with its own param (brp), so a specific removed node stays findable
	// however old the uninstall is even when the search matches more of them
	// than fit in one short page.
	// ByoRemovedNodeCount is the total number of removed nodes MATCHING the
	// current search, not the page length.
	ByoRemovedNodes      []adminNodeView
	ByoRemovedNodeCount  int64
	ByoRemovedPage       int
	ByoRemovedTotalPages int
	ByoRemovedPrevHref   string
	ByoRemovedNextHref   string
	ByoRemovedPages      []adminPageLink
	ByoRemovedErr        bool // same contract as ByoErr, for the removed query
	FleetTokens          []adminFleetTokenView
	FleetNodeCount       int    // count of Nodes with OwnerType == "fleet" (matches table body's guard)
	MintedToken          string // set once, right after minting; shown inline then gone
	MintedInstallCmd     string // install one-liner for the freshly minted token
	// CentralStoredBytes is the ciphertext currently held on the app server's own
	// disk (node_id unset) — the default fallback store, shown so the operator can
	// see how much rides on central and decide whether to disable it.
	CentralStoredBytes int64
	// RolloutFleet / RolloutByo are the two node-version rollout panels. They
	// are two SEPARATE fields, built by two separate reads, precisely so a
	// halted or unreadable byo track cannot take the fleet's controls with it —
	// see rolloutPanelView. Do not merge them into one field with a selector.
	RolloutFleet rolloutPanelView
	RolloutByo   rolloutPanelView
	// HaltedTracks is the top-of-page alert: one entry per track whose rollout
	// has STOPPED and is waiting on a human. The panels themselves sit at the
	// bottom of a long dashboard, and a halt that nobody scrolls to can sit
	// unnoticed for a day (the fleet ladder runs ~14h, a byo batch window 6h).
	// Empty on a healthy dashboard, and the template then renders nothing at
	// all — an "all clear" box people learn to ignore is not visibility.
	// Derived from the two panels, so it inherits their independence: an
	// unreadable track contributes nothing here and cannot suppress the other.
	HaltedTracks []rolloutHaltView
	// ReleaseNotice is the "a newer release exists" banner. Its zero value
	// renders nothing, which is also what a failed check produces — this
	// banner only ever makes a positive claim.
	ReleaseNotice releaseNoticeView
	// RolloutError is the banner shown when a rollout control was refused (bad
	// version, unknown track, the byo-behind-fleet gate, pausing a track that
	// is not rolling). Empty on a normal render.
	RolloutError string
	// Nonce is the per-request CSP script nonce, stamped on this page's inline
	// <script> tags so they run under a script-src without 'unsafe-inline'.
	Nonce string
}

type adminFleetTokenView struct {
	ID         string
	Name       string
	NodeID     string
	CreatedAt  int64
	LastUsedAt int64
}

type adminLoginData struct {
	// Lang selects the console language for this request (see admin_i18n.go).
	// It lives on the data rather than in the FuncMap because templates are
	// parsed once at package init and the language varies per request.
	Lang    string
	Error   string
	TOTP    bool   // render the 6-digit code field
	Passkey bool   // render the passkey button (only when a credential exists)
	Nonce   string // per-request CSP script nonce for the inline passkey script
}

// confirmPageData is passed to adminConfirmTmpl (RequireStepUp's confirmation
// page): the diff a pending high-risk write would apply, plus the token that
// identifies it so the confirm POST can retrieve (and burn) it.
type confirmPageData struct {
	// Lang selects the console language for this request (admin_i18n.go). It is
	// on the data, not in the FuncMap, because templates parse once at package
	// init while the language varies per request.
	Lang   string
	Token  string // pending-action token; echoed back as the confirm_token field
	Action string // audit action name (AuditSettings etc.), shown for context
	Target string // "-" for global actions, "plan:x" / "node:x" for scoped ones
	// Track / TrackLabel are set for the emergency release only, and the page
	// renders them as a banner above the diff. They exist because that action's
	// blast radius is decided by the path wildcard ("fleet" = our own machines,
	// "byo" = every user's machine) rather than by any form field, and a
	// confirmation page that does not say which one is not a confirmation.
	// Empty for every other action.
	Track      string
	TrackLabel string
	// Changes is the field-level diff (diffFields' output) — the actual
	// anti-misclick mechanism: naming exactly what would change, not just
	// that "something" would.
	Changes []ChangeField
	// NeedFactor is false only inside the step-up grace window. It must
	// NEVER affect whether this page renders at all — only whether the
	// factor input below is required. See RequireStepUp's doc comment.
	NeedFactor bool
	Factor     string // which factor to prompt for: StepUpPasskey/TOTP/Password
	Nonce      string // per-request CSP script nonce for the inline passkey script
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

// rolloutPanelTmpl renders ONE rollout track's panel (a rolloutPanelView) and
// is instantiated twice, once per track, from separate data.
//
// It is a template over a single track's view — it has no access to the other
// track and no way to name it — which is what keeps the two panels independent
// at the rendering layer too: every control below posts to
// /admin/rollout/{{.Track}}/..., so there is no shared form, no track selector,
// and no way for one track's state to disable the other's buttons. Keep it
// that way; collapsing the two panels into one form with a dropdown would
// recreate exactly the coupling the two-track design exists to avoid.
//
// The onsubmit="return confirm(...)" attributes below are DEAD CODE and must
// never be treated as a confirmation step: buildCSP emits
// script-src 'self' 'nonce-…' with no 'unsafe-inline' / 'unsafe-hashes', so the
// browser blocks inline event handlers and the form posts with no dialog. The
// only real 二次确认 is RequireStepUp's server-rendered confirmation page,
// which is why the emergency form (the one where it actually mattered) carries
// no onsubmit at all — it is behind step-up, and adminConfirmTmpl names the
// track in a banner.
//
// Node rows are capped at rolloutPanelMaxRows and ordered most-relevant-first
// (see rolloutNodeRows): the BYO track is every user's machine, so an
// uncapped one-row-per-node table is an unbounded page.
//
// The in-flight tag renders ONLY when fleetNodeStatus produced a label, with no
// fallback word. There used to be one — 更新中 — for a row that holds the slot
// with nothing being timed, which is precisely the state a HALTED track leaves
// behind (HaltRolloutTrack keeps current_node_id). Printing the very word this
// panel exists to remove, in the one case where the panel knows nothing is
// happening, is worse than printing nothing: the track-level line above already
// says 已中止 and gives the halt reason.
//
// The `never` class is driven by Status.Alarm, NOT by Status.Overdue. A crossed
// limit means opposite things in different bands — in the observing band it is
// the window succeeding — and colouring the successful case red is how an
// operator learns to ignore the colour. See rolloutNodeStatus.Alarm.
const rolloutPanelTmpl = `{{define "rolloutPanel"}}
<div class="ro-panel" id="rollout-{{.Track}}">
<h3>{{.Title}}（{{.Track}}）</h3>
{{if .Err}}
<p class="err">{{t $.Lang "读取该轨道状态失败，控制按钮已隐藏（另一条轨道不受影响）。"}}</p>
{{else}}
<p class="ro-state">{{t $.Lang "目标版本："}}<b>{{if .TargetVersion}}{{.TargetVersion}}{{else}}—{{end}}</b>{{t $.Lang "· 状态："}}<b>{{.StatusText}}</b>{{if .Emergency}} <span class="ro-emg">{{t $.Lang "紧急发布中（已跳过分批）"}}</span>{{end}} ·
{{t $.Lang "进度："}}{{.OnTarget}}/{{.Total}} {{t $.Lang "台已在目标版本"}} ·
{{if eq .Track "fleet"}}{{t $.Lang "正在更新："}}{{if .CurrentNodeID}}{{.CurrentNodeID}}{{else}}—{{end}}
{{else}}{{t $.Lang "当前批次："}}{{if .ByoBatch}}{{.ByoBatch}}%{{else}}{{t $.Lang "未开批"}}{{end}}{{end}}
{{if .StageStartedAt}} · {{t $.Lang "本阶段开始："}}{{ts .StageStartedAt}}{{end}}
</p>
{{if .NextStepText}}<div style="color:var(--muted);font-size:12px">{{.NextStepLabel}}：{{.NextStepText}}</div>{{end}}
{{if .RulesText}}<div style="color:var(--muted);font-size:12px">{{.RulesText}}</div>{{end}}
{{if .HaltedReason}}<p class="err">{{t $.Lang "中止原因："}}{{.HaltedReason}}</p>{{end}}

<div class="ro-ctl">
<form method="post" action="/admin/rollout/{{.Track}}/target" class="lim">
<input type="text" name="version" placeholder="v1.2.3" title="{{t $.Lang "目标版本（vMAJOR.MINOR.PATCH）"}}" style="width:110px">
<button type="submit">{{t $.Lang "设定目标版本"}}</button>
</form>
{{if eq .Status "rolling"}}
<form method="post" action="/admin/rollout/{{.Track}}/pause" class="lim"
  onsubmit="return confirm('{{t $.Lang "暂停该轨的发布？"}} {{.Track}}')"><button type="submit">{{t $.Lang "暂停"}}</button></form>
{{end}}
{{if eq .Status "halted"}}
<form method="post" action="/admin/rollout/{{.Track}}/resume" class="lim"
  onsubmit="return confirm('{{t $.Lang "继续该轨的发布？将从头重新分批。"}} {{.Track}}')"><button type="submit">{{t $.Lang "继续"}}</button></form>
{{end}}
<form method="post" action="/admin/rollout/{{.Track}}/rollback" class="lim"
  onsubmit="return confirm('{{t $.Lang "把该轨回滚到这个版本？"}} {{.Track}}')">
<input type="text" name="version" placeholder="v1.2.2" title="{{t $.Lang "回滚到的版本"}}" style="width:110px">
<button type="submit">{{t $.Lang "回滚"}}</button>
</form>
{{if .PreviousVersion}}
<form method="post" action="/admin/rollout/{{.Track}}/rollback-previous" class="lim"
  onsubmit="return confirm('{{t $.Lang "回滚到上一版本？"}} {{.PreviousVersion}}')">
<button type="submit" title="{{t $.Lang "回到该轨上一个目标版本；该版本当初已通过机队门槛，因此不受机队当前发布状态影响"}}">{{t $.Lang "回滚到上一版本（"}}{{.PreviousVersion}}）</button>
</form>
{{end}}
<form method="post" action="/admin/rollout/{{.Track}}/emergency" class="lim">
<input type="text" name="version" placeholder="v1.2.4" title="{{t $.Lang "紧急发布的版本"}}" style="width:110px">
<button type="submit" class="danger">{{t $.Lang "紧急发布"}}</button>
</form>
</div>

<table>
<thead><tr><th>{{t $.Lang "节点"}}</th><th>{{t $.Lang "状态"}}</th><th>{{t $.Lang "当前版本"}}</th><th>{{t $.Lang "更新结果"}}</th><th>{{t $.Lang "从版本"}}</th><th>{{t $.Lang "下发时间(UTC)"}}</th></tr></thead>
<tbody>
{{range .Nodes}}
<tr>
<td>{{if .Label}}<b>{{.Label}}</b> {{end}}<span style="color:var(--muted);font-size:12px">{{.ID}}</span>
{{if .Status.Label}}<span class="ro-tag{{if .Status.Alarm}} never{{end}}">{{.Status.Label}}</span>{{end}}{{if .Status.Detail}}<div style="color:var(--muted);font-size:12px">{{.Status.Detail}}</div>{{end}}{{if .InBatch}}<span class="ro-tag">{{t $.Lang "本批次"}}</span>{{end}}{{if .PassedOverReason}}<div style="color:var(--muted);font-size:12px">{{.PassedOverReason}}</div>{{end}}</td>
<td>{{if .Online}}{{t $.Lang "在线"}}{{else}}{{t $.Lang "离线"}}{{end}}</td>
<td>{{if .Version}}{{.Version}}{{else}}—{{end}}{{if .OnTarget}} ✓{{end}}</td>
<td>{{if eq .Result "failed"}}<b class="never">{{.ResultText}}</b>{{else if eq .Result "rolled_back"}}<b class="never">{{.ResultText}}</b>{{else}}{{.ResultText}}{{end}}
{{/* 单台重试：三个条件都要成立 —— 机队轨、这台被越过、整条轨道已完成。
     只有机队轨有「被越过」这个概念（decideByo 的候选集不看 update_result），
     自带节点轨上这个按钮什么也做不到。handler 会重新读全部条件，按钮不在场
     不等于守卫在场。 */}}
{{if and (eq $.Track "fleet") .PassedOver (eq $.Status "complete")}}<form method="post" action="/admin/rollout/{{$.Track}}/retry" class="lim"
  onsubmit="return confirm('{{t $.Lang "重新下发？该轨道会回到发布中。"}} {{.ID}} → {{$.TargetVersion}}')">
<input type="hidden" name="node" value="{{.ID}}">
<button type="submit" title="{{t $.Lang "把这台重新放回发布队列；不改目标版本"}}">{{t $.Lang "重试"}}</button>
</form>{{end}}</td>
<td>{{if .UpdateFromVersion}}{{.UpdateFromVersion}}{{else}}—{{end}}</td>
<td>{{if .UpdateStartedAt}}{{ts .UpdateStartedAt}}{{else}}—{{end}}</td>
</tr>
{{else}}
<tr><td colspan="6" style="color:var(--muted)">{{t $.Lang "该轨道下暂无节点"}}</td></tr>
{{end}}
</tbody></table>
{{if .Hidden}}<p style="color:var(--muted);font-size:12px">{{t $.Lang "共"}} {{.Total}} {{t $.Lang "台，仅列出最需要关注的"}} {{len .Nodes}} {{t $.Lang "台（失败 / 发布中 / 落后版本优先），其余"}} {{.Hidden}} {{t $.Lang "台未显示。"}}</p>{{end}}
{{end}}
</div>
{{end}}`

// withRolloutPanel associates the per-track rollout panel template with t.
func withRolloutPanel(t *template.Template) *template.Template {
	return template.Must(t.Parse(rolloutPanelTmpl))
}

var adminLoginTmpl = template.Must(withPasskeyJS(template.New("login").Funcs(template.FuncMap{"t": adminT})).Parse(`<!doctype html>
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
[hidden]{display:none!important}.langpick{display:inline-flex;gap:0;border:1px solid var(--bd);border-radius:7px;overflow:hidden}.langpick button{font:inherit;font-size:12px;padding:3px 8px;border:0;background:transparent;color:var(--muted);cursor:pointer;width:auto;margin:0}.langpick button.on{background:var(--a);color:#fff}</style></head>
<body><div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 16px"><h1 style="margin:0">{{t $.Lang "Relayium 后台"}}</h1><form method="post" action="/admin/lang" class="langpick"><button type="submit" name="l" value="zh"{{if ne $.Lang "en"}} class="on" aria-current="true"{{end}}>中文</button><button type="submit" name="l" value="en"{{if eq $.Lang "en"}} class="on" aria-current="true"{{end}}>EN</button></form></div>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<form method="post" action="/admin/login">
<input type="text" name="username" placeholder="{{t $.Lang "管理员账号"}}" autofocus autocomplete="username">
<input type="password" name="password" placeholder="{{t $.Lang "管理员密码"}}" autocomplete="current-password">
{{if .TOTP}}<input type="text" name="totp" placeholder="{{t $.Lang "6 位验证码"}}" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6">{{end}}
<button type="submit">{{t $.Lang "登录"}}</button>
</form>
{{if .Passkey}}
<button type="button" id="passkey-login" style="margin-top:12px;background:transparent;color:var(--a);border:1px solid var(--bd)">{{t $.Lang "使用 passkey 登录"}}</button>
<p class="err" id="passkey-error" style="margin-top:10px" hidden></p>
<script nonce="{{.Nonce}}">
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
          .then(function(m){ throw new Error(m || '{{t $.Lang "服务器错误 "}}' + r.status); });
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
          .then(function(m){ throw new Error(m || '{{t $.Lang "验证失败（服务器 "}}' + r.status + '）'); });
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
          err.textContent = '{{t $.Lang "已取消，或这台设备上没有可用的 passkey。可用下方密码登录后在设置里添加"}}';
        } else {
          err.className = 'err';
          err.textContent = (e && e.message) || '{{t $.Lang "登录失败，请改用下方密码登录"}}';
        }
        err.hidden = false;
      });
  });
})();
</script>
{{end}}
</body></html>`))

// adminConfirmTmpl draws RequireStepUp's confirmation page: the field-level
// diff a pending high-risk write would apply, plus a form that posts the
// pending-action token (and, once Task 8 lands, the second factor) to
// /admin/confirm. Values interpolated below (Field/Old/New, Action, Target)
// include admin-supplied strings such as plan names, so this MUST stay
// html/template (auto-escaping), never text/template or raw string building.
var adminConfirmTmpl = template.Must(withPasskeyJS(template.New("confirm").Funcs(template.FuncMap{"t": adminT})).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>{{t $.Lang "Relayium Admin · 确认操作"}}</title>
<style>:root{--a:#7c3aad;--bg:#faf9fb;--fg:#1a1420;--bd:#e5e4e7;--card:#fff;--muted:#6b6375;--soft:#f4f3ec}
@media(prefers-color-scheme:dark){:root{--a:#c084fc;--bg:#16171d;--fg:#f3f4f6;--bd:#2e303a;--card:#1c1d25;--muted:#9ca3af;--soft:#1f2028}}
*{box-sizing:border-box}
body{font:15px system-ui;max-width:520px;margin:60px auto;padding:0 16px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0 0 6px}
.sub{color:var(--muted);font-size:13px;margin:0 0 18px}
.sub code{background:var(--soft);border-radius:4px;padding:1px 5px}
table{border-collapse:separate;border-spacing:0;width:100%;background:var(--card);border:1px solid var(--bd);border-radius:12px;overflow:hidden;margin:0 0 18px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--bd);font-size:13px}
th{background:var(--soft);font-weight:600}
tbody tr:last-child td{border-bottom:0}
td.old{color:var(--muted);text-decoration:line-through}
td.new{color:var(--a);font-weight:600}
form{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px}
input{font:inherit;padding:9px 11px;width:100%;margin:6px 0;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;font-weight:500;padding:10px 14px;border:0;border-radius:8px;background:var(--a);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.07)}
:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.actions{display:flex;gap:12px;align-items:center;margin-top:10px}
.actions a{color:var(--muted);text-decoration:none;font-size:13px}
.actions a:hover{text-decoration:underline}
.muted{color:var(--muted);font-size:13px;margin:0 0 10px}
.blast{border:2px solid #dc2626;border-radius:12px;padding:14px 16px;margin:0 0 18px;background:var(--card)}
.blast .t{color:#dc2626;font-weight:700;font-size:15px;margin:0 0 6px}
.blast .track{font-size:22px;font-weight:700;letter-spacing:.5px;margin:0 0 4px}
.blast .who{font-size:14px}.langpick{display:inline-flex;gap:0;border:1px solid var(--bd);border-radius:7px;overflow:hidden}.langpick button{font:inherit;font-size:12px;padding:3px 8px;border:0;background:transparent;color:var(--muted);cursor:pointer;width:auto;margin:0}.langpick button.on{background:var(--a);color:#fff}</style></head>
<body>
<h1>{{t $.Lang "请确认这项操作"}}</h1>
<p class="sub">{{t $.Lang "动作："}}<code>{{.Action}}</code>{{if ne .Target "-"}} · {{t $.Lang "目标："}}<code>{{.Target}}</code>{{end}}</p>

{{if .Track}}
<div class="blast">
<p class="t">{{t $.Lang "⚠ 紧急发布：跳过金丝雀与分批，整条轨道一次性放行"}}</p>
<p class="track">{{t $.Lang "轨道："}}{{.Track}}</p>
<p class="who">{{.TrackLabel}}</p>
</div>
{{end}}

{{if .Changes}}
<table>
<thead><tr><th>{{t $.Lang "字段"}}</th><th>{{t $.Lang "原值"}}</th><th>{{t $.Lang "新值"}}</th></tr></thead>
<tbody>
{{range .Changes}}<tr><td>{{.Field}}</td><td class="old">{{.Old}}</td><td class="new">{{.New}}</td></tr>{{end}}
</tbody>
</table>
{{else}}
<p class="muted">{{t $.Lang "该操作没有逐字段的差异可展示，请确认操作本身无误。"}}</p>
{{end}}

<form method="post" action="/admin/confirm" id="confirm-form">
<input type="hidden" name="confirm_token" value="{{.Token}}">
{{if .NeedFactor}}
{{if eq .Factor "passkey"}}
<input type="hidden" name="factor_assertion" id="factor-assertion">
<p class="muted">{{t $.Lang "用你注册的 passkey 确认这项操作。"}}</p>
<p class="muted" id="passkey-error" hidden></p>
{{else if eq .Factor "totp"}}
<label>{{t $.Lang "验证码（TOTP）"}}<input type="text" name="factor_code" inputmode="numeric" autocomplete="off" placeholder="{{t $.Lang "6 位动态验证码"}}"></label>
{{else}}
<label>{{t $.Lang "管理员密码"}}<input type="password" name="factor_code" autocomplete="current-password" placeholder="{{t $.Lang "再次输入密码以确认"}}"></label>
{{end}}
{{else}}
<p class="muted">{{t $.Lang "刚验证过第二因子，此次操作仍在宽限期内，免再输入 —— 但请确认上面的改动无误。"}}</p>
{{end}}
<div class="actions">
{{if and .NeedFactor (eq .Factor "passkey")}}
<button type="button" id="passkey-confirm">{{t $.Lang "用 passkey 确认执行"}}</button>
{{else}}
<button type="submit">{{t $.Lang "确认执行"}}</button>
{{end}}
<a href="/admin">{{t $.Lang "取消"}}</a>
</div>
</form>
{{if and .NeedFactor (eq .Factor "passkey")}}
<script nonce="{{.Nonce}}">
(function(){
  var btn = document.getElementById('passkey-confirm');
  var err = document.getElementById('passkey-error');
  var field = document.getElementById('factor-assertion');
  var form = document.getElementById('confirm-form');
  // Passkey is the only offered factor here, so a device with no WebAuthn
  // can't complete this action. Say so plainly instead of leaving a dead
  // button; the operator can retry from a device that has the passkey.
  if (!window.PublicKeyCredential || !navigator.credentials) {
    btn.disabled = true;
    err.textContent = '{{t $.Lang "这台设备不支持 passkey，请在注册了 passkey 的设备上确认。"}}';
    err.hidden = false;
    return;
  }
{{template "passkeyB64"}}
  btn.addEventListener('click', function(){
    err.hidden = true; btn.disabled = true;
    fetch('/admin/stepup/passkey/begin', {method:'POST'})
      .then(function(r){
        if (r.ok) return r.json();
        return r.json().then(function(j){ return j.error; }, function(){ return null; })
          .then(function(m){ throw new Error(m || '{{t $.Lang "服务器错误 "}}' + r.status); });
      })
      .then(function(o){
        var pk = o.publicKey;
        pk.challenge = dec(pk.challenge);
        if (pk.allowCredentials) pk.allowCredentials.forEach(function(c){ c.id = dec(c.id); });
        return navigator.credentials.get({publicKey: pk});
      })
      .then(function(c){
        // The assertion rides the confirm form as a hidden field (not a
        // separate fetch) so confirm_token and the factor are submitted
        // together to /admin/confirm in one request.
        field.value = JSON.stringify({
          id: c.id, rawId: enc(c.rawId), type: c.type,
          response: {
            clientDataJSON: enc(c.response.clientDataJSON),
            authenticatorData: enc(c.response.authenticatorData),
            signature: enc(c.response.signature),
            userHandle: c.response.userHandle ? enc(c.response.userHandle) : null
          }
        });
        form.submit();
      })
      .catch(function(e){
        btn.disabled = false;
        if (e && e.name === 'NotAllowedError') {
          err.textContent = '{{t $.Lang "已取消，或这台设备上没有可用的 passkey。"}}';
        } else {
          err.textContent = (e && e.message) || '{{t $.Lang "验证失败，请重试。"}}';
        }
        err.hidden = false;
      });
  });
})();
</script>
{{end}}
</body></html>`))

// Every onsubmit="return confirm(...)" in the template text below — on the
// node restore/remove/delete forms, the token revoke form, the passkey
// delete form, and the release notice's "发布 ... 到机队" button — is DEAD
// CODE, same as rolloutPanelTmpl's own onsubmit attributes (see the doc
// comment on that var): buildCSP emits script-src 'self' 'nonce-…' with no
// 'unsafe-inline' / 'unsafe-hashes', so the browser never runs an inline
// event handler and every one of these forms posts with no dialog. None of
// them must ever be read as "this control has a confirmation step".
//
// The release-rollout button is the newest and, on the page an admin visits
// most casually, the most consequential of the lot — it's why it gets its
// own guards instead of relying on the dead confirm(): handleAdminReleaseRollout
// re-evaluates releaseNotice — the very predicate the {{if .OfferButton}}
// below renders on — and refuses unless it still says OfferButton, AND
// refuses unless the posted version matches the server's own current
// GetReleaseCheck.LatestTag. With both of those in place the button can only
// ever set the target to the version the server itself currently reports as
// newest, and only in a state where this template would have drawn the button
// — so what remains is a misclick, not a stale-state hazard, and a step-up
// flow would just be answering a question those two guards already answer.
//
// Note the shape: the handler calls the predicate rather than restating it.
// Restating it is what let a stale page post while the panel showed nothing.
var adminUsersTmpl = template.Must(withRolloutPanel(withPasskeyJS(template.New("users").Funcs(template.FuncMap{
	"t":     adminT,
	"ts":    func(sec int64) string { return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04") },
	"bytes": humanBytes,
	"gib":   func(b int64) int64 { return b / (1 << 30) },
	"period": func(p string) string {
		if t, err := time.Parse("200601", p); err == nil {
			return t.Format("2006-01")
		}
		return p
	},
}))).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>{{t $.Lang "Relayium Admin · 用户"}}</title>
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
/* 自带节点表：整块靠一条琥珀色左边框和一句告警抬头与官方节点表区分开。视觉上
   必须一眼分得清 —— 在错的那张表上点"标记已移除"，后果完全不是一回事。 */
.byo-nodes{border-left:3px solid #d97706;padding-left:14px;margin:28px 0}
.byo-nodes h2{margin-bottom:6px}
.byo-warn{color:var(--muted);font-size:12px;margin:0 0 12px;max-width:760px}
.byo-search{display:flex;gap:8px;align-items:center;margin:0 0 12px}
.byo-search input[type=search]{font:inherit;padding:7px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg)}
.byo-search a{color:var(--a);text-decoration:none;font-size:13px}.byo-search a:hover{text-decoration:underline}
.byo-nodes-removed{border-left:3px solid var(--muted);padding-left:14px;margin:16px 0 28px;opacity:.85}
.byo-nodes-removed h2{margin-bottom:6px}
.rollout{margin:0 0 28px}.rollout h2{margin-bottom:12px}
.ro-panel{border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin:12px 0;background:var(--card)}
.ro-panel h3{font-size:14px;margin:0 0 8px}
.ro-state{margin:0 0 10px;color:var(--muted);font-size:13px}
.ro-emg{color:#e5484d;font-weight:600}
.halts{margin:0 0 20px}
.halt{border:1px solid #e5484d;border-left-width:5px;border-radius:10px;padding:12px 14px;margin:0 0 10px;background:var(--card)}
.halt b{color:#e5484d}
.halt-why{margin:6px 0;color:var(--fg);font-size:13px;word-break:break-word}
.halt a{color:var(--a);text-decoration:none;font-size:13px}.halt a:hover{text-decoration:underline}
.ro-ctl{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.ro-tag{margin-left:6px;font-size:11px;padding:1px 6px;border-radius:6px;background:var(--soft);color:var(--muted)}
/* [hidden] alone loses to .mint's display:flex, so state it outright. */
[hidden]{display:none!important}.langpick{display:inline-flex;gap:0;border:1px solid var(--bd);border-radius:7px;overflow:hidden}.langpick button{font:inherit;font-size:12px;padding:3px 8px;border:0;background:transparent;color:var(--muted);cursor:pointer;width:auto;margin:0}.langpick button.on{background:var(--a);color:#fff}</style></head>
<body>
<div class="top"><h1>{{t $.Lang "后台概览"}}</h1>
<div style="display:flex;gap:12px;align-items:center">
<form method="post" action="/admin/lang" class="langpick"><button type="submit" name="l" value="zh"{{if ne $.Lang "en"}} class="on" aria-current="true"{{end}}>中文</button><button type="submit" name="l" value="en"{{if eq $.Lang "en"}} class="on" aria-current="true"{{end}}>EN</button></form>
<a href="/admin/audit" style="color:var(--a);text-decoration:none">{{t $.Lang "审计日志"}}</a>
<form method="post" action="/admin/logout"><button type="submit">{{t $.Lang "退出"}}</button></form>
</div></div>

{{with .ReleaseNotice}}
{{if .Enabled}}
{{if .Show}}
<section class="halts">
<div class="halt">
<b>{{t $.Lang "有新版本："}}{{.LatestTag}}</b>{{if .TargetTag}} {{t $.Lang "· 当前目标"}} {{.TargetTag}}{{else}} {{t $.Lang "· 尚未配置发布目标"}}{{end}}
{{if .OfferButton}}
<form method="post" action="/admin/release/rollout" class="lim"
  onsubmit="return confirm('{{t $.Lang "把机队轨的目标版本设为该版本并开始发布？"}} {{.LatestTag}}')">
<input type="hidden" name="version" value="{{.LatestTag}}">
<button type="submit">{{t $.Lang "发布"}} {{.LatestTag}} {{t $.Lang "到机队"}}</button></form>
{{else}}
<div class="halt-why">{{t $.Lang "机队轨上有一次发布尚未结束（目标"}} {{.TargetTag}}{{t $.Lang "，正在发布或已暂停），此处不提供一键发布：那会中止它、清掉记录在案的发布位置并从头开始，已暂停的发布也就无法再原样继续。要改目标请到下方机队面板手动设定。"}}</div>
{{end}}
<form method="post" action="/admin/release/dismiss" class="lim">
<input type="hidden" name="version" value="{{.LatestTag}}">
<button type="submit">{{t $.Lang "忽略此版本"}}</button></form>
</div>
</section>
{{else if .DismissedTag}}
<div style="color:var(--muted);font-size:12px">{{t $.Lang "已忽略"}} {{.DismissedTag}} ·
<form method="post" action="/admin/release/dismiss" class="lim" style="display:inline">
<input type="hidden" name="version" value="">
<button type="submit">{{t $.Lang "撤销"}}</button></form></div>
{{end}}
{{if .CheckedAt}}<div style="color:var(--muted);font-size:12px">{{t $.Lang "上次成功检查："}}{{ts .CheckedAt}} UTC</div>
{{else}}<div style="color:var(--muted);font-size:12px">{{t $.Lang "尚未成功检查过"}}</div>{{end}}
{{end}}
{{end}}

{{if .HaltedTracks}}
<section class="halts">
{{range .HaltedTracks}}
<div class="halt">
<b>{{t $.Lang "发布已中止："}}{{.Title}}（{{.Track}}）</b> {{t $.Lang "· 目标版本"}} {{if .Version}}{{.Version}}{{else}}—{{end}}
<div class="halt-why">{{if .Reason}}{{.Reason}}{{else}}{{t $.Lang "未记录中止原因"}}{{end}}</div>
<a href="#{{.Anchor}}">{{t $.Lang "前往该轨面板处理 ↓"}}</a>
</div>
{{end}}
</section>
{{end}}

<section class="cards">
<div class="card"><div class="n">{{.Metrics.TotalUsers}}</div><div class="l">{{t $.Lang "总用户数"}}</div></div>
<div class="card"><div class="n">{{.Metrics.ActiveStoredFiles}}</div><div class="l">{{t $.Lang "未过期暂存文件"}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.ActiveStoredBytes}}</div><div class="l">{{t $.Lang "占用存储(近似)"}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.UploadBytes}}</div><div class="l">{{t $.Lang "上传 ·"}} {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.DownloadBytes}}</div><div class="l">{{t $.Lang "下载 ·"}} {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.RelayBytes}}</div><div class="l">{{t $.Lang "中继 ·"}} {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .CentralStoredBytes}}</div><div class="l">{{t $.Lang "中央本地存储"}}{{if .Settings.DisableCentralFallback}}{{t $.Lang "（已关闭兜底）"}}{{end}}</div></div>
</section>

<section class="nodes">
<h2>{{t $.Lang "官方节点（"}}{{.FleetNodeCount}}）</h2>

{{if .MintedToken}}
<div class="minted">
<p>{{t $.Lang "新节点 Token（仅显示一次，请立即复制）："}}</p>
<pre>{{.MintedToken}}</pre>
<p>{{t $.Lang "在官方服务器上执行以下命令安装并启动节点："}}</p>
<pre>{{.MintedInstallCmd}}</pre>
</div>
{{end}}

<form method="post" action="/admin/nodes/token" class="mint">
<input type="text" name="name" placeholder="{{t $.Lang "节点备注名（如 cn-shanghai-1）"}}">
<button type="submit">{{t $.Lang "生成节点 Token"}}</button>
</form>

<table>
<thead><tr><th>{{t $.Lang "备注 / ID"}}</th><th>IP</th><th>{{t $.Lang "区域"}}</th><th>{{t $.Lang "状态"}}</th><th>{{t $.Lang "中继(本月/累计) / 上限"}}</th><th>{{t $.Lang "存储 / 硬盘上限"}}</th><th>{{t $.Lang "盘 剩余/总量"}}</th><th>{{t $.Lang "可存储"}}</th><th>{{t $.Lang "排空"}}</th><th>{{t $.Lang "剩余文件 / 最早可安全卸载"}}</th><th>{{t $.Lang "版本"}}</th><th>{{t $.Lang "备注名 · 限额(GB)"}}</th><th></th></tr></thead>
<tbody>
{{range .Nodes}}{{if eq .OwnerType "fleet"}}
<tr>
<td>{{if .Label}}<b>{{.Label}}</b><br>{{end}}<span style="color:var(--muted);font-size:12px">{{.ID}}</span></td>
<td>{{if .Host}}{{.Host}}{{else}}—{{end}}</td>
<td>{{.Region}}</td>
<td>{{if .Removed}}<span class="err">{{t $.Lang "已卸载"}}</span>
<form method="post" action="/admin/nodes/{{.ID}}/restore" class="lim" onsubmit="return confirm('{{t $.Lang "恢复该节点？它会重新进入放置/ICE/直连下载。"}}')"><button type="submit" title="{{t $.Lang "清除已卸载标记，让节点重新上线（不影响它的文件与历史）"}}">{{t $.Lang "恢复"}}</button></form>
{{else}}{{if .Online}}{{t $.Lang "在线"}}{{else}}{{t $.Lang "离线"}}{{end}}
<form method="post" action="/admin/nodes/{{.ID}}/remove" class="lim" onsubmit="return confirm('{{t $.Lang "手动标记该节点已卸载？用于卸载脚本联系不到中央、来不及自动登记的情况；节点会退出放置/ICE/直连下载，文件与历史保留，可随时用「恢复」撤销。"}}')"><button type="submit" title="{{t $.Lang "卸载脚本未能联系中央时的人工补救：标记为已移除"}}">{{t $.Lang "标记已移除"}}</button></form>
{{end}}</td>
<td>{{bytes .MonthRelayedBytes}} / {{bytes .RelayedBytes}} / {{if .EffectiveTrafficLimitBytes}}{{bytes .EffectiveTrafficLimitBytes}}{{else}}∞{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StoredBytes}}{{else}}—{{end}} / {{if .DiskLimitBytes}}{{bytes .DiskLimitBytes}}{{else}}∞{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StorageFree}} / {{bytes .StorageTotal}}{{else}}—{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StorableBytes}}{{else}}—{{end}}</td>
<td>
{{if .Draining}}<span class="err">{{t $.Lang "排空中"}}</span>{{else}}{{t $.Lang "正常"}}{{end}}
<form method="post" action="/admin/nodes/{{.ID}}/draining" class="lim">
<input type="hidden" name="on" value="{{if .Draining}}0{{else}}1{{end}}">
<button type="submit">{{if .Draining}}{{t $.Lang "取消排空"}}{{else}}{{t $.Lang "开始排空"}}{{end}}</button>
</form>
{{if and .Draining (not .StoredFileCount)}}
<div style="color:var(--muted);font-size:12px">{{t $.Lang "可以卸载了，在该机器上执行（先下载到文件、确认非空再运行——不要直接"}} <code>curl | sudo sh</code>，{{t $.Lang "链接一旦暂时不可达，这种管道写法会让整条命令"}}"{{t $.Lang "看起来成功"}}"、{{t $.Lang "实际什么都没做）："}}<br><code>curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh</code></div>
{{else if .Draining}}
<div style="color:var(--muted);font-size:12px">{{t $.Lang "等最后一个文件过期后，在该机器上执行"}} <code>uninstall-node.sh</code> {{t $.Lang "卸载"}}</div>
{{end}}
</td>
<td>{{if .StoredFileCount}}{{.StoredFileCount}} {{t $.Lang "个 /"}} {{ts .SafeToUninstallAt}}{{else}}{{t $.Lang "0 个 · 可随时卸载"}}{{end}}</td>
<td>{{.Version}}</td>
<td>
<form method="post" action="/admin/nodes/{{.ID}}/label" class="lim">
<input type="text" name="label" value="{{.Label}}" placeholder="{{t $.Lang "备注名"}}" title="{{t $.Lang "节点备注名"}}" style="width:110px">
<button type="submit">{{t $.Lang "改名"}}</button>
</form>
<form method="post" action="/admin/nodes/{{.ID}}/limits" class="lim">
<input type="number" name="traffic_limit_gb" min="0" value="{{gib .TrafficLimitBytes}}" title="{{t $.Lang "流量上限 GB/月，0=用全局默认"}}">
<input type="number" name="disk_limit_gb" min="0" value="{{gib .DiskLimitBytes}}" title="{{t $.Lang "硬盘上限 GB，0=无限"}}">
<button type="submit">{{t $.Lang "保存"}}</button>
</form>
</td>
<td><form method="post" action="/admin/nodes/{{.ID}}/delete" onsubmit="return confirm('{{t $.Lang "删除该官方节点？"}}')"><button type="submit" class="danger">{{t $.Lang "删除"}}</button></form></td>
</tr>
{{end}}{{end}}
</tbody></table>

</section>

{{/* 自带节点表。与官方节点表**刻意长得不一样**（独立 section、byo-nodes 类、
     黄色左边框、抬头一句话说明），因为把用户的机器当成自己的机器去排空/移除，
     后果完全不同：那台机器上的文件是用户自己的，而且我们并不拥有那台机器。
     没有"删除"按钮 —— 删行是官方节点的退役操作，用户的节点由用户自己删。
     这张表只列未卸载的节点（ListByoNodes 的 removed_at=0 过滤；已卸载的在下面
     独立小节），所以这里不需要"已卸载"分支——一台已卸载的节点永远不会出现在
     这张表里，恢复入口在下面那个不受本表分页影响的小节。 */}}
<section class="nodes byo-nodes">
{{/* 标题在查询失败时绝不能报"共 0 台"——那是把一次错误说成了一个答案。 */}}
<h2>{{t $.Lang "自带节点（用户机器）"}}</h2>
<p class="sub">{{if .ByoErr}}{{t $.Lang "查询失败"}}{{else}}{{if .ByoSearch}}{{t $.Lang "匹配："}}"{{.ByoSearch}}" · {{end}}{{t $.Lang "共"}} {{.ByoNodeCount}} · {{t $.Lang "第"}} {{.ByoPage}}/{{.ByoTotalPages}}{{end}}</p>
<p class="byo-warn">{{t $.Lang "这些不是我们的机器，是用户贡献的。排空/标记已移除只影响"}}<b>{{t $.Lang "该用户自己的"}}</b>{{t $.Lang "放置池与直连下载，机器本身仍在用户手里运行；先看清"}}"{{t $.Lang "剩余文件"}}"{{t $.Lang "再动手，节点上的文件没有副本。"}}</p>
{{/* 搜索是 GET（安全方法，不带 CSRF token，和用户列表的搜索一致）。隐藏字段把
     用户列表自己的 q/sort/dir/period **和页码 page** 原样带过去：两张表各自分
     页，提交节点表的搜索绝不能把用户列表的搜索、排序和页码清掉。这里刻意不带
     bp/brp——换了搜索词，旧的页码没有意义，两个自带节点小节都回到第 1 页。 */}}
<form method="get" action="/admin" class="byo-search">
<input type="hidden" name="q" value="{{.Search}}">
<input type="hidden" name="sort" value="{{.Sort}}">
<input type="hidden" name="dir" value="{{.Dir}}">
<input type="hidden" name="period" value="{{.Period}}">
<input type="hidden" name="page" value="{{.Page}}">
<input type="search" name="bq" value="{{.ByoSearch}}" placeholder="{{t $.Lang "搜索：节点 ID / 用户邮箱 / 备注名 / 区域"}}" maxlength="200" style="width:300px">
<button type="submit">{{t $.Lang "搜索"}}</button>
{{if .ByoSearch}}<a href="{{.ByoClearHref}}">{{t $.Lang "清除"}}</a>{{end}}
</form>
{{if .ByoErr}}<p class="err">{{t $.Lang "自带节点查询失败，下表"}}<b>{{t $.Lang "不是"}}</b>"{{t $.Lang "没有匹配"}}"{{t $.Lang "的结果——是这次查询没跑成功。请查看服务端日志后重试；在确认之前不要据此认定某台节点不存在。"}}</p>{{end}}
<table>
<thead><tr><th>{{t $.Lang "备注 / ID"}}</th><th>{{t $.Lang "所属用户"}}</th><th>IP</th><th>{{t $.Lang "状态"}}</th><th>{{t $.Lang "版本"}}</th><th>{{t $.Lang "最后心跳(UTC)"}}</th><th>{{t $.Lang "排空"}}</th><th>{{t $.Lang "剩余文件 / 最早可安全卸载"}}</th></tr></thead>
<tbody>
{{range .ByoNodes}}
<tr>
<td>{{if .Label}}<b>{{.Label}}</b><br>{{end}}<span style="color:var(--muted);font-size:12px">{{.ID}}</span></td>
<td><span style="color:var(--muted);font-size:12px">{{if .OwnerEmail}}{{.OwnerEmail}}{{else}}{{.OwnerUserID}}{{end}}</span></td>
<td>{{if .Host}}{{.Host}}{{else}}—{{end}}</td>
<td>{{if .Online}}{{t $.Lang "在线"}}{{else}}{{t $.Lang "离线"}}{{end}}
<form method="post" action="/admin/nodes/{{.ID}}/remove" class="lim" onsubmit="return confirm('{{t $.Lang "标记该用户节点已卸载？它会退出该用户的放置池/ICE/直连下载，文件与历史保留，可随时用「恢复」撤销。"}}')"><button type="submit" title="{{t $.Lang "把这台用户节点移出服务（可恢复）"}}">{{t $.Lang "标记已移除"}}</button></form>
</td>
<td>{{if .Version}}{{.Version}}{{else}}—{{end}}</td>
<td>{{if .LastSeenAt}}{{ts .LastSeenAt}}{{else}}—{{end}}</td>
<td>
{{if .Draining}}<span class="err">{{t $.Lang "排空中"}}</span>{{else}}{{t $.Lang "正常"}}{{end}}
<form method="post" action="/admin/nodes/{{.ID}}/draining" class="lim">
<input type="hidden" name="on" value="{{if .Draining}}0{{else}}1{{end}}">
<button type="submit">{{if .Draining}}{{t $.Lang "取消排空"}}{{else}}{{t $.Lang "开始排空"}}{{end}}</button>
</form>
</td>
<td>{{if .StoredFileCount}}{{.StoredFileCount}} {{t $.Lang "个 /"}} {{ts .SafeToUninstallAt}}{{else}}{{t $.Lang "0 个 · 可随时移除"}}{{end}}</td>
</tr>
{{else}}
<tr><td colspan="8" style="color:var(--muted)">{{if .ByoErr}}{{t $.Lang "查询失败，结果未知"}}{{else if .ByoSearch}}{{t $.Lang "没有匹配的自带节点"}}{{else}}{{t $.Lang "暂无用户自带节点"}}{{end}}</td></tr>
{{end}}
</tbody></table>
{{/* 分页导航是 GET 链接，不是表单：翻页不改任何状态。带页码的链接（不只是
     上一页/下一页）是为了让"跳回第 1 页"这种最常见的动作只要一次点击。 */}}
{{if gt .ByoTotalPages 1}}
<div class="pager">
{{if .ByoPrevHref}}<a href="{{.ByoPrevHref}}">{{t $.Lang "← 上一页"}}</a>{{else}}<span class="off">{{t $.Lang "← 上一页"}}</span>{{end}}
{{range .ByoPages}}{{if .Current}}<b>{{.Num}}</b>{{else}}<a href="{{.Href}}">{{.Num}}</a>{{end}}{{end}}
{{if .ByoNextHref}}<a href="{{.ByoNextHref}}">{{t $.Lang "下一页 →"}}</a>{{else}}<span class="off">{{t $.Lang "下一页 →"}}</span>{{end}}
</div>
{{/* 见 adminByoNodesShown 的注释：排序键 last_seen_at 每次在线节点心跳
     （~30 秒一次）都会变，OFFSET 分页对仍在心跳的节点不是一次能走完的清点——
     翻页时可能跳过或重复看到同一台在线节点。只对搜索、以及不再心跳的节点
     （已离线/已卸载）才是可靠的。这里明说，免得管理员把"翻完所有页"当成
     "点清了所有在线节点"。 */}}
<p class="byo-warn">{{t $.Lang "翻页看到的是当前这一刻的快照：在线节点每次心跳都会重新排名，翻页不保证遍历到每一台在线节点（可能跳过或重复）。要确认某一台节点还在，请用上面的搜索定位，不要靠翻页去清点。"}}</p>
{{end}}
</section>

{{/* 已卸载的自带节点：独立成节、单独一套很短的分页（adminByoRemovedShown，远小
     于上面那张表的页长），跟上面那张表用不同的样式（灰色左边框、略微淡化），
     操作员一眼就能看出这是"卸载记录 + 手动纠错"区，不会跟当前在线的机器混着
     看、误按到"恢复"。这是 /admin/nodes/{id}/restore 的唯一入口——上面那张表
     只列未卸载节点，已卸载节点在那张表里永远不会出现。它也分页（brp）：搜索命
     中 6 台时，第 6 台不能够不着。只在有行或查询出错时渲染，免得健康的部署也要
     看一个空表。 */}}
{{if or .ByoRemovedNodes .ByoRemovedErr}}
<section class="nodes byo-nodes-removed">
{{/* 标题必须说清"当前有没有在过滤"。上面那张表带搜索时会写"匹配 X 的共 N 台"，
     这里以前只写一个光秃秃的"共 N 台"，看起来像是全部已卸载节点的总数，其实是
     过滤后的数量——同一页上两个口径不一致最容易读错。 */}}
<h2>{{t $.Lang "已卸载的自带节点"}}</h2>
<p class="sub">{{if .ByoRemovedErr}}{{t $.Lang "查询失败"}}{{else}}{{if .ByoSearch}}{{t $.Lang "匹配："}}"{{.ByoSearch}}" · {{end}}{{t $.Lang "共"}} {{.ByoRemovedNodeCount}} · {{t $.Lang "第"}} {{.ByoRemovedPage}}/{{.ByoRemovedTotalPages}}{{end}}</p>
{{if .ByoRemovedErr}}<p class="err">{{t $.Lang "已卸载自带节点查询失败，下面"}}<b>{{t $.Lang "不是"}}</b>"{{t $.Lang "没有匹配"}}"{{t $.Lang "的结果。请查看服务端日志后重试。"}}</p>{{end}}
<p class="byo-warn">{{t $.Lang "这些用户节点已被标记卸载，已退出对应用户的放置池/ICE/直连下载。如果是误操作或卸载脚本没跑完整，用「恢复」撤销——不影响它的文件与历史。"}}</p>
<table>
<thead><tr><th>{{t $.Lang "备注 / ID"}}</th><th>{{t $.Lang "所属用户"}}</th><th>IP</th><th>{{t $.Lang "版本"}}</th><th>{{t $.Lang "最后心跳(UTC)"}}</th><th></th></tr></thead>
<tbody>
{{range .ByoRemovedNodes}}
<tr>
<td>{{if .Label}}<b>{{.Label}}</b><br>{{end}}<span style="color:var(--muted);font-size:12px">{{.ID}}</span></td>
<td><span style="color:var(--muted);font-size:12px">{{if .OwnerEmail}}{{.OwnerEmail}}{{else}}{{.OwnerUserID}}{{end}}</span></td>
<td>{{if .Host}}{{.Host}}{{else}}—{{end}}</td>
<td>{{if .Version}}{{.Version}}{{else}}—{{end}}</td>
<td>{{if .LastSeenAt}}{{ts .LastSeenAt}}{{else}}—{{end}}</td>
<td><form method="post" action="/admin/nodes/{{.ID}}/restore" class="lim" onsubmit="return confirm('{{t $.Lang "恢复该用户节点？它会重新进入该用户的放置池/ICE/直连下载。"}}')"><button type="submit" title="{{t $.Lang "清除已卸载标记（不影响它的文件与历史）"}}">{{t $.Lang "恢复"}}</button></form></td>
</tr>
{{else}}
{{/* 与上面的实时节点表一致：查询出错时也要在表内给一行明确的"查询失败"，
     不能只留一个空 tbody——空表在这张"恢复"入口所在的表里尤其容易被读成
     "没有已卸载节点"。 */}}
<tr><td colspan="6" style="color:var(--muted)">{{if .ByoRemovedErr}}{{t $.Lang "查询失败，结果未知"}}{{else if .ByoSearch}}{{t $.Lang "没有匹配的已卸载节点"}}{{else}}{{t $.Lang "暂无已卸载节点"}}{{end}}</td></tr>
{{end}}
</tbody></table>
{{if gt .ByoRemovedTotalPages 1}}
<div class="pager">
{{if .ByoRemovedPrevHref}}<a href="{{.ByoRemovedPrevHref}}">{{t $.Lang "← 上一页"}}</a>{{else}}<span class="off">{{t $.Lang "← 上一页"}}</span>{{end}}
{{range .ByoRemovedPages}}{{if .Current}}<b>{{.Num}}</b>{{else}}<a href="{{.Href}}">{{.Num}}</a>{{end}}{{end}}
{{if .ByoRemovedNextHref}}<a href="{{.ByoRemovedNextHref}}">{{t $.Lang "下一页 →"}}</a>{{else}}<span class="off">{{t $.Lang "下一页 →"}}</span>{{end}}
</div>
{{end}}
</section>
{{end}}

<section class="nodes">
{{if .FleetTokens}}
<h2>{{t $.Lang "活跃节点 Token（"}}{{len .FleetTokens}}）</h2>
<table>
<thead><tr><th>{{t $.Lang "备注名"}}</th><th>{{t $.Lang "创建时间(UTC)"}}</th><th>{{t $.Lang "最后使用"}}</th><th>{{t $.Lang "绑定节点"}}</th><th></th></tr></thead>
<tbody>
{{range .FleetTokens}}
<tr>
<td>{{.Name}}</td><td>{{ts .CreatedAt}}</td>
<td>{{if .LastUsedAt}}{{ts .LastUsedAt}}{{else}}—{{end}}</td>
<td>{{if .NodeID}}{{.NodeID}}{{else}}—{{end}}</td>
<td><form method="post" action="/admin/nodes/token/{{.ID}}/revoke" onsubmit="return confirm('{{t $.Lang "撤销该 Token？"}}')"><button type="submit" class="danger">{{t $.Lang "撤销"}}</button></form></td>
</tr>
{{end}}
</tbody></table>
{{end}}
</section>

<section class="rollout">
<h2>{{t $.Lang "节点版本发布"}}</h2>
{{if .RolloutError}}<p class="err">{{.RolloutError}}</p>{{end}}
{{template "rolloutPanel" .RolloutFleet}}
{{template "rolloutPanel" .RolloutByo}}
</section>

<section class="plans">
<h2>{{t $.Lang "套餐（"}}{{len .Plans}}）</h2>
<table>
<thead><tr><th>ID</th><th>{{t $.Lang "名称"}}</th><th>{{t $.Lang "存储(MB)"}}</th><th>{{t $.Lang "流量(GB/月)"}}</th><th>{{t $.Lang "暂存天数"}}</th><th>{{t $.Lang "每日额度(MiB)"}}</th><th>{{t $.Lang "月付(分)"}}</th><th>{{t $.Lang "年付(分)"}}</th><th>{{t $.Lang "排序"}}</th><th>{{t $.Lang "启用"}}</th><th>{{t $.Lang "Stripe 月付价格ID"}}</th><th>{{t $.Lang "Stripe 年付价格ID"}}</th><th></th></tr></thead>
<tbody>
{{range .Plans}}
<tr><td colspan="13">
<form method="post" action="/admin/plans" class="plan-row">
<input type="hidden" name="id" value="{{.ID}}">
<span>{{.ID}}</span>
<input type="text" name="name" value="{{.Name}}" title="{{t $.Lang "名称"}}" required>
<input type="number" name="storage_mb" min="0" value="{{.StorageMB}}" title="{{t $.Lang "存储(MB)"}}">
<input type="number" name="traffic_gb" min="0" value="{{.TrafficGB}}" title="{{t $.Lang "流量(GB/月)"}}">
<input type="number" name="retention_days" min="0" value="{{.RetentionDays}}" title="{{t $.Lang "暂存天数"}}">
<input type="number" name="daily_quota_mb" min="0" value="{{.DailyQuotaMB}}" title="{{t $.Lang "每日额度(MiB)，0 = 用全局设置"}}">
<input type="number" name="price_monthly_cents" min="0" value="{{.PriceMonthlyCents}}" title="{{t $.Lang "月付(分)"}}">
<input type="number" name="price_yearly_cents" min="0" value="{{.PriceYearlyCents}}" title="{{t $.Lang "年付(分)"}}">
<input type="number" name="sort_order" min="0" value="{{.SortOrder}}" title="{{t $.Lang "排序"}}">
<label><input type="checkbox" name="active" value="1"{{if .Active}} checked{{end}}> {{t $.Lang "启用"}}</label>
<input type="text" name="stripe_price_monthly_id" value="{{.StripePriceMonthlyID}}" title="{{t $.Lang "Stripe 月付价格ID"}}" placeholder="price_...">
<input type="text" name="stripe_price_yearly_id" value="{{.StripePriceYearlyID}}" title="{{t $.Lang "Stripe 年付价格ID"}}" placeholder="price_...">
<button type="submit">{{t $.Lang "保存"}}</button>
</form>
</td></tr>
{{end}}
</tbody></table>
</section>

<section class="settings">
<h2>{{t $.Lang "暂存传输设置"}}</h2>
<form method="post" action="/admin/settings" class="grid">
<label>{{t $.Lang "单文件上限 (MiB)"}}<input type="number" name="max_file_size_mb" min="1" value="{{.Settings.MaxFileSizeMB}}"></label>
<label>{{t $.Lang "每账号每日额度 (MiB)"}}<input type="number" name="daily_quota_mb" min="1" value="{{.Settings.DailyQuotaMB}}"></label>
<label>{{t $.Lang "默认有效期 (小时)"}}<input type="number" name="default_ttl_hours" min="1" value="{{.Settings.DefaultTTLHrs}}"></label>
<label>{{t $.Lang "最长有效期 (小时)"}}<input type="number" name="max_ttl_hours" min="1" value="{{.Settings.MaxTTLHrs}}"></label>
<label>{{t $.Lang "默认保留策略"}}<select name="default_retention">
<option value="0"{{if eq .Settings.DefaultRetention 0}} selected{{end}}>{{t $.Lang "阅后即焚"}}</option>
<option value="1"{{if eq .Settings.DefaultRetention 1}} selected{{end}}>{{t $.Lang "保存N天"}}</option>
<option value="2"{{if eq .Settings.DefaultRetention 2}} selected{{end}}>{{t $.Lang "限定次数"}}</option>
</select></label>
<label>{{t $.Lang "默认下载次数上限"}}<input type="number" name="default_max_downloads" min="1" value="{{.Settings.DefaultMaxDownloads}}"></label>
<label>{{t $.Lang "下载次数上限的上限"}}<input type="number" name="max_max_downloads" min="1" value="{{.Settings.MaxMaxDownloads}}"></label>
<label>{{t $.Lang "全局存储上限 (MiB，0=无限)"}}<input type="number" name="storage_disk_cap_mb" min="0" value="{{.Settings.StorageDiskCapMB}}"></label>
<label>{{t $.Lang "节点默认流量上限 (GB/月，0=不限)"}}<input type="number" name="node_traffic_default_gb" min="0" value="{{.Settings.NodeTrafficDefaultGB}}"></label>
<label style="flex-direction:row;align-items:center;gap:8px;grid-column:1/-1"><input type="checkbox" name="disable_central_fallback" value="1" style="width:auto"{{if .Settings.DisableCentralFallback}} checked{{end}}>{{t $.Lang "关闭中央兜底：无可用存储节点时上传直接失败，不再落到本站服务器磁盘"}}</label>
<button type="submit">{{t $.Lang "保存设置"}}</button>
</form>
</section>

<section class="passkeys">
<h2>{{t $.Lang "Passkey 登录"}}{{if not .PasskeysErr}}（{{len .Passkeys}}）{{end}}</h2>
{{if .PasskeysErr}}
<p class="err">{{t $.Lang "凭据列表读取失败，请查看服务端日志"}}</p>
{{else}}
<table>
<thead><tr><th>{{t $.Lang "名称"}}</th><th>{{t $.Lang "添加时间(UTC)"}}</th><th>{{t $.Lang "最后使用"}}</th><th></th></tr></thead>
<tbody>
{{range .Passkeys}}
<tr>
<td>{{.Name}}</td>
<td>{{ts .CreatedAt}}</td>
<td>{{if .LastUsedAt}}{{ts .LastUsedAt}}{{else}}<span class="never">{{t $.Lang "从未使用"}}</span>{{end}}</td>
<td><form method="post" action="/admin/passkey/delete" onsubmit="return confirm('{{t $.Lang "删除这枚 passkey？"}}')">
<input type="hidden" name="id" value="{{.ID}}"><button type="submit" class="danger">{{t $.Lang "删除"}}</button></form></td>
</tr>
{{else}}
<tr><td colspan="4">{{t $.Lang "尚未添加 passkey"}}</td></tr>
{{end}}
</tbody></table>
{{end}}

<form id="passkey-add" class="mint" hidden>
<input type="text" name="name" placeholder="{{t $.Lang "设备名称，如 MacBook"}}" required>
<input type="text" name="username" placeholder="{{t $.Lang "管理员账号"}}" autocomplete="username" required>
<input type="password" name="password" placeholder="{{t $.Lang "管理员密码"}}" autocomplete="current-password" required>
<input type="text" name="totp" placeholder="{{t $.Lang "6 位验证码（如已启用）"}}" inputmode="numeric" autocomplete="one-time-code">
<button type="submit">{{t $.Lang "添加 passkey"}}</button>
</form>
<p class="err" id="passkey-add-error" hidden></p>
<script nonce="{{.Nonce}}">
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
          .then(function(m){ throw new Error(m || '{{t $.Lang "验证失败（服务器 "}}' + r.status + '）'); });
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
          .then(function(m){ throw new Error(m || '{{t $.Lang "注册失败（服务器 "}}' + r.status + '）'); });
      })
      .catch(function(e){
        // Cancelling the platform prompt is a normal action, not an error.
        if (e && e.name === 'NotAllowedError') return;
        err.textContent = (e && e.message) || '{{t $.Lang "注册失败"}}';
        err.hidden = false;
      });
  });
  // Revealed only now that the handler is attached, so the form can never be
  // submitted as a plain GET by a half-initialised page.
  form.hidden = false;
})();
</script>
</section>

<div class="top"><h2>{{t $.Lang "用量月份"}}</h2>
<form method="get" action="/admin" class="search">
<input type="hidden" name="q" value="{{.Search}}"><input type="hidden" name="sort" value="{{.Sort}}"><input type="hidden" name="dir" value="{{.Dir}}">
<select name="period" onchange="this.form.submit()">
{{$sel := .Period}}{{range .Months}}<option value="{{.}}"{{if eq . $sel}} selected{{end}}>{{period .}}</option>{{end}}
</select>
<noscript><button type="submit">{{t $.Lang "切换"}}</button></noscript>
</form></div>

<div class="top"><h2>{{t $.Lang "注册用户（"}}{{.Total}}）</h2>
<form method="get" action="/admin" class="search">
<input type="text" name="q" value="{{.Search}}" placeholder="{{t $.Lang "搜索邮箱或显示名"}}">
<input type="hidden" name="sort" value="{{.Sort}}"><input type="hidden" name="dir" value="{{.Dir}}"><input type="hidden" name="period" value="{{.Period}}">
<button type="submit">{{t $.Lang "搜索"}}</button>
</form></div>

<table><thead><tr>
<th><a href="{{index .SortHref "email"}}">{{t $.Lang "邮箱"}}</a></th>
<th>{{t $.Lang "显示名"}}</th>
<th><a href="{{index .SortHref "created"}}">{{t $.Lang "注册时间(UTC)"}}</a></th>
<th>{{t $.Lang "登录方式"}}</th><th>{{t $.Lang "设备"}}</th>
<th><a href="{{index .SortHref "upload"}}">{{t $.Lang "上传"}}</a></th>
<th><a href="{{index .SortHref "download"}}">{{t $.Lang "下载"}}</a></th>
<th><a href="{{index .SortHref "relayed"}}">{{t $.Lang "中继"}}</a></th>
<th><a href="{{index .SortHref "storage"}}">{{t $.Lang "当前存储占用"}}</a></th>
<th>{{t $.Lang "套餐"}}</th>
<th>{{t $.Lang "订阅来源"}}</th>
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
<button type="submit">{{t $.Lang "分配"}}</button>
</form>
</td>
<td>{{if eq .PlanSource "admin"}}{{.PlanID}} · admin{{else if eq .PlanSource "stripe"}}{{.PlanID}} · stripe/{{.SubscriptionStatus}}{{else}}—{{end}}</td>
</tr>{{end}}
</tbody></table>

<div class="pager">
{{if .PrevHref}}<a href="{{.PrevHref}}">{{t $.Lang "← 上一页"}}</a>{{else}}<span class="off">{{t $.Lang "← 上一页"}}</span>{{end}}
<span>{{t $.Lang "第"}} {{.Page}} / {{.TotalPages}} {{t $.Lang "页"}}</span>
{{if .NextHref}}<a href="{{.NextHref}}">{{t $.Lang "下一页 →"}}</a>{{else}}<span class="off">{{t $.Lang "下一页 →"}}</span>{{end}}
</div>
</body></html>`))

// adminAuditRow is one audit_audit row, pre-formatted for display. Formatting
// (time, changes) happens in handleAdminAudit rather than via template funcs
// because renderAuditChanges needs to unmarshal Changes' JSON, which is
// awkward to express as a one-line template func and easier to unit-test as
// a plain Go function.
type adminAuditRow struct {
	Time    string
	Action  string
	Target  string
	Changes string // pre-rendered by renderAuditChanges; "—" when empty
	IP      string
	Auth    string
	StepUp  string
}

type adminAuditData struct {
	Lang     string // console language for this request (admin_i18n.go)
	Rows     []adminAuditRow
	Actions  []string // known action constants (audit.go's auditActions), for the filter dropdown
	Action   string   // currently selected filter; "" = all actions
	Page     int
	PrevHref string
	NextHref string
}

// adminAuditTmpl draws the read-only audit log page. Action/Target/Changes/IP
// all carry admin- or user-controlled strings (plan names, node labels, IP
// headers), so — same rule as adminConfirmTmpl above — this MUST stay
// html/template (auto-escaping), never text/template or raw string building.
var adminAuditTmpl = template.Must(template.New("audit").Funcs(template.FuncMap{"t": adminT}).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>{{t $.Lang "Relayium Admin · 审计日志"}}</title>
<style>:root{--a:#7c3aad;--bg:#faf9fb;--fg:#1a1420;--bd:#e5e4e7;--card:#fff;--muted:#6b6375;--soft:#f4f3ec}
@media(prefers-color-scheme:dark){:root{--a:#c084fc;--bg:#16171d;--fg:#f3f4f6;--bd:#2e303a;--card:#1c1d25;--muted:#9ca3af;--soft:#1f2028}}
*{box-sizing:border-box}
body{font:14px system-ui;margin:0 auto;max-width:1080px;padding:24px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px}
.top a{color:var(--a);text-decoration:none}.top a:hover{text-decoration:underline}
.filter{margin:0 0 16px}
.filter select{font:inherit;padding:7px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg)}
table{border-collapse:separate;border-spacing:0;width:100%;background:var(--card);border:1px solid var(--bd);border-radius:12px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--bd);font-size:13px}
th{background:var(--soft);font-weight:600}
tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--soft)}
.pager{display:flex;gap:16px;align-items:center;margin:18px 0}
.pager a{color:var(--a);text-decoration:none}.pager a:hover{text-decoration:underline}
.pager .off{color:var(--muted);opacity:.55}
:focus-visible{outline:2px solid var(--a);outline-offset:2px}.langpick{display:inline-flex;gap:0;border:1px solid var(--bd);border-radius:7px;overflow:hidden}.langpick button{font:inherit;font-size:12px;padding:3px 8px;border:0;background:transparent;color:var(--muted);cursor:pointer;width:auto;margin:0}.langpick button.on{background:var(--a);color:#fff}</style></head>
<body>
<div class="top"><h1>{{t $.Lang "审计日志"}}</h1><div style="display:flex;gap:12px;align-items:center"><form method="post" action="/admin/lang" class="langpick"><button type="submit" name="l" value="zh"{{if ne $.Lang "en"}} class="on" aria-current="true"{{end}}>中文</button><button type="submit" name="l" value="en"{{if eq $.Lang "en"}} class="on" aria-current="true"{{end}}>EN</button></form><a href="/admin">{{t $.Lang "← 返回后台"}}</a></div></div>

<form method="get" action="/admin/audit" class="filter">
<select name="action" onchange="this.form.submit()">
<option value=""{{if eq .Action ""}} selected{{end}}>{{t $.Lang "全部动作"}}</option>
{{$sel := .Action}}{{range .Actions}}<option value="{{.}}"{{if eq . $sel}} selected{{end}}>{{.}}</option>{{end}}
</select>
<noscript><button type="submit">{{t $.Lang "筛选"}}</button></noscript>
</form>

<table>
<thead><tr><th>{{t $.Lang "时间(UTC)"}}</th><th>{{t $.Lang "动作"}}</th><th>{{t $.Lang "目标"}}</th><th>{{t $.Lang "变更"}}</th><th>IP</th><th>{{t $.Lang "登录方式"}}</th><th>{{t $.Lang "步进因子"}}</th></tr></thead>
<tbody>
{{range .Rows}}<tr>
<td>{{.Time}}</td>
<td>{{.Action}}</td>
<td>{{.Target}}</td>
<td>{{.Changes}}</td>
<td>{{.IP}}</td>
<td>{{.Auth}}</td>
<td>{{if .StepUp}}{{.StepUp}}{{else}}—{{end}}</td>
</tr>{{else}}
<tr><td colspan="7">{{t $.Lang "暂无记录"}}</td></tr>
{{end}}
</tbody></table>

<div class="pager">
{{if .PrevHref}}<a href="{{.PrevHref}}">{{t $.Lang "← 上一页"}}</a>{{else}}<span class="off">{{t $.Lang "← 上一页"}}</span>{{end}}
<span>{{t $.Lang "第"}} {{.Page}} {{t $.Lang "页"}}</span>
{{if .NextHref}}<a href="{{.NextHref}}">{{t $.Lang "下一页 →"}}</a>{{else}}<span class="off">{{t $.Lang "下一页 →"}}</span>{{end}}
</div>
</body></html>`))

// auditChangeRaw mirrors ChangeField's JSON shape for decoding a stored
// changes column back out. It's a separate type (rather than reusing
// ChangeField directly) only because that's clearer about which direction
// this file's code moves in — DB JSON in, display string out — though the
// wire shape is identical on purpose.
type auditChangeRaw struct {
	Field string `json:"field"`
	Old   any    `json:"old"`
	New   any    `json:"new"`
}

// renderAuditChanges turns a stored changes JSON array into a compact,
// one-line, human-readable string for the audit table's "变更" column.
// Values are storage-layer raw (bytes/seconds, see AuditEntry.Changes'
// doc comment) — this deliberately does NOT invent a bytes/duration
// formatter per field (there's no reliable way to know which fields are
// which unit from the JSON alone); "field: old → new" is enough to make
// the row legible, and the raw numbers are still there for anyone who
// needs the exact value.
//
// An empty array ("[]", encodeChanges' floor value) renders as "—", never
// the literal "[]" — a bare bracket pair reads as a rendering bug, not as
// "nothing changed".
func renderAuditChanges(lang, raw string) string {
	var fields []auditChangeRaw
	if err := json.Unmarshal([]byte(raw), &fields); err != nil || len(fields) == 0 {
		return "—"
	}
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		old := adminT(lang, "(新增)")
		if f.Old != nil {
			old = formatChangeValue(f.Old)
		}
		parts = append(parts, fmt.Sprintf("%s: %s → %s", f.Field, old, formatChangeValue(f.New)))
	}
	return strings.Join(parts, "; ")
}

// formatChangeValue stringifies one ChangeField Old/New value for display.
// encoding/json decodes every JSON number into a Go float64, and fmt.Sprint
// on a float64 the size of a byte count (e.g. 104857600) prints in
// scientific notation ("1.048576e+08") — technically correct, unreadable in
// a log. 'f'/-1 asks strconv for the shortest decimal representation with no
// exponent, which round-trips whole numbers (the overwhelming majority of
// this column's values: bytes, seconds, counts) back to plain digits.
func formatChangeValue(v any) string {
	if f, ok := v.(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

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
