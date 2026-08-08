package httpx

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeStrictJSONBody(t *testing.T) {
	tests := []struct {
		name string
		body string
		ok   bool
		eof  bool
	}{
		{name: "known field", body: `{"known":"value"}`, ok: true},
		{name: "unknown field", body: `{"known":"value","privateKey":"secret"}`},
		{name: "trailing value", body: `{"known":"value"} {}`},
		{name: "empty", body: "", eof: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
			var dst struct {
				Known string `json:"known"`
			}
			err := DecodeStrictJSONBody(httptest.NewRecorder(), req, &dst)
			if tc.ok && err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !tc.ok && !tc.eof && err == nil {
				t.Fatal("invalid strict JSON was accepted")
			}
			if tc.eof && !errors.Is(err, io.EOF) {
				t.Fatalf("empty body: got %v, want io.EOF", err)
			}
		})
	}
}
