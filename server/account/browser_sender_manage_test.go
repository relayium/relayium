package account

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

// The web /me page manages browser sending identities through the existing
// GET /api/devices and DELETE /api/devices/{id} (web MePage.browser-senders).
// These are the promises its copy makes, checked over real HTTP against the
// real SQLite store rather than by calling DeleteDevice directly: the list is
// the account's own, a removal frees one of the MaxBrowserDevicesPerAccount
// places, the removed browser's next install is refused once, its account
// session is untouched, and what it already sent is kept.
func TestBrowserSenderIdentityManagedOverHTTP(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "browser-manage@example.test")
	other := h.user(t, "browser-manage-other@example.test")
	session := h.cookie(t, u)
	withSession := func(r *http.Request) { r.AddCookie(session) }

	cookies := make([]*http.Cookie, 0, MaxBrowserDevicesPerAccount)
	ids := make([]string, 0, MaxBrowserDevicesPerAccount)
	for range MaxBrowserDevicesPerAccount {
		c, id := installBrowser(t, h, u)
		cookies, ids = append(cookies, c), append(ids, id)
	}
	full := h.jsonDo(t, http.MethodPost, "/api/devices/browser-install", `{}`, withSession)
	if full.StatusCode != http.StatusConflict || apiErrorCode(t, full) != "browser_device_limit" {
		t.Fatalf("21st browser = %d, want browser_device_limit", full.StatusCode)
	}

	// Something the first browser already sent.
	target := h.enrolTarget(t, u, "target", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 64, time.Hour)
	created := h.createTask(t, target.deviceID, createOpts{idem: "manage-sent-1", fileID: fileID,
		keyID: target.keyID, keyGen: target.keyGen,
		authMutate: func(r *http.Request) { r.AddCookie(session); r.AddCookie(cookies[0]) }})
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d", created.StatusCode)
	}
	taskID := decodeJSONBody(t, created)["task"].(map[string]any)["ID"].(string)

	browserRows := func(c *http.Cookie) map[string]bool {
		t.Helper()
		resp := h.jsonDo(t, http.MethodGet, "/api/devices", "", func(r *http.Request) { r.AddCookie(c) })
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("list devices = %d", resp.StatusCode)
		}
		out := map[string]bool{}
		for _, raw := range decodeJSONBody(t, resp)["devices"].([]any) {
			d := raw.(map[string]any)
			if d["Kind"] == "browser" {
				out[d["ID"].(string)] = true
			}
		}
		return out
	}
	if got := browserRows(session); len(got) != MaxBrowserDevicesPerAccount || !got[ids[0]] {
		t.Fatalf("owner lists %d browser rows, want %d including %s", len(got), MaxBrowserDevicesPerAccount, ids[0])
	}
	otherSession := h.cookie(t, other)
	if got := browserRows(otherSession); len(got) != 0 {
		t.Fatalf("another account lists %d of this account's browser rows", len(got))
	}

	del := func(c *http.Cookie, id string) *http.Response {
		return h.jsonDo(t, http.MethodDelete, "/api/devices/"+url.PathEscape(id), "",
			func(r *http.Request) { r.AddCookie(c) })
	}
	// Another account's DELETE is scoped out by user_id: nothing is removed.
	del(otherSession, ids[0])
	if got := browserRows(session); !got[ids[0]] {
		t.Fatal("another account's DELETE removed this account's browser identity")
	}

	if resp := del(session, ids[0]); resp.StatusCode != http.StatusOK {
		t.Fatalf("owner DELETE = %d", resp.StatusCode)
	}
	if got := browserRows(session); len(got) != MaxBrowserDevicesPerAccount-1 || got[ids[0]] {
		t.Fatalf("after removal: %d rows, removed row still listed = %v", len(got), got[ids[0]])
	}

	// Removing a sending identity is not a sign-out.
	if me := h.jsonDo(t, http.MethodGet, "/api/me", "", withSession); me.StatusCode != http.StatusOK {
		t.Fatalf("account session after removal = %d, want 200", me.StatusCode)
	}
	// What it already sent is kept, with its authenticated source.
	task, ok, err := h.store.GetInboxTask(t.Context(), taskID, u, h.nowUnix())
	if err != nil || !ok {
		t.Fatalf("task sent before removal: ok=%v err=%v", ok, err)
	}
	if task.SourceDeviceID != ids[0] {
		t.Fatalf("task source = %q, want %q", task.SourceDeviceID, ids[0])
	}
	// The removed browser's next install is refused once and its cookie expired…
	again := h.jsonDo(t, http.MethodPost, "/api/devices/browser-install", `{}`,
		func(r *http.Request) { r.AddCookie(session); r.AddCookie(cookies[0]) })
	if again.StatusCode != http.StatusConflict || apiErrorCode(t, again) != "browser_device_revoked" {
		t.Fatalf("removed browser install = %d, want browser_device_revoked", again.StatusCode)
	}
	// …and the freed place lets a browser register again.
	if _, id := installBrowser(t, h, u); id == ids[0] {
		t.Fatal("re-registration reused the removed identity")
	}
	// A browser that was not removed still converges on its own row.
	kept := h.jsonDo(t, http.MethodPost, "/api/devices/browser-install", `{}`,
		func(r *http.Request) { r.AddCookie(session); r.AddCookie(cookies[1]) })
	if kept.StatusCode != http.StatusOK || decodeJSONBody(t, kept)["deviceId"] != ids[1] {
		t.Fatalf("untouched browser install = %d, want its existing row", kept.StatusCode)
	}
}
