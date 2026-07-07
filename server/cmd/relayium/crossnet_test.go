package main

import (
	"bytes"
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
