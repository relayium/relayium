package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// loadDotEnv reads KEY=VALUE lines from path into the process environment.
// It never overrides a variable that is already set, so a real environment
// variable always wins over the file. A missing file is not an error — the
// .env file is an optional convenience. Lines that are blank, start with '#',
// or lack an '=' are skipped; surrounding single/double quotes on the value
// are stripped.
func loadDotEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue // real env wins
		}
		os.Setenv(key, unquoteEnv(strings.TrimSpace(val)))
	}
	return sc.Err()
}

// unquoteEnv strips a single matching pair of surrounding single or double
// quotes, leaving the inner text verbatim.
func unquoteEnv(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// envStr returns the value of env var key, or def if the var is not set.
// An explicitly empty value (KEY=) is honored as "", not the default.
func envStr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

// envBool parses the env var key as a bool (per strconv.ParseBool); on an
// unset or unparseable value it returns def.
func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if b, err := strconv.ParseBool(strings.TrimSpace(v)); err == nil {
			return b
		}
	}
	return def
}

// envInt64 parses the env var key as a base-10 int64; on an unset or unparseable
// value it returns def.
func envInt64(key string, def int64) int64 {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return n
		}
	}
	return def
}
