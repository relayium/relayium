package account

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/devicelabel"
)

// The account-visible CLI device label (DECISION-LOG 2026-08-04). Before this,
// every `relayium login` produced a row named literally "CLI", so an account
// with three servers in it showed three identical rows and a destructive
// Revoke next to each. These tests pin the two halves that make the row
// identifiable: the label is bound to the pending request the browser approves,
// and nothing a client can put in it survives into the confirmation sentence.

// startWithName runs POST /api/cli/device/start with an optional JSON body and
// returns the flow's user_code and device_code.
func startWithName(t *testing.T, ts *http.Client, base, body string) (userCode, deviceCode string) {
	t.Helper()
	start := doJSONMap(t, ts, base+"/api/cli/device/start", nil, body)
	userCode, _ = start["user_code"].(string)
	deviceCode, _ = start["device_code"].(string)
	if userCode == "" || deviceCode == "" {
		t.Fatalf("start missing codes: %+v", start)
	}
	return userCode, deviceCode
}

// approvedDeviceName drives one whole login (start with the given body, approve
// as email, poll) and returns the name of the CLI device it created.
func approvedDeviceName(t *testing.T, startBody, email string) string {
	t.Helper()
	ts, store, mail := newUserNodesServer(t)
	client := ts.Client()
	userCode, deviceCode := startWithName(t, client, ts.URL, startBody)

	cookie := loginCookie(t, ts, mail, email)
	approve := doJSONMap(t, client, ts.URL+"/api/cli/device/approve", cookie, `{"user_code":"`+userCode+`"}`)
	if approve["status"] != "ok" {
		t.Fatalf("approve failed: %+v", approve)
	}
	if p := doJSONMap(t, client, ts.URL+"/api/cli/device/poll", nil, `{"device_code":"`+deviceCode+`"}`); p["status"] != "ok" {
		t.Fatalf("poll after approve: %+v", p)
	}

	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, email, "")
	if err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	devs, err := store.ListDevices(ctx, u.ID)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	for _, d := range devs {
		if d.Kind == "cli" {
			return d.Name
		}
	}
	t.Fatal("login created no cli device")
	return ""
}

func TestDeviceStartBindsLabelThroughApproval(t *testing.T) {
	// The whole point of carrying the label on the START request: the row that
	// appears in the account is the one the terminal printed and the browser
	// approved, not something decided afterwards.
	if got := approvedDeviceName(t, `{"device_name":"prod-backup-1"}`, "label@example.com"); got != "prod-backup-1" {
		t.Fatalf("device name = %q, want prod-backup-1", got)
	}
}

func TestDeviceStartWithoutLabelKeepsHistoricalName(t *testing.T) {
	// A CLI built before labels existed posts no body at all, which decodes as
	// io.EOF. If that were treated as a bad request, `relayium login` would stop
	// working on every installed CLI the moment this shipped.
	for _, body := range []string{"", `{}`, `{"device_name":""}`} {
		t.Run("body="+body, func(t *testing.T) {
			if got := approvedDeviceName(t, body, "legacy"+strings.Repeat("x", len(body))+"@example.com"); got != devicelabel.Fallback {
				t.Fatalf("device name = %q, want %q", got, devicelabel.Fallback)
			}
		})
	}
}

func TestDeviceStartRefusesAnUnparseableBody(t *testing.T) {
	// An empty body is a pre-label CLI and must work. Anything else that fails
	// to decode is refused rather than quietly minting a device code — including
	// an oversized body, where DecodeJSONBody's MaxBytesReader has already
	// marked the response too large and a 200 would be unusable.
	ts, _ := newTestServer(t)
	// Trailing JSON values are NOT in this list: DecodeJSONBody is the lenient
	// decoder every handler here uses, and DecodeStrictJSONBody is the one that
	// rejects them. Asserting otherwise would pin a property of the shared
	// helper that this endpoint does not get to choose.
	for _, body := range []string{`{"device_name":`, `not json at all`, `[1,2,3]`} {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/cli/device/start", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %q got status %d, want 400", body, resp.StatusCode)
		}
	}
}

func TestDeviceStartSanitizesHostileLabel(t *testing.T) {
	// A client is free to send anything. What it must not be able to do is put a
	// direction override, a newline or 4KB of text into the sentence a user
	// reads before revoking a device.
	cases := []struct {
		name, body, want string
	}{
		{
			name: "bidi override",
			body: `{"device_name":"prod\u202Ekcab"}`,
			want: "prodkcab",
		},
		{
			name: "embedded newline",
			body: `{"device_name":"prod\nRevoked: no"}`,
			want: "prod Revoked: no",
		},
		{
			name: "control characters only",
			body: `{"device_name":" \u0000\u0007\u200B "}`,
			want: devicelabel.Fallback,
		},
		{
			name: "over-long",
			body: `{"device_name":"` + strings.Repeat("z", 500) + `"}`,
			want: strings.Repeat("z", devicelabel.MaxRunes),
		},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := approvedDeviceName(t, c.body, string(rune('a'+i))+"hostile@example.com")
			if got != c.want {
				t.Fatalf("device name = %q, want %q", got, c.want)
			}
		})
	}
}

func TestDevicePendingShowsTheLabelBeingApproved(t *testing.T) {
	// The browser has to show the same label the terminal printed, or "approve
	// the identity you were shown" is not something a user can actually do.
	ts, mail := newTestServer(t)
	client := ts.Client()
	userCode, _ := startWithName(t, client, ts.URL, `{"device_name":"nas-01\u202E"}`)

	cookie := loginCookie(t, ts, mail, "pendinglabel@example.com")
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/cli/device/pending?user_code="+userCode, nil)
	req.AddCookie(cookie)
	r, err := client.Do(req)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	defer r.Body.Close()
	var d map[string]any
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if d["found"] != true {
		t.Fatalf("pending should be found: %+v", d)
	}
	// Sanitized at start, so what the approval page renders can never contain
	// the override even though the client sent one.
	if d["device_name"] != "nas-01" {
		t.Fatalf("device_name = %v, want nas-01", d["device_name"])
	}
}

func TestApproveCannotRenameTheDeviceItApproves(t *testing.T) {
	// The approve endpoint takes a user_code and nothing else. A browser that
	// tries to supply its own label must not be able to name the device
	// something the terminal never displayed — that would defeat binding the
	// label to the pending request in the first place.
	if got := approvedDeviceName(t, `{"device_name":"real-machine"}`, "approvename@example.com"); got != "real-machine" {
		t.Fatalf("device name = %q, want real-machine", got)
	}
}

// renameDevice PATCHes a new name and returns the status code plus the decoded
// error token (empty when the response carried none).
func renameDevice(t *testing.T, ts *http.Client, base, id string, cookie *http.Cookie, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPatch, base+"/api/devices/"+id, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	resp, err := ts.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	code, _ := out["error"].(string)
	return resp.StatusCode, code
}

func TestRenameDeviceValidatesLabel(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	client := ts.Client()
	cookie := loginCookie(t, ts, mail, "rename@example.com")
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "rename@example.com", "")
	if err != nil {
		t.Fatalf("user: %v", err)
	}
	dev, err := store.UpsertDevice(ctx, Device{ID: "dev-rename", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatalf("device: %v", err)
	}

	// Accepted, stored exactly.
	if status, _ := renameDevice(t, client, ts.URL, dev.ID, cookie, `{"name":"prod-backup-1"}`); status != http.StatusOK {
		t.Fatalf("ordinary rename got %d", status)
	}
	if name := deviceName(t, store, u.ID, dev.ID); name != "prod-backup-1" {
		t.Fatalf("stored name = %q", name)
	}

	// Whitespace is normalized without complaint: nobody types a trailing space
	// on purpose, and refusing one would be pedantry rather than protection.
	if status, _ := renameDevice(t, client, ts.URL, dev.ID, cookie, `{"name":"  office   NAS  "}`); status != http.StatusOK {
		t.Fatalf("whitespace rename got %d", status)
	}
	if name := deviceName(t, store, u.ID, dev.ID); name != "office NAS" {
		t.Fatalf("stored name = %q, want normalized whitespace", name)
	}
	// An embedded newline is whitespace too: a paste that carried one is
	// flattened onto the single line the row renders, not refused.
	if status, _ := renameDevice(t, client, ts.URL, dev.ID, cookie, `{"name":"prod\nbackup"}`); status != http.StatusOK {
		t.Fatalf("newline rename got %d", status)
	}
	const kept = "prod backup"
	if name := deviceName(t, store, u.ID, dev.ID); name != kept {
		t.Fatalf("stored name = %q, want %q", name, kept)
	}

	// Everything a person did not mean to type is REFUSED, not silently
	// altered. Storing a different string than the one they entered would leave
	// them identifying machines by a name they never chose.
	for _, c := range []struct{ name, body string }{
		{"bidi override", `{"name":"prod\u202Ekcab"}`},
		{"zero width", `{"name":"pro\u200Bd"}`},
		{"control byte", `{"name":"prod\u0007"}`},
		{"too long", `{"name":"` + strings.Repeat("z", devicelabel.MaxRunes+1) + `"}`},
		{"whitespace only", `{"name":"   "}`},
		{"invisible only", `{"name":"\u200B\u200B"}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			status, code := renameDevice(t, client, ts.URL, dev.ID, cookie, c.body)
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", status)
			}
			if code != "invalid_device_name" {
				t.Fatalf("error = %q, want invalid_device_name", code)
			}
			if name := deviceName(t, store, u.ID, dev.ID); name != kept {
				t.Fatalf("a refused rename still changed the stored name to %q", name)
			}
		})
	}
}

func TestRenameDeviceAllowsDuplicateLabels(t *testing.T) {
	// Duplicates stay legal on purpose: two machines really can be called
	// "backup", and the account list disambiguates them with a suffix of the
	// opaque device id rather than by forbidding the name.
	ts, store, mail := newUserNodesServer(t)
	client := ts.Client()
	cookie := loginCookie(t, ts, mail, "dupes@example.com")
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "dupes@example.com", "")
	for _, id := range []string{"dup-a", "dup-b"} {
		if _, err := store.UpsertDevice(ctx, Device{ID: id, UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1}); err != nil {
			t.Fatalf("device %s: %v", id, err)
		}
		if status, code := renameDevice(t, client, ts.URL, id, cookie, `{"name":"backup"}`); status != http.StatusOK {
			t.Fatalf("rename %s got %d %q", id, status, code)
		}
	}
	if a, b := deviceName(t, store, u.ID, "dup-a"), deviceName(t, store, u.ID, "dup-b"); a != "backup" || b != "backup" {
		t.Fatalf("duplicate labels were not both stored: %q / %q", a, b)
	}

	// …and revoking one of two identically named rows deletes only that exact
	// id. This is the destructive half of the requirement: the name cannot be
	// what selects the row.
	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/devices/dup-a", nil)
	req.AddCookie(cookie)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete status %d", resp.StatusCode)
	}
	devs, err := store.ListDevices(ctx, u.ID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var ids []string
	for _, d := range devs {
		ids = append(ids, d.ID)
	}
	if len(ids) != 1 || ids[0] != "dup-b" {
		t.Fatalf("revoking one of two identically named devices left %v, want [dup-b]", ids)
	}
}

func TestRenameDeviceDoesNotReportSuccessForMissingOrForeignRow(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	client := ts.Client()
	ownerCookie := loginCookie(t, ts, mail, "rename-owner@example.com")
	otherCookie := loginCookie(t, ts, mail, "rename-other@example.com")
	owner, _ := store.UpsertUserByEmail(context.Background(), "rename-owner@example.com", "")
	if _, err := store.UpsertDevice(context.Background(), Device{
		ID: "owner-device", UserID: owner.ID, Name: "owner", Kind: "cli", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("device: %v", err)
	}

	for _, c := range []struct {
		name   string
		id     string
		cookie *http.Cookie
	}{
		{"missing", "no-such-device", ownerCookie},
		{"foreign", "owner-device", otherCookie},
	} {
		t.Run(c.name, func(t *testing.T) {
			status, _ := renameDevice(t, client, ts.URL, c.id, c.cookie, `{"name":"new-name"}`)
			if status != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", status)
			}
		})
	}
}

// deviceName reads one device's stored name back out of the store.
func deviceName(t *testing.T, store Store, userID, deviceID string) string {
	t.Helper()
	devs, err := store.ListDevices(context.Background(), userID)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	for _, d := range devs {
		if d.ID == deviceID {
			return d.Name
		}
	}
	t.Fatalf("device %s not found", deviceID)
	return ""
}
