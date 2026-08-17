package main

import (
	"os"
	"strings"
	"testing"
)

func TestAppleServerAPIProbeExitsBeforeDatabaseAndListener(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	probe := strings.Index(s, "if *appleServerAPIProbe {")
	db := strings.Index(s, "account.OpenSQLite(")
	listen := strings.Index(s, "srv.ListenAndServe()")
	if probe < 0 || db < 0 || listen < 0 || !(probe < db && probe < listen) {
		t.Fatal("probe must exit before database and listener")
	}
	if !strings.Contains(s[probe:db], "return") {
		t.Fatal("probe has no early return")
	}
}
