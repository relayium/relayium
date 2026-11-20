package account

import (
	"context"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/relayium/relayium/httpx"
)

const adminBrowserCookie = "relayium_admin_browser"
const adminBrowserAuthorizePath = "/authorize-browser"

func ValidateAdminBrowserPolicy(path, allowedIPs string, trap bool) error {
	if trap && (path == DefaultAdminPath || strings.TrimSpace(allowedIPs) == "") {
		return errors.New("admin legacy-path trap requires a custom admin path and a nonempty admin IP allowlist")
	}
	return nil
}

type adminBrowserStore interface {
	AdminBrowserAuthorized(context.Context, string, string, string, int64) (bool, error)
	RedeemAdminBrowserGrant(context.Context, string, string, string, int64) (string, error)
}

// Only the exact authorization page/POST bypass this layer. IP admission,
// Passkey sign-in and sensitive-action confirmation remain separate gates.
func (s *Service) adminBrowserGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !s.cfg.AdminBrowserRequired {
			next.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == s.AdminPath()+adminBrowserAuthorizePath && (r.Method == http.MethodGet || r.Method == http.MethodPost) {
			next.ServeHTTP(w, r)
			return
		}
		c, err := r.Cookie(adminBrowserCookie)
		if err != nil || c.Value == "" {
			http.Error(w, "browser authorization required", http.StatusForbidden)
			return
		}
		st, ok := s.store.(adminBrowserStore)
		if !ok {
			http.Error(w, "browser authorization unavailable", http.StatusServiceUnavailable)
			return
		}
		accepted, err := st.AdminBrowserAuthorized(r.Context(), c.Value, s.selfOrigin(), s.AdminPath(), s.now().Unix())
		if err != nil {
			http.Error(w, "browser authorization unavailable", http.StatusServiceUnavailable)
			return
		}
		if !accepted {
			http.Error(w, "browser authorization required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// No query token is read. The CLI link carries its capability in a fragment;
// the page removes it from history before the same-origin JSON POST.
var adminBrowserTmpl = template.Must(template.New("browser-authorize").Parse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Relayium browser authorization</title></head><body><h1>Relayium</h1><p id="status">Authorizing this browser / 正在授权此浏览器…</p><script nonce="{{.Nonce}}">
const status=document.getElementById('status');const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
(async()=>{if(!/^[a-f0-9]{64}$/.test(token))throw Error();const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({token})});if(!response.ok)throw Error();location.replace({{.AdminPath}});})().catch(()=>{status.textContent='Authorization failed or link expired. Request a new link from the server. / 授权失败或链接已失效，请从服务器重新生成。';});
</script></body></html>`))

func (s *Service) handleAdminBrowserAuthorizePage(w http.ResponseWriter, r *http.Request) {
	adminEnrollNoStore(w)
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = adminBrowserTmpl.Execute(w, struct {
		adminRouteData
		Nonce string
	}{s.adminRouteData(), CSPNonce(r)})
}
func (s *Service) handleAdminBrowserAuthorize(w http.ResponseWriter, r *http.Request) {
	adminEnrollNoStore(w)
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "invalid request", http.StatusUnsupportedMediaType)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2048)
	defer r.Body.Close()
	var data struct {
		Token string `json:"token"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&data); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	st, ok := s.store.(adminBrowserStore)
	if !ok {
		http.Error(w, "browser authorization unavailable", http.StatusServiceUnavailable)
		return
	}
	token, err := st.RedeemAdminBrowserGrant(r.Context(), data.Token, s.selfOrigin(), s.AdminPath(), s.now().Unix())
	if errors.Is(err, ErrAdminBrowserGrant) {
		http.Error(w, "authorization refused", http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, "browser authorization unavailable", http.StatusServiceUnavailable)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: adminBrowserCookie, Value: token, Path: s.AdminPath(), HttpOnly: true, Secure: s.CookieSecure(), SameSite: http.SameSiteStrictMode, MaxAge: int(adminBrowserLifetime / time.Second), Expires: s.now().Add(adminBrowserLifetime)})
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type adminIPBanStore interface {
	BanAdminIP(context.Context, string) error
}

func (s *Service) adminLegacyTrap() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ip, err := s.adminAccess.clientIP(r)
		if err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		st, ok := s.store.(adminIPBanStore)
		if !ok {
			http.Error(w, "admin access unavailable", http.StatusServiceUnavailable)
			return
		}
		if err = st.BanAdminIP(r.Context(), ip.String()); err != nil {
			http.Error(w, "admin access unavailable", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
	})
}

// The legacy trap has no whitelist exemption. It reuses the existing durable
// admin-only ban state; local CLI unblocking remains the sole recovery path.
func (s *SQLiteStore) BanAdminIP(ctx context.Context, ip string) error {
	parsed, err := parseAdminIP(ip)
	if err != nil {
		return err
	}
	ip = parsed.String()
	result, err := s.db.ExecContext(ctx, `INSERT INTO admin_ip_access(ip,attempts)
 SELECT ?,4 WHERE (SELECT count(*) FROM admin_ip_access) < ? OR EXISTS(SELECT 1 FROM admin_ip_access WHERE ip=?)
 ON CONFLICT(ip) DO UPDATE SET attempts=4`, ip, adminAccessCapacity, ip)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("admin access capacity reached")
	}
	return nil
}

// AdminLegacyTrapGuard must wrap the root mux so its path-cleaning redirects
// cannot exempt an old-entry probe (including encoded and dot-segment paths).
func (s *Service) AdminLegacyTrapGuard(next http.Handler) http.Handler {
	if !s.AdminEnabled() || !s.cfg.AdminLegacyTrap {
		return next
	}
	trap := s.adminLegacyTrap()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := "/" + strings.TrimLeft(r.URL.Path, "/")
		clean := path.Clean(raw)
		if raw == DefaultAdminPath || strings.HasPrefix(raw, DefaultAdminPath+"/") || clean == DefaultAdminPath || strings.HasPrefix(clean, DefaultAdminPath+"/") {
			trap.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
