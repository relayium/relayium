package main

import (
	"strings"
	"testing"
)

// The property formatTTL's doc comment promises: whatever it renders, --ttl
// takes back. It was false for every whole-day count — formatTTL printed "7d",
// parseTTL rejected it (time.ParseDuration has no day unit), so the truncation
// notice told users to paste a string the next command errors on.
func TestTTLRoundTrip(t *testing.T) {
	// Representative of what truncatedTTLNotice actually renders: plan
	// retention caps (1/7/14/30 days), --ttl values users type, and the
	// odd second counts that come out of an expiresAt subtraction.
	for _, secs := range []int64{
		1, 45, 59, 60, 90, 300, 3600, 5400, 86399, 86400,
		2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400, 180 * 86400,
	} {
		s := formatTTL(secs)
		got, err := parseTTL(s)
		if err != nil {
			t.Errorf("parseTTL(formatTTL(%d)) = parseTTL(%q): %v", secs, s, err)
			continue
		}
		if got != secs {
			t.Errorf("parseTTL(formatTTL(%d)) = parseTTL(%q) = %d, want %d", secs, s, got, secs)
		}
	}
}

// Days are required by the round trip above; weeks are accepted because the
// longest plan retention is 14 days, so "2w" is a value a user can ask for
// (formatTTL still prefers "14d", which is what round-trips).
func TestParseTTLAcceptsDaysAndWeeks(t *testing.T) {
	cases := map[string]int64{
		"1d":  86400,
		"7d":  7 * 86400,
		"14d": 14 * 86400,
		"1w":  7 * 86400,
		"2w":  14 * 86400,
		"0d":  0,
	}
	for in, want := range cases {
		got, err := parseTTL(in)
		if err != nil {
			t.Errorf("parseTTL(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseTTL(%q) = %d, want %d", in, got, want)
		}
	}
}

// Everything parseTTL accepted before the day/week units were added must keep
// working: Go durations and a bare count of seconds.
func TestParseTTLKeepsDurationsAndBareSeconds(t *testing.T) {
	cases := map[string]int64{
		"2h":    7200,
		"90m":   5400,
		"1h30m": 5400,
		"45s":   45,
		"3600":  3600,
		"0":     0,
	}
	for in, want := range cases {
		got, err := parseTTL(in)
		if err != nil {
			t.Errorf("parseTTL(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseTTL(%q) = %d, want %d", in, got, want)
		}
	}
}

// A value that is neither a duration nor a second count still fails, and the
// error names the forms that do work — including the day unit, which is the
// one the notice tells people to paste.
func TestParseTTLRejectsGarbage(t *testing.T) {
	for _, in := range []string{"", "abc", "7x", "d", "w", "1.5d", "7 d", "--ttl"} {
		got, err := parseTTL(in)
		if err == nil {
			t.Errorf("parseTTL(%q) = %d, want an error", in, got)
			continue
		}
		if !strings.Contains(err.Error(), "7d") {
			t.Errorf("parseTTL(%q) error %q does not mention the day unit", in, err)
		}
	}
}
