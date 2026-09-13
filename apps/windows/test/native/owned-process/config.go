// Package main is a TEST-ONLY Windows process guardian.
//
// It exists for one reason: a fixture that spawns Chrome cannot prove it later
// cleaned Chrome up. `ChildProcess.kill` on Windows is `TerminateProcess`
// against the PARENT only, and Chrome is a process TREE — renderer, GPU,
// network and storage utility children, each its own process. Killing the
// parent accounts for none of them, and enumerating them by name, by profile
// path or by PID adjacency is not ownership: the same fixture family has
// already killed three browsers it could not attribute
// (`INCIDENT-chrome-kills.md`).
//
// A Windows Job Object is the mechanism that accounts for a tree WITHOUT
// enumerating it. This helper creates one, puts the target into it BEFORE the
// target has run a single instruction, and holds the handle for as long as the
// target is meant to live. Closing that handle terminates every process still
// inside — including descendants this helper never saw and could not have
// named.
//
// # What it will not do
//
// There is no pattern kill, no prefix sweep, no PID heuristic and no "find
// processes that look like ours" anywhere in this program. It can terminate
// exactly one thing: the job it created itself. If it cannot prove that job is
// empty, it says so and exits non-zero rather than reporting a clean teardown.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Bounds on what a config may ask for. Not decoration: this program starts a
// process, so every field it takes from a file is bounded and checked, and an
// input that does not satisfy these is refused rather than clamped.
const (
	maxArgs       = 64
	maxArgBytes   = 8192
	minBudgetMs   = 1_000
	maxBudgetMs   = 600_000
	defaultJoinMs = 30_000
	defaultKillMs = 15_000
)

// Purposes this helper will act on. A config that does not name one of these is
// refused, so a stray or mistyped file cannot drive a process launcher.
var validPurposes = map[string]bool{
	// The realtime acceptance fixture's owned Chrome.
	"owned-browser": true,
	// The same fixture's owned Electron peer. Electron is a multiprocess tree
	// too — its own Chromium renderer and utility children, and the native IO
	// helper it starts — so terminating its main process accounts for no more
	// of it than terminating Chrome's parent accounts for Chrome.
	"owned-peer": true,
	// This package's own Windows tests, whose target is the test binary itself.
	"self-test": true,
}

// Config is the whole of this program's input. There are no flags and no
// environment overrides: one JSON file, named on the command line, validated
// before anything is started.
type Config struct {
	Purpose string `json:"purpose"`
	// Absolute path of the executable to guard. Must exist and be a regular
	// file at validation time.
	Executable string `json:"executable"`
	// Arguments after the executable itself. Bounded in count and size.
	Args []string `json:"args"`
	// Optional. Absolute and an existing directory when set.
	WorkingDirectory string `json:"workingDirectory"`
	// How long a graceful join may take before it is reported as not having
	// happened.
	JoinBudgetMs int `json:"joinBudgetMs"`
	// How long a forced termination has to empty the job.
	TerminateBudgetMs int `json:"terminateBudgetMs"`
}

// LoadConfig reads and validates a config file. Every failure names the field.
func LoadConfig(path string) (Config, error) {
	var cfg Config
	if strings.TrimSpace(path) == "" {
		return cfg, errors.New("no config path was given")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("unreadable config %q: %w", path, err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	// An unknown field is a config this program does not understand. Ignoring
	// it would mean acting on a file whose author expected something else.
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return cfg, fmt.Errorf("malformed config %q: %w", path, err)
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// Validate refuses anything this program will not start.
//
// Split from LoadConfig so the rules are testable on any host, including the
// one this file is being written on, which is not Windows.
func (c *Config) Validate() error {
	if !validPurposes[c.Purpose] {
		return fmt.Errorf("purpose %q is not one this helper acts on", c.Purpose)
	}
	if c.Executable == "" {
		return errors.New("executable is required")
	}
	if strings.ContainsRune(c.Executable, 0) {
		return errors.New("executable contains a NUL byte")
	}
	if !filepath.IsAbs(c.Executable) {
		return fmt.Errorf("executable %q is not an absolute path", c.Executable)
	}
	info, err := os.Stat(c.Executable)
	if err != nil {
		return fmt.Errorf("executable %q is not present: %w", c.Executable, err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return fmt.Errorf("executable %q is not a regular file", c.Executable)
	}
	if len(c.Args) > maxArgs {
		return fmt.Errorf("%d arguments exceeds the bound of %d", len(c.Args), maxArgs)
	}
	for i, arg := range c.Args {
		if strings.ContainsRune(arg, 0) {
			return fmt.Errorf("argument %d contains a NUL byte", i)
		}
		if len(arg) > maxArgBytes {
			return fmt.Errorf("argument %d is %d bytes, over the bound of %d", i, len(arg), maxArgBytes)
		}
	}
	if c.WorkingDirectory != "" {
		if !filepath.IsAbs(c.WorkingDirectory) {
			return fmt.Errorf("workingDirectory %q is not an absolute path", c.WorkingDirectory)
		}
		dir, err := os.Stat(c.WorkingDirectory)
		if err != nil {
			return fmt.Errorf("workingDirectory %q is not present: %w", c.WorkingDirectory, err)
		}
		if !dir.IsDir() {
			return fmt.Errorf("workingDirectory %q is not a directory", c.WorkingDirectory)
		}
	}
	if c.JoinBudgetMs == 0 {
		c.JoinBudgetMs = defaultJoinMs
	}
	if c.TerminateBudgetMs == 0 {
		c.TerminateBudgetMs = defaultKillMs
	}
	if err := boundBudget("joinBudgetMs", c.JoinBudgetMs); err != nil {
		return err
	}
	return boundBudget("terminateBudgetMs", c.TerminateBudgetMs)
}

func boundBudget(field string, value int) error {
	if value < minBudgetMs || value > maxBudgetMs {
		return fmt.Errorf("%s is %d, outside %d..%d", field, value, minBudgetMs, maxBudgetMs)
	}
	return nil
}
