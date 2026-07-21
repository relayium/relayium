package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func registerNode(t *testing.T, s *Service, bearer string, req nodeRegisterReq) nodeRegisterResp {
	t.Helper()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	body, _ := json.Marshal(req)
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+bearer)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register: %d body=%s", w.Code, w.Body)
	}
	var resp nodeRegisterResp
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	return resp
}

// A fleet node reporting an https DownloadURL has it persisted, so central can
// later 302 clients straight to it.
func TestNodeRegisterHttpsDownloadURLPersisted(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	resp := registerNode(t, s, "fleet-secret", nodeRegisterReq{
		TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Capabilities: []string{"storage"},
		StorageURL: "https://1.2.3.4:8081", StorageSecret: "ss",
		DownloadURL: "https://node7.relayium.com",
	})
	got, ok, _ := s.store.GetNode(context.Background(), resp.NodeID)
	if !ok || got.DownloadURL != "https://node7.relayium.com" {
		t.Fatalf("fleet https DownloadURL must persist, got %q ok=%v", got.DownloadURL, ok)
	}
}

// A non-https DownloadURL is dropped (central 302s clients there, so it must be
// TLS): stored empty, so the node falls back to proxying.
func TestNodeRegisterNonHttpsDownloadURLDropped(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	resp := registerNode(t, s, "fleet-secret", nodeRegisterReq{
		TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Capabilities: []string{"storage"},
		StorageURL: "https://1.2.3.4:8081", StorageSecret: "ss",
		DownloadURL: "http://node7.relayium.com", // plaintext
	})
	got, _, _ := s.store.GetNode(context.Background(), resp.NodeID)
	if got.DownloadURL != "" {
		t.Fatalf("non-https DownloadURL must be dropped, got %q", got.DownloadURL)
	}
}
