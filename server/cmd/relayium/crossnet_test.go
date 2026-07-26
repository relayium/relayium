package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunSendNeedsArgs(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run([]string{"send"}, &out, &errb)
	if code == 0 {
		t.Fatal("send with no args should exit non-zero")
	}
	if !strings.Contains(errb.String(), "send") {
		t.Fatalf("stderr should explain send usage, got %q", errb.String())
	}
}

func TestUsageListsSendReceive(t *testing.T) {
	var out, errb bytes.Buffer
	Run(nil, &out, &errb)
	combined := out.String() + errb.String()
	if !strings.Contains(combined, "send") || !strings.Contains(combined, "receive") {
		t.Fatalf("usage should list send/receive, got %q", combined)
	}
}

func TestSplitSendArgs(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(real, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A file whose name is also a well-formed pairing code. The file wins.
	coded := filepath.Join(dir, "K7M4XR")
	if err := os.WriteFile(coded, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name     string
		args     []string
		wantSrcs []string
		wantCode string
		wantErr  bool
	}{
		{"single source mints", []string{real}, []string{real}, "", false},
		{"trailing code is a code", []string{real, "K7M4XR"}, []string{real}, "K7M4XR", false},
		{"two sources mint", []string{real, real}, []string{real, real}, "", false},
		{"code-named file stays a source", []string{real, coded}, []string{real, coded}, "", false},
		{"neither file nor code errors", []string{real, "726122"}, nil, "", true},
		{"no arguments errors", nil, nil, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srcs, code, err := splitSendArgs(tc.args)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got srcs=%v code=%q", srcs, code)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if code != tc.wantCode {
				t.Errorf("code = %q, want %q", code, tc.wantCode)
			}
			if strings.Join(srcs, "|") != strings.Join(tc.wantSrcs, "|") {
				t.Errorf("srcs = %v, want %v", srcs, tc.wantSrcs)
			}
		})
	}
}

// The user-visible bug that started this: a made-up numeric code must not
// degrade into "no such file", it must explain what a code is.
func TestSplitSendArgsExplainsAMadeUpCode(t *testing.T) {
	_, _, err := splitSendArgs([]string{"pando_uu.zip", "726122"})
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"726122", "pairing code", "relayium send"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}
