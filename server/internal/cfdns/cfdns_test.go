package cfdns

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeCF is a minimal Cloudflare DNS API: it lists, creates, and updates A
// records for one zone, recording what it was asked to do.
type fakeCF struct {
	records  map[string]string // recordID -> content(ip)
	nextID   int
	byName   map[string]string // name -> recordID
	lastAuth string
	creates  int
	updates  int
}

func newFakeCF() (*httptest.Server, *fakeCF) {
	f := &fakeCF{records: map[string]string{}, byName: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.lastAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/dns_records"):
			name := r.URL.Query().Get("name")
			var result []map[string]any
			if id, ok := f.byName[name]; ok {
				result = append(result, map[string]any{"id": id, "name": name, "content": f.records[id]})
			}
			json.NewEncoder(w).Encode(map[string]any{"success": true, "result": result})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/dns_records"):
			var body map[string]any
			b, _ := io.ReadAll(r.Body)
			json.Unmarshal(b, &body)
			f.nextID++
			id := "rec" + itoa(f.nextID)
			f.records[id] = body["content"].(string)
			f.byName[body["name"].(string)] = id
			f.creates++
			json.NewEncoder(w).Encode(map[string]any{"success": true, "result": map[string]any{"id": id}})
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/dns_records/"):
			id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			var body map[string]any
			b, _ := io.ReadAll(r.Body)
			json.Unmarshal(b, &body)
			f.records[id] = body["content"].(string)
			f.updates++
			json.NewEncoder(w).Encode(map[string]any{"success": true, "result": map[string]any{"id": id}})
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	return srv, f
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func TestUpsertACreatesWhenAbsent(t *testing.T) {
	srv, state := newFakeCF()
	defer srv.Close()
	c := &Client{Token: "cf-token", ZoneID: "zone1", HTTP: srv.Client(), Base: srv.URL}

	if err := c.UpsertA("node7.relayium.com", "203.0.113.7", true); err != nil {
		t.Fatalf("UpsertA create: %v", err)
	}
	if state.creates != 1 || state.updates != 0 {
		t.Fatalf("want one create, got creates=%d updates=%d", state.creates, state.updates)
	}
	if state.byName["node7.relayium.com"] == "" || state.records[state.byName["node7.relayium.com"]] != "203.0.113.7" {
		t.Fatalf("record not created with the right ip: %+v", state.records)
	}
	if state.lastAuth != "Bearer cf-token" {
		t.Fatalf("must send the API token as a bearer, got %q", state.lastAuth)
	}
}

func TestUpsertAUpdatesWhenPresent(t *testing.T) {
	srv, state := newFakeCF()
	defer srv.Close()
	c := &Client{Token: "cf-token", ZoneID: "zone1", HTTP: srv.Client(), Base: srv.URL}

	if err := c.UpsertA("node7.relayium.com", "203.0.113.7", true); err != nil {
		t.Fatal(err)
	}
	// Node's IP changed; a second upsert must UPDATE the existing record, not
	// create a duplicate.
	if err := c.UpsertA("node7.relayium.com", "203.0.113.99", true); err != nil {
		t.Fatal(err)
	}
	if state.creates != 1 || state.updates != 1 {
		t.Fatalf("want one create then one update, got creates=%d updates=%d", state.creates, state.updates)
	}
	if got := state.records[state.byName["node7.relayium.com"]]; got != "203.0.113.99" {
		t.Fatalf("record ip not updated, got %q", got)
	}
}
