package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunUnknownCommand(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run([]string{"frobnicate"}, &out, &errb)
	if code == 0 {
		t.Fatal("unknown command should exit non-zero")
	}
	if !strings.Contains(errb.String(), "usage") && !strings.Contains(errb.String(), "unknown") {
		t.Fatalf("stderr should explain the error, got %q", errb.String())
	}
}

func TestRunNoArgsShowsUsage(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run(nil, &out, &errb)
	if code == 0 {
		t.Fatal("no args should exit non-zero")
	}
	combined := out.String() + errb.String()
	if !strings.Contains(combined, "push") || !strings.Contains(combined, "pull") {
		t.Fatalf("usage should list push/pull, got %q", combined)
	}
	if !strings.Contains(combined, "file and text transfer") {
		t.Fatalf("usage should position both file and text transfer, got %q", combined)
	}
	if strings.Contains(combined, "__recv") {
		t.Fatalf("__recv must stay hidden from usage, got %q", combined)
	}
}
