package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReporterRegisterAndHeartbeat(t *testing.T) {
	var gotAuth string
	var gotHB heartbeatBody
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/api/nodes/register":
			json.NewEncoder(w).Encode(map[string]any{"nodeID": "srv-assigned", "heartbeatInterval": 30})
		case "/api/nodes/heartbeat":
			json.NewDecoder(r.Body).Decode(&gotHB)
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	rp := newReporter(srv.URL, "fleet-secret")
	rr, err := rp.register(registerBody{TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Region: "asia", Version: "0.3.0", Capabilities: []string{"relay"}})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if rr.NodeID != "srv-assigned" || rr.HeartbeatInterval != 30 {
		t.Fatalf("got id=%q interval=%d", rr.NodeID, rr.HeartbeatInterval)
	}
	if gotAuth != "Bearer fleet-secret" {
		t.Fatalf("auth header=%q", gotAuth)
	}

	if _, err := rp.heartbeat(heartbeatBody{NodeID: rr.NodeID, Status: "ok", RelayedTotal: 900,
		Usage: []usageItem{{AllocID: "a1", Username: "6000:userX.1", RelayedBytes: 900}}}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if gotHB.NodeID != "srv-assigned" || len(gotHB.Usage) != 1 || gotHB.Usage[0].RelayedBytes != 900 {
		t.Fatalf("server got %+v", gotHB)
	}
}

func TestReporterHeartbeatGoneError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer srv.Close()
	rp := newReporter(srv.URL, "t")
	if _, err := rp.heartbeat(heartbeatBody{NodeID: "x"}); err == nil {
		t.Fatal("expected error on 410")
	}
}
