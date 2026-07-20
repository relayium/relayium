package account

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// TestAuditPageRequiresAdmin is the load-bearing security test for this task:
// GET /admin/audit without an admin session must redirect to /admin and must
// NOT leak any audit rows in the response body. Unlike the write handlers
// (401 unauthorized), this read page redirects — same treatment as GET /admin
// itself — because it's meant to be hit by a browser navigating in, not by a
// fetch() call.
func TestAuditPageRequiresAdmin(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	if err := store.InsertAudit(context.Background(), AuditEntry{
		At: 1000, Actor: "admin", IP: "1.2.3.4", Auth: "password",
		Action: AuditLoginOK, Target: "-", Changes: "[]", StepUp: StepUpNone,
	}); err != nil {
		t.Fatal(err)
	}

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/admin/audit")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("want 302, got %d", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/admin" {
		t.Fatalf("want redirect to /admin, got %q", loc)
	}
	body := readAll(t, resp)
	if strings.Contains(body, AuditLoginOK) {
		t.Fatalf("unauthenticated response leaked audit data: %s", body)
	}
}

func TestAuditPageShowsEntries(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	if err := store.InsertAudit(ctx, AuditEntry{
		At: 2000, Actor: "admin", IP: "9.9.9.9", Auth: "password",
		Action: AuditNodeLabel, Target: "node:seed-target-1", Changes: "[]", StepUp: StepUpNone,
	}); err != nil {
		t.Fatal(err)
	}

	cookie := adminLoginCookie(t, ts)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/admin/audit", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, AuditNodeLabel) {
		t.Fatalf("response missing action %q: %s", AuditNodeLabel, body)
	}
	if !strings.Contains(body, "node:seed-target-1") {
		t.Fatalf("response missing target: %s", body)
	}
}

func TestAuditPageFiltersByAction(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	// Distinct Target markers, not the action names, are what this test
	// asserts on: the action filter dropdown legitimately lists every known
	// action constant (including AuditLogout) regardless of which rows are
	// showing, so asserting on the action name would spuriously match the
	// dropdown's own option text rather than row data.
	if err := store.InsertAudit(ctx, AuditEntry{
		At: 3000, Actor: "admin", IP: "1.1.1.1", Auth: "password",
		Action: AuditLoginOK, Target: "audit-marker-loginok", Changes: "[]", StepUp: StepUpNone,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.InsertAudit(ctx, AuditEntry{
		At: 3001, Actor: "admin", IP: "2.2.2.2", Auth: "password",
		Action: AuditLogout, Target: "audit-marker-logout", Changes: "[]", StepUp: StepUpNone,
	}); err != nil {
		t.Fatal(err)
	}

	cookie := adminLoginCookie(t, ts)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/admin/audit?action="+AuditLoginOK, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := readAll(t, resp)
	if !strings.Contains(body, "audit-marker-loginok") {
		t.Fatalf("response missing filtered-in row: %s", body)
	}
	if strings.Contains(body, "audit-marker-logout") {
		t.Fatalf("response leaked row from a different action: %s", body)
	}
}

func TestAuditPagePaging(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	const total = 105
	for i := 0; i < total; i++ {
		if err := store.InsertAudit(ctx, AuditEntry{
			At: int64(10_000 + i), Actor: "admin", IP: "1.2.3.4", Auth: "password",
			Action: AuditSettings, Target: fmt.Sprintf("seedrow-%03d", i), Changes: "[]", StepUp: StepUpNone,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Newest row (highest At) is seedrow-104; oldest is seedrow-000. Page 1
	// (newest-first, 100/page) must hold rows 5..104 and NOT row 000; page 2
	// must hold row 000 and NOT row 104.
	cookie := adminLoginCookie(t, ts)

	get := func(path string) string {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		req.AddCookie(cookie)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return readAll(t, resp)
	}

	page1 := get("/admin/audit")
	if !strings.Contains(page1, "seedrow-104") {
		t.Fatalf("page 1 missing newest row seedrow-104")
	}
	if strings.Contains(page1, "seedrow-000") {
		t.Fatalf("page 1 leaked oldest row seedrow-000, paging is broken")
	}

	page2 := get("/admin/audit?page=2")
	if !strings.Contains(page2, "seedrow-000") {
		t.Fatalf("page 2 missing oldest row seedrow-000")
	}
	if strings.Contains(page2, "seedrow-104") {
		t.Fatalf("page 2 unexpectedly contains page-1-only row seedrow-104")
	}
}

func TestAuditPageEmptyChangesRendersDash(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	if err := store.InsertAudit(ctx, AuditEntry{
		At: 4000, Actor: "admin", IP: "1.1.1.1", Auth: "password",
		Action: AuditLogout, Target: "-", Changes: "[]", StepUp: StepUpNone,
	}); err != nil {
		t.Fatal(err)
	}

	cookie := adminLoginCookie(t, ts)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/admin/audit", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := readAll(t, resp)
	if !strings.Contains(body, "<td>—</td>") {
		t.Fatalf("empty changes did not render as an em dash: %s", body)
	}
	if strings.Contains(body, "<td>[]</td>") {
		t.Fatalf("empty changes rendered the literal JSON \"[]\": %s", body)
	}
}
