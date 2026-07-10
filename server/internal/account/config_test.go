package account

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleConfigReturnsLimits(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, nil, Config{MaxFileSize: 200 << 20, DailyQuota: 1 << 30, DefaultTTL: 3600, MaxTTL: 7200})
	r := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()
	svc.handleConfig(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var got map[string]int64
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["maxFileSize"] != 200<<20 || got["defaultTTL"] != 3600 || got["maxTTL"] != 7200 {
		t.Fatalf("config = %+v", got)
	}
}
