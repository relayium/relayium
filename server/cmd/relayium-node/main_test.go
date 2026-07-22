package main

import "testing"

func TestEnvInt(t *testing.T) {
	const key = "RELAYIUM_TEST_PORT"
	tests := []struct {
		name string
		set  string // "" means leave unset
		want int
	}{
		{"unset falls back", "", 3478},
		{"empty falls back", "", 3478},
		{"override", "3479", 3479},
		// A typo in an env file must not take the node down: the port knobs are
		// set by hand far more often than the rest of the config.
		{"garbage falls back", "not-a-port", 3478},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set != "" {
				t.Setenv(key, tc.set)
			}
			if got := envInt(key, 3478); got != tc.want {
				t.Errorf("envInt(%q=%q) = %d, want %d", key, tc.set, got, tc.want)
			}
		})
	}
}
