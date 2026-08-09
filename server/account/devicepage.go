package account

import (
	"html/template"
	"net/http"
)

// devicePageData feeds devicePageTmpl. Code and Email are attacker- and
// user-influenced respectively (Code comes straight from the ?code= query
// param) — html/template auto-escapes both wherever they're interpolated,
// so neither can break out of the HTML attribute/text it's placed in.
type devicePageData struct {
	SignedIn bool
	Email    string
	Code     string
	Nonce    string // per-request CSP script nonce, stamped on the inline script tags
}

// devicePageTmpl renders the browser landing page a CLI login flow sends a
// human to (verification_uri = <BaseURL>/device, RFC 8628-style). The
// approve control below does NOT use a native <form method=post> — the
// approve endpoint (handleDeviceApprove) decodes a JSON body, and a native
// form submit would send application/x-www-form-urlencoded, which the JSON
// decoder rejects with 400. Instead it does a same-origin fetch() with a
// JSON body; CSRFGuard only rejects unsafe methods when Origin is present
// AND mismatched (see CSRFGuard in handlers.go), and a same-origin fetch
// always sends a matching Origin, so this passes without a separate CSRF
// token.
var devicePageTmpl = template.Must(template.New("device").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium · Approve CLI Login</title>
<style>:root{--a:#7c3aad;--bg:#faf9fb;--fg:#1a1420;--bd:#e5e4e7;--card:#fff}
@media(prefers-color-scheme:dark){:root{--a:#c084fc;--bg:#16171d;--fg:#f3f4f6;--bd:#2e303a;--card:#1c1d25}}
*{box-sizing:border-box}
body{font:15px system-ui;max-width:420px;margin:80px auto;padding:0 16px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px}
input{font:inherit;padding:9px 11px;width:100%;margin:6px 0;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);letter-spacing:.05em;text-transform:uppercase}
button{font:inherit;font-weight:500;padding:10px 11px;width:100%;margin:10px 0 0;border:0;border-radius:8px;background:var(--a);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.07)}
button:disabled{opacity:.6;cursor:default}
:focus-visible{outline:2px solid var(--a);outline-offset:2px}
#msg{margin-top:12px;font-size:14px}
.ok{color:#2f9e44}.err{color:#e5484d}
.warn{margin:14px 0 0;padding:11px 13px;border-radius:8px;font-size:13.5px;line-height:1.5;background:rgba(229,72,77,.09);border:1px solid rgba(229,72,77,.35)}
.details{margin:12px 0 0;padding:10px 12px;border-radius:8px;font-size:13px;line-height:1.5;background:var(--bg);border:1px solid var(--bd);word-break:break-word}
.details b{font-weight:600}
.muted{opacity:.7}
a{color:var(--a)}</style></head>
<body>
{{if .SignedIn}}
<h1>Approve CLI login</h1>
<div class="card">
<p>Signed in as <strong>{{.Email}}</strong>. Confirm the code shown by the app or terminal that asked, to bind this login to your account.</p>
<input id="user_code" type="text" value="{{.Code}}" placeholder="WDJB-MJHT" autocomplete="off" autocapitalize="characters" spellcheck="false">
<div id="details" class="details" style="display:none"></div>
<p class="warn">⚠️ Approving grants a device full CLI access to your account. Only approve if <b>you</b> just ran <code>relayium login</code> on your own device and this code matches your terminal. If someone sent you this link or code, do <b>not</b> approve.</p>
<button id="approve-btn" type="button">Approve</button>
<div id="msg"></div>
</div>
<script nonce="{{.Nonce}}">
// Show what a code is authorizing (origin + how long ago) so a phished user has
// a chance to notice an unfamiliar device before approving. Best-effort: a fetch
// failure just hides the panel, it never blocks approval.
function relTime(sec) {
  var d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  return Math.floor(d / 3600) + 'h ago';
}
function loadDetails() {
  var code = document.getElementById('user_code').value.trim();
  var box = document.getElementById('details');
  if (!code) { box.style.display = 'none'; return; }
  fetch('/api/cli/device/pending?user_code=' + encodeURIComponent(code), { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.found) { box.style.display = 'none'; return; }
      box.textContent = '';
      var line = document.createElement('div');
      line.innerHTML = '<b>Login request</b> started ' + relTime(d.started_at);
      box.appendChild(line);
      // The label this login will register, so the name that appears in My
      // Devices is one the person saw in their own terminal first. textContent,
      // never innerHTML: the label is client-supplied, and central's
      // sanitization bounds what it can contain, not what it can look like.
      if (d.device_name) {
        var named = document.createElement('div');
        named.textContent = 'will appear in My Devices as “' + d.device_name + '”';
        box.appendChild(named);
      }
      var origin = document.createElement('div');
      origin.className = 'muted';
      origin.textContent = 'from ' + (d.client_ip || 'unknown IP') + (d.user_agent ? ' · ' + d.user_agent : '');
      box.appendChild(origin);
      box.style.display = 'block';
    })
    .catch(function () { box.style.display = 'none'; });
}
document.getElementById('user_code').addEventListener('input', loadDetails);
if (document.getElementById('user_code').value.trim()) loadDetails();
</script>
<script nonce="{{.Nonce}}">
document.getElementById('approve-btn').addEventListener('click', function () {
  var btn = document.getElementById('approve-btn');
  var msg = document.getElementById('msg');
  var code = document.getElementById('user_code').value.trim();
  if (!code) { msg.textContent = 'Enter the code shown in your terminal.'; msg.className = 'err'; return; }
  btn.disabled = true;
  msg.textContent = '';
  msg.className = '';
  fetch('/api/cli/device/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ user_code: code })
  }).then(function (resp) {
    return resp.json().then(function (data) { return { ok: resp.ok, data: data }; });
  }).then(function (result) {
    if (result.ok && result.data && result.data.status === 'ok') {
      msg.textContent = 'Approved — signed in to the CLI as ' + result.data.account_email + '. You can return to your terminal.';
      msg.className = 'ok';
    } else {
      msg.textContent = 'Could not approve: ' + ((result.data && result.data.error) || 'invalid or expired code');
      msg.className = 'err';
      btn.disabled = false;
    }
  }).catch(function () {
    msg.textContent = 'Network error — please try again.';
    msg.className = 'err';
    btn.disabled = false;
  });
});
</script>
{{else}}
<h1>Sign in required</h1>
<div class="card">
<p>Please sign in first, then come back to this page to approve the CLI login.</p>
<p><a href="/">sign in</a></p>
</div>
{{end}}
</body></html>`))

// RegisterDevicePage mounts the human-facing CLI-login approval page on the
// ROOT mux at GET /device (the verification_uri the CLI prints). It must live on
// the root mux, not on Routes()' /api/-mounted sub-mux, where its pattern would
// be unreachable and the request would fall through to the SPA shell.
func (s *Service) RegisterDevicePage(mux *http.ServeMux) {
	mux.HandleFunc("GET /device", s.handleDevicePage)
}

// handleDevicePage serves the browser landing page for CLI device-code
// login approval (verification_uri = <BaseURL>/device). Anonymous visitors
// are prompted to sign in; a signed-in session sees which account the
// login will be bound to and a control to approve the code (prefilled from
// ?code= when the CLI's instructions included it).
func (s *Service) handleDevicePage(w http.ResponseWriter, r *http.Request) {
	u, ok := s.UserFromRequest(r)
	data := devicePageData{
		SignedIn: ok,
		Code:     r.URL.Query().Get("code"),
		Nonce:    CSPNonce(r),
	}
	if ok {
		data.Email = u.Email
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := devicePageTmpl.Execute(w, data); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}
