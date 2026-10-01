//go:build ignore

// scripts/go-race-timings.go — per-test timing evidence for the Go race shards
// in .github/workflows/go.yml, and the corpus that turns that evidence into a
// weights file for scripts/go-race-shard.go -weights.
//
// ## Why it exists
//
// The shard planner can balance by measured cost only if the cost was really
// measured, on the hosted runner, under -race -count=1, for EVERY test it
// plans. A weight typed in from a guess would plan shards against a fiction
// and report them as balanced. So each shard job records what it actually ran
// — from `go test -json`, not from a regex over a log — and uploads it whether
// the job passed or failed; `corpus` accepts a set of those records only when
// together they are one complete measurement of one tree.
//
// ## Subcommands
//
//	render    stdin: `go test -json` events. stdout: the Output text of each
//	          event, i.e. the `-v` log a reader expects in the job log, with
//	          any non-JSON line passed through. It reads to EOF whatever it
//	          sees, so it never closes the pipe early and turns a test failure
//	          into SIGPIPE.
//
//	evidence  -plan FILE (from go-race-shard.go -plan-out) -json FILE (the
//	          `go test -json` stream) plus the run's provenance: -source-sha,
//	          -toolchain, -run-id and -run-attempt ($GITHUB_RUN_ID and
//	          $GITHUB_RUN_ATTEMPT on a hosted job; outside GitHub an explicit,
//	          obviously synthetic value — never a blank or a guessed hosted
//	          ID), -race, -count, -go-exit. Writes one evidence JSON
//	          (schema relayium.go-race-timing/1) to -out — always, including
//	          for a failed run — and exits non-zero if the run cannot be
//	          trusted:
//	            - go test exited non-zero;
//	            - a line of the stream is not a JSON event;
//	            - an assigned top-level test has no result, or more than one;
//	            - a top-level test ran that this shard was not assigned;
//	            - with -require-pass, an assigned test did not PASS;
//	            - with -forbid-skip, ANY test or subtest skipped;
//	            - with -expect-inventory FILE, the compiled inventory is not
//	              exactly the names in FILE.
//	          `complete` in the evidence is true only when none of these hold.
//
//	corpus    -out FILE -source TEXT EVIDENCE... — validates that the
//	          evidence files are every shard 0..N-1 of ONE run attempt of one
//	          plan exactly once: same lane, package, pattern, mode, weights
//	          digest, planned loads, source SHA, toolchain, inventory, run ID
//	          and run attempt; -race and -count=1; the assigned sets disjoint
//	          with the inventory as their union; every inventory test with
//	          exactly one PASS (or lane-allowed SKIP) duration. It does NOT
//	          trust a record's `complete`, `problems` or skip flags: each record
//	          is decoded strictly (no duplicate, unknown, missing or null key)
//	          and every fact is re-derived from its data — result uniqueness
//	          and exact assigned set, allowed actions for its lane, finite
//	          bounded durations, commit/toolchain/digest/run formats, FNV
//	          assignments recomputed from the hash. Only then does
//	          it write a relayium.go-test-weights/1 file. Anything less is an
//	          error: an incomplete corpus would weight the missing tests at the
//	          planner's default and call the result measured.
//
// Pure standard library and `//go:build ignore`, like go-race-shard.go, so it
// runs with `go run` and never joins the server module's build.
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	planSchema     = "relayium.go-race-plan/1"
	evidenceSchema = "relayium.go-race-timing/1"
	weightsSchema  = "relayium.go-test-weights/1"
)

// plan mirrors go-race-shard.go's -plan-out. Unknown fields are refused on
// read, so a change on one side fails here rather than drifting.
type plan struct {
	Schema        string   `json:"schema"`
	Mode          string   `json:"mode"`
	Package       string   `json:"package"`
	Pattern       string   `json:"pattern"`
	WeightsSHA256 string   `json:"weightsSHA256"`
	Shard         int      `json:"shard"`
	Shards        int      `json:"shards"`
	PlannedMS     []int64  `json:"plannedMS"`
	Inventory     []string `json:"inventory"`
	Assigned      []string `json:"assigned"`
}

type result struct {
	Name    string  `json:"name"`
	Action  string  `json:"action"`
	Seconds float64 `json:"seconds"`
}

type evidence struct {
	Schema          string   `json:"schema"`
	Lane            string   `json:"lane"`
	Mode            string   `json:"mode"`
	Package         string   `json:"package"`
	Pattern         string   `json:"pattern"`
	WeightsSHA256   string   `json:"weightsSHA256"`
	Shard           int      `json:"shard"`
	Shards          int      `json:"shards"`
	PlannedMS       []int64  `json:"plannedMS"`
	SourceSHA       string   `json:"sourceSHA"`
	Toolchain       string   `json:"toolchain"`
	RunID           int64    `json:"runID"`
	RunAttempt      int64    `json:"runAttempt"`
	Race            bool     `json:"race"`
	Count           int      `json:"count"`
	GoExit          int      `json:"goExit"`
	RequirePass     bool     `json:"requirePass"`
	ForbidSkip      bool     `json:"forbidSkip"`
	InventorySHA256 string   `json:"inventorySHA256"`
	Inventory       []string `json:"inventory"`
	Assigned        []string `json:"assigned"`
	Results         []result `json:"results"`
	SkippedSubtests []string `json:"skippedSubtests"`
	Complete        bool     `json:"complete"`
	Problems        []string `json:"problems"`
}

type weightsFile struct {
	Schema     string            `json:"schema"`
	Package    string            `json:"package"`
	Pattern    string            `json:"pattern"`
	Unit       string            `json:"unit"`
	Provenance weightsProvenance `json:"provenance"`
	Tests      []weightsEntry    `json:"tests"`
}

type weightsProvenance struct {
	Kind       string `json:"kind"`
	Source     string `json:"source"`
	SourceSHA  string `json:"sourceSHA"`
	Toolchain  string `json:"toolchain"`
	RunID      int64  `json:"runID"`
	RunAttempt int64  `json:"runAttempt"`
	Race       bool   `json:"race"`
	Count      int    `json:"count"`
	Complete   bool   `json:"complete"`
}

type weightsEntry struct {
	Name    string  `json:"name"`
	Seconds float64 `json:"seconds"`
}

// event is the subset of a `go test -json` event this file reads. Unknown
// fields are allowed: the go command adds them between releases.
type event struct {
	Action  string   `json:"Action"`
	Package string   `json:"Package"`
	Test    string   `json:"Test"`
	Elapsed *float64 `json:"Elapsed"`
	Output  string   `json:"Output"`
}

var (
	testIdent = regexp.MustCompile(`^Test[A-Za-z0-9_]*$`)
	commitRe  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256Re  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// `go version` output, e.g. "go version go1.26.6 linux/amd64".
	toolchainRe = regexp.MustCompile(`^go version go[0-9]+\.[0-9]+(\.[0-9]+)?([a-z]+[0-9]+)? [a-z0-9]+/[a-z0-9]+$`)
	// A GitHub run ID or attempt: a positive decimal with no sign or padding.
	positiveRe = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
)

// Finite bounds on what a piece of evidence may claim. Anything outside them
// is a malformed or forged record, not a large measurement.
const (
	maxShards       = 256
	maxInventory    = 100000
	maxSeconds      = 21600 // GitHub's own six-hour job ceiling
	maxRunID        = 1<<53 - 1
	maxRunAttempt   = 1000
	maxSourceLength = 1000
)

// laneRules is the skip contract per lane. The corpus re-checks each piece of
// evidence against its lane's contract rather than trusting the flags the
// evidence says it was produced with: the account lane keeps the package's
// own reasoned skips (a skipped test's elapsed time is real, and the planner
// floors any weight at 1 ms); the renewal lane must PASS everything and may
// skip nothing, subtests included.
var laneRules = map[string]struct{ requirePass, forbidSkip bool }{
	"account": {false, false},
	"renewal": {true, true},
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "render":
		err = render(os.Stdin, os.Stdout)
	case "evidence":
		err = evidenceCmd(os.Args[2:])
	case "corpus":
		err = corpusCmd(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "go-race-timings:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: go run scripts/go-race-timings.go render|evidence|corpus [flags]")
	os.Exit(2)
}

// render prints each event's Output and passes non-JSON lines through.
func render(in io.Reader, out io.Writer) error {
	r := bufio.NewReader(in)
	w := bufio.NewWriter(out)
	defer w.Flush()
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			var ev event
			if json.Unmarshal(bytes.TrimSpace(line), &ev) == nil && ev.Action != "" {
				io.WriteString(w, ev.Output)
			} else {
				w.Write(line)
			}
			// Keep the job log live: a hung test must show what it was doing.
			w.Flush()
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func readJSONStrict(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := decodeStrict(raw, v); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// decodeStrict is the only way this file reads its own records. encoding/json
// on its own accepts a duplicated key (the LAST value wins), a missing field
// (the zero value), an explicit null (the zero value) and trailing data; each
// of those lets a record claim something it does not say once. So: no
// duplicate key at any depth, no unknown field, no trailing data, and every
// field of every struct present and non-null.
func decodeStrict(raw []byte, v any) error {
	if err := noDuplicateKeys(raw); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("trailing data after the JSON object")
	}
	return requirePresent(raw, reflect.TypeOf(v).Elem(), "$")
}

// noDuplicateKeys walks the token stream and refuses an object that names a
// key twice.
func noDuplicateKeys(raw []byte) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var walk func(path string) error
	walk = func(path string) error {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch tok {
		case json.Delim('{'):
			seen := map[string]bool{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return err
				}
				k, _ := kt.(string)
				if seen[k] {
					return fmt.Errorf("%s: key %q appears twice; a reader would see only one of its values", path, k)
				}
				seen[k] = true
				if err := walk(path + "." + k); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		case json.Delim('['):
			for i := 0; dec.More(); i++ {
				if err := walk(fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		}
		return nil
	}
	return walk("$")
}

// requirePresent checks every json-tagged field of t (recursively through
// structs and slices of structs) is present in raw and not null.
func requirePresent(raw json.RawMessage, t reflect.Type, path string) error {
	switch t.Kind() {
	case reflect.Struct:
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
			return fmt.Errorf("%s: want an object", path)
		}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			if name == "" || name == "-" {
				continue
			}
			v, ok := obj[name]
			if !ok || string(bytes.TrimSpace(v)) == "null" {
				return fmt.Errorf("%s.%s is missing or null; a record must state every field", path, name)
			}
			if err := requirePresent(v, f.Type, path+"."+name); err != nil {
				return err
			}
		}
	case reflect.Slice:
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return fmt.Errorf("%s: want an array", path)
		}
		for i, item := range items {
			if string(bytes.TrimSpace(item)) == "null" {
				return fmt.Errorf("%s[%d] is null", path, i)
			}
			if err := requirePresent(item, t.Elem(), fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	}
	return nil
}

// parsePositive reads a run ID or attempt: a positive decimal within max.
func parsePositive(name, s string, max int64) (int64, error) {
	if !positiveRe.MatchString(s) {
		return 0, fmt.Errorf("%s %q is not a positive decimal", name, s)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 1 || n > max {
		return 0, fmt.Errorf("%s %q is outside [1, %d]", name, s, max)
	}
	return n, nil
}

func inventorySHA(names []string) string {
	h := sha256.New()
	for _, n := range names {
		io.WriteString(h, n+"\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

// checkPlan validates a plan's own shape; evidence built from a malformed plan
// would describe a run nobody can reproduce.
func checkPlan(p *plan) error {
	if p.Schema != planSchema {
		return fmt.Errorf("plan schema %q, want %q", p.Schema, planSchema)
	}
	if p.Mode != "fnv" && p.Mode != "weighted" {
		return fmt.Errorf("plan mode %q, want fnv or weighted", p.Mode)
	}
	if (p.Mode == "weighted") != (p.WeightsSHA256 != "") {
		return fmt.Errorf("plan mode %q with weights sha256 %q", p.Mode, p.WeightsSHA256)
	}
	if p.Package == "" || p.Pattern == "" {
		return errors.New("plan names no package or pattern")
	}
	if p.Mode == "weighted" && !sha256Re.MatchString(p.WeightsSHA256) {
		return fmt.Errorf("plan weights sha256 %q is not 64 lowercase hex digits", p.WeightsSHA256)
	}
	if p.Shards < 1 || p.Shards > maxShards || p.Shard < 0 || p.Shard >= p.Shards {
		return fmt.Errorf("plan shard %d of %d", p.Shard, p.Shards)
	}
	if err := checkPlannedMS(p.Mode, p.PlannedMS, p.Shards); err != nil {
		return fmt.Errorf("plan %w", err)
	}
	if _, err := regexp.Compile(p.Pattern); err != nil {
		return fmt.Errorf("plan pattern %q does not compile: %w", p.Pattern, err)
	}
	if len(p.Inventory) == 0 || len(p.Assigned) == 0 || len(p.Inventory) > maxInventory {
		return errors.New("plan has an empty or oversized inventory or an empty assignment")
	}
	if !sort.StringsAreSorted(p.Inventory) {
		return errors.New("plan inventory is not sorted")
	}
	inv := make(map[string]bool, len(p.Inventory))
	for _, n := range p.Inventory {
		if !testIdent.MatchString(n) || inv[n] {
			return fmt.Errorf("plan inventory entry %q is invalid or duplicated", n)
		}
		inv[n] = true
	}
	seen := make(map[string]bool, len(p.Assigned))
	for _, n := range p.Assigned {
		if !inv[n] || seen[n] {
			return fmt.Errorf("plan assigns %q, which is outside the inventory or duplicated", n)
		}
		seen[n] = true
	}
	return nil
}

// checkPlannedMS: an FNV plan has no loads; a weighted plan has one finite,
// positive load per shard.
func checkPlannedMS(mode string, ms []int64, shards int) error {
	if mode == "fnv" {
		if len(ms) != 0 {
			return fmt.Errorf("plannedMS %v for an fnv plan, want none", ms)
		}
		return nil
	}
	if len(ms) != shards {
		return fmt.Errorf("plannedMS has %d entries for %d shards", len(ms), shards)
	}
	for i, v := range ms {
		if v < 1 || v > int64(maxInventory)*maxSeconds*1000 {
			return fmt.Errorf("plannedMS[%d] = %d is outside the possible range", i, v)
		}
	}
	return nil
}

func evidenceCmd(args []string) error {
	fs := flag.NewFlagSet("evidence", flag.ContinueOnError)
	var (
		lane        = fs.String("lane", "", "lane name, e.g. account or renewal")
		planPath    = fs.String("plan", "", "go-race-shard.go -plan-out file")
		jsonPath    = fs.String("json", "", "the `go test -json` stream")
		sourceSHA   = fs.String("source-sha", "", "the commit the job tested (git rev-parse HEAD)")
		toolchain   = fs.String("toolchain", "", "`go version` output")
		runID       = fs.String("run-id", "", "the GitHub run ID ($GITHUB_RUN_ID); outside GitHub, an explicit synthetic one")
		runAttempt  = fs.String("run-attempt", "", "the GitHub run attempt ($GITHUB_RUN_ATTEMPT)")
		race        = fs.Bool("race", false, "the run used -race")
		count       = fs.Int("count", 0, "the run's -count")
		goExit      = fs.Int("go-exit", -1, "go test's exit status")
		requirePass = fs.Bool("require-pass", false, "every assigned test must PASS")
		forbidSkip  = fs.Bool("forbid-skip", false, "no test or subtest may SKIP")
		expectInv   = fs.String("expect-inventory", "", "a file of test names (one per line) the compiled inventory must equal")
		outPath     = fs.String("out", "", "where to write the evidence JSON")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("evidence: unexpected arguments %q", fs.Args())
	}
	if *lane == "" || *planPath == "" || *jsonPath == "" || *outPath == "" || *goExit < 0 {
		return errors.New("evidence: -lane, -plan, -json, -out and -go-exit are required")
	}
	var p plan
	if err := readJSONStrict(*planPath, &p); err != nil {
		return err
	}
	if err := checkPlan(&p); err != nil {
		return err
	}
	ev := buildEvidence(&p, *jsonPath, *goExit, *requirePass, *forbidSkip)
	if *expectInv != "" {
		if err := compareInventory(ev, *expectInv); err != nil {
			ev.Problems = append(ev.Problems, err.Error())
			ev.Complete = false
		}
	}
	ev.Lane, ev.SourceSHA, ev.Toolchain, ev.Race, ev.Count = *lane, *sourceSHA, strings.TrimSpace(*toolchain), *race, *count
	// Provenance that cannot be checked later is recorded as a problem now:
	// the evidence is still written, but it is not complete.
	provenance := func(err error) {
		if err != nil {
			ev.Problems = append(ev.Problems, err.Error())
		}
	}
	if rule, ok := laneRules[ev.Lane]; !ok {
		provenance(fmt.Errorf("lane %q is not one of the known lanes", ev.Lane))
	} else if rule.requirePass != ev.RequirePass || rule.forbidSkip != ev.ForbidSkip {
		provenance(fmt.Errorf("lane %s requires -require-pass=%v -forbid-skip=%v", ev.Lane, rule.requirePass, rule.forbidSkip))
	}
	if !commitRe.MatchString(ev.SourceSHA) {
		provenance(fmt.Errorf("-source-sha %q is not a 40-hex commit", ev.SourceSHA))
	}
	if !toolchainRe.MatchString(ev.Toolchain) {
		provenance(fmt.Errorf("-toolchain %q is not `go version` output", ev.Toolchain))
	}
	if id, err := parsePositive("-run-id", *runID, maxRunID); err != nil {
		provenance(err)
	} else {
		ev.RunID = id
	}
	if at, err := parsePositive("-run-attempt", *runAttempt, maxRunAttempt); err != nil {
		provenance(err)
	} else {
		ev.RunAttempt = at
	}
	if !ev.Race || ev.Count != 1 {
		provenance(fmt.Errorf("race=%v count=%d; a race shard runs -race -count=1", ev.Race, ev.Count))
	}
	ev.Complete = len(ev.Problems) == 0
	out, err := json.MarshalIndent(ev, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(*outPath, append(out, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "go-race-timings: %s shard %d/%d: %d of %d assigned test(s) with a result, complete=%v\n",
		ev.Lane, ev.Shard, ev.Shards, len(ev.Results), len(ev.Assigned), ev.Complete)
	if !ev.Complete {
		for _, pr := range ev.Problems {
			fmt.Fprintln(os.Stderr, "::error::go-race-timings:", pr)
		}
		return fmt.Errorf("%d problem(s); evidence written to %s", len(ev.Problems), *outPath)
	}
	return nil
}

// compareInventory checks the compiled inventory against an independently
// derived list — the renewal lane greps its `func Test...` declarations — so a
// test the compiler stopped seeing (a build tag, a typo in the pattern) is a
// failure rather than a test that quietly left every shard.
func compareInventory(ev *evidence, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading the expected inventory: %w", err)
	}
	want := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			want[line] = true
		}
	}
	if len(want) == 0 {
		return fmt.Errorf("the expected inventory %s is empty", path)
	}
	have := make(map[string]bool, len(ev.Inventory))
	for _, n := range ev.Inventory {
		have[n] = true
		if !want[n] {
			return fmt.Errorf("compiled test %s is not in the expected inventory %s", n, path)
		}
	}
	for n := range want {
		if !have[n] {
			return fmt.Errorf("expected test %s is not in the compiled inventory: it would run in no shard", n)
		}
	}
	return nil
}

// buildEvidence reads the event stream against the plan. It records problems
// rather than stopping at the first, so a failed run's evidence says
// everything that went wrong.
func buildEvidence(p *plan, jsonPath string, goExit int, requirePass, forbidSkip bool) *evidence {
	ev := &evidence{
		Schema: evidenceSchema, Mode: p.Mode, Package: p.Package, Pattern: p.Pattern,
		WeightsSHA256: p.WeightsSHA256, Shard: p.Shard, Shards: p.Shards, GoExit: goExit,
		RequirePass: requirePass, ForbidSkip: forbidSkip,
		InventorySHA256: inventorySHA(p.Inventory), Inventory: p.Inventory, Assigned: p.Assigned,
		PlannedMS: append([]int64{}, p.PlannedMS...),
		Results:   []result{}, SkippedSubtests: []string{}, Problems: []string{},
	}
	problem := func(format string, a ...any) { ev.Problems = append(ev.Problems, fmt.Sprintf(format, a...)) }
	if goExit != 0 {
		problem("go test exited %d", goExit)
	}
	assigned := make(map[string]bool, len(p.Assigned))
	for _, n := range p.Assigned {
		assigned[n] = true
	}
	terminal := map[string][]result{}
	f, err := os.Open(jsonPath)
	if err != nil {
		problem("reading the go test stream: %v", err)
	} else {
		defer f.Close()
		r := bufio.NewReader(f)
		lineNo := 0
		for {
			line, rerr := r.ReadBytes('\n')
			if len(bytes.TrimSpace(line)) > 0 {
				lineNo++
				var e event
				if err := json.Unmarshal(bytes.TrimSpace(line), &e); err != nil || e.Action == "" {
					problem("line %d of the go test stream is not a JSON event: %.120q", lineNo, line)
				} else if e.Test != "" {
					top, _, sub := strings.Cut(e.Test, "/")
					switch e.Action {
					case "pass", "fail", "skip":
						if sub {
							if e.Action == "skip" {
								ev.SkippedSubtests = append(ev.SkippedSubtests, e.Test)
							}
							break
						}
						secs := -1.0
						if e.Elapsed != nil && !math.IsNaN(*e.Elapsed) && !math.IsInf(*e.Elapsed, 0) && *e.Elapsed >= 0 {
							secs = *e.Elapsed
						}
						terminal[top] = append(terminal[top], result{Name: top, Action: e.Action, Seconds: secs})
					}
				}
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				problem("reading the go test stream: %v", rerr)
				break
			}
		}
	}

	ran := make([]string, 0, len(terminal))
	for name := range terminal {
		ran = append(ran, name)
	}
	sort.Strings(ran)
	for _, name := range ran {
		if !assigned[name] {
			problem("top-level test %s ran but is not assigned to shard %d: the -run selector is not exact", name, p.Shard)
		}
	}
	for _, name := range p.Assigned {
		rs := terminal[name]
		switch {
		case len(rs) == 0:
			problem("assigned test %s produced no result", name)
			continue
		case len(rs) > 1:
			problem("assigned test %s produced %d results; -count=1 runs it once", name, len(rs))
			continue
		}
		r := rs[0]
		if r.Seconds < 0 {
			problem("assigned test %s has no finite elapsed time", name)
		}
		if requirePass && r.Action != "pass" {
			problem("assigned test %s did not PASS (%s)", name, r.Action)
		}
		if forbidSkip && r.Action == "skip" {
			problem("test %s skipped", name)
		}
		ev.Results = append(ev.Results, r)
	}
	if forbidSkip {
		for _, name := range ev.SkippedSubtests {
			problem("subtest %s skipped", name)
		}
	}
	ev.Complete = len(ev.Problems) == 0
	return ev
}

func corpusCmd(args []string) error {
	fs := flag.NewFlagSet("corpus", flag.ContinueOnError)
	var (
		outPath = fs.String("out", "", "where to write the weights file")
		source  = fs.String("source", "", "a human description of where the evidence came from (run and job ids)")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *outPath == "" || strings.TrimSpace(*source) == "" || fs.NArg() == 0 {
		return errors.New("corpus: -out, -source and at least one evidence file are required")
	}
	wf, err := buildCorpus(fs.Args(), *source)
	if err != nil {
		return err
	}
	out, err := json.MarshalIndent(wf, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(*outPath, append(out, '\n'), 0o644)
}

// shardOf is go-race-shard.go's FNV-1a rule, restated so the corpus can
// recompute an FNV assignment instead of trusting the one it was handed.
func shardOf(name string, shards int) int {
	h := uint32(2166136261)
	for i := 0; i < len(name); i++ {
		h ^= uint32(name[i])
		h *= 16777619
	}
	return int(h % uint32(shards))
}

// validateEvidence re-derives, from the record's own content, every fact a
// corpus relies on. It never trusts `complete`, `problems`, `requirePass` or
// `forbidSkip` as a summary: each is checked against the data it summarises
// and against the lane's contract. It returns every violation found.
func validateEvidence(e *evidence) []string {
	var bad []string
	add := func(format string, a ...any) { bad = append(bad, fmt.Sprintf(format, a...)) }

	if e.Schema != evidenceSchema {
		add("schema %q, want %q", e.Schema, evidenceSchema)
	}
	rule, known := laneRules[e.Lane]
	if !known {
		add("lane %q is not a known lane", e.Lane)
	}
	if known && (e.RequirePass != rule.requirePass || e.ForbidSkip != rule.forbidSkip) {
		add("lane %s evidence says requirePass=%v forbidSkip=%v; the lane requires %v/%v",
			e.Lane, e.RequirePass, e.ForbidSkip, rule.requirePass, rule.forbidSkip)
	}
	if e.Mode != "fnv" && e.Mode != "weighted" {
		add("mode %q", e.Mode)
	}
	if (e.Mode == "weighted") != (e.WeightsSHA256 != "") || (e.Mode == "weighted" && !sha256Re.MatchString(e.WeightsSHA256)) {
		add("mode %q with weights sha256 %q", e.Mode, e.WeightsSHA256)
	}
	if e.Shards < 1 || e.Shards > maxShards || e.Shard < 0 || e.Shard >= e.Shards {
		add("shard %d of %d", e.Shard, e.Shards)
	}
	if err := checkPlannedMS(e.Mode, e.PlannedMS, e.Shards); err != nil {
		add("%v", err)
	}
	re, err := regexp.Compile(e.Pattern)
	if err != nil || e.Package == "" {
		add("package %q / pattern %q is not usable", e.Package, e.Pattern)
	}
	if !commitRe.MatchString(e.SourceSHA) {
		add("sourceSHA %q is not a 40-hex commit", e.SourceSHA)
	}
	if !toolchainRe.MatchString(e.Toolchain) {
		add("toolchain %q is not `go version` output", e.Toolchain)
	}
	if e.RunID < 1 || e.RunID > maxRunID || e.RunAttempt < 1 || e.RunAttempt > maxRunAttempt {
		add("run %d attempt %d is not a real GitHub run", e.RunID, e.RunAttempt)
	}
	if !e.Race || e.Count != 1 {
		add("race=%v count=%d; only -race -count=1 runs may weight a race lane", e.Race, e.Count)
	}
	if e.GoExit != 0 {
		add("go test exited %d", e.GoExit)
	}
	if !e.Complete || len(e.Problems) != 0 {
		add("the record itself says complete=%v with %d problem(s)", e.Complete, len(e.Problems))
	}

	// Inventory: sorted, unique, test names the pattern matches, hashed as recorded.
	if len(e.Inventory) == 0 || len(e.Inventory) > maxInventory {
		add("inventory has %d names", len(e.Inventory))
	}
	inv := make(map[string]bool, len(e.Inventory))
	for i, n := range e.Inventory {
		if !testIdent.MatchString(n) || (re != nil && !re.MatchString(n)) {
			add("inventory name %q is not a test the pattern matches", n)
		}
		if inv[n] || (i > 0 && e.Inventory[i-1] >= n) {
			add("inventory is not sorted and unique at %q", n)
		}
		inv[n] = true
	}
	if !sha256Re.MatchString(e.InventorySHA256) || inventorySHA(e.Inventory) != e.InventorySHA256 {
		add("inventory does not hash to its recorded sha256")
	}

	// Assignment: sorted, unique, inside the inventory, non-empty, and for FNV
	// exactly the names the hash gives this shard.
	if len(e.Assigned) == 0 {
		add("shard %d is assigned no tests", e.Shard)
	}
	assigned := make(map[string]bool, len(e.Assigned))
	for i, n := range e.Assigned {
		if !inv[n] || assigned[n] || (i > 0 && e.Assigned[i-1] >= n) {
			add("assigned name %q is outside the inventory, duplicated or out of order", n)
		}
		assigned[n] = true
	}
	if e.Mode == "fnv" && e.Shards >= 1 {
		for _, n := range e.Inventory {
			if (shardOf(n, e.Shards) == e.Shard) != assigned[n] {
				add("FNV puts %s in shard %d, but the record assigns it %v to shard %d",
					n, shardOf(n, e.Shards), assigned[n], e.Shard)
			}
		}
	}

	// Results: exactly one per assigned test, no other, each an allowed action
	// with a finite, bounded duration.
	got := make(map[string]bool, len(e.Results))
	for _, r := range e.Results {
		if got[r.Name] {
			add("test %s has more than one result; a corpus will not choose between them", r.Name)
		}
		got[r.Name] = true
		if !assigned[r.Name] {
			add("result for %s, which shard %d was not assigned", r.Name, e.Shard)
		}
		switch r.Action {
		case "pass":
		case "skip":
			if rule.requirePass || rule.forbidSkip || e.RequirePass || e.ForbidSkip {
				add("test %s skipped in lane %s, which forbids it", r.Name, e.Lane)
			}
		default:
			add("test %s action %q is not a PASS or an allowed SKIP", r.Name, r.Action)
		}
		if math.IsNaN(r.Seconds) || math.IsInf(r.Seconds, 0) || r.Seconds < 0 || r.Seconds > maxSeconds {
			add("test %s duration %v is outside [0, %d] s", r.Name, r.Seconds, maxSeconds)
		}
	}
	for _, n := range e.Assigned {
		if !got[n] {
			add("assigned test %s has no result", n)
		}
	}
	seenSub := map[string]bool{}
	for _, sub := range e.SkippedSubtests {
		parent, _, ok := strings.Cut(sub, "/")
		if !ok || !assigned[parent] || seenSub[sub] {
			add("skipped subtest %q does not belong to an assigned test, or repeats", sub)
		}
		seenSub[sub] = true
		if rule.forbidSkip || e.ForbidSkip {
			add("subtest %s skipped in lane %s, which forbids it", sub, e.Lane)
		}
	}
	return bad
}

func buildCorpus(paths []string, source string) (*weightsFile, error) {
	if len(source) > maxSourceLength {
		return nil, fmt.Errorf("-source is longer than %d characters", maxSourceLength)
	}
	evs := make([]*evidence, len(paths))
	for i, path := range paths {
		var ev evidence
		if err := readJSONStrict(path, &ev); err != nil {
			return nil, err
		}
		if bad := validateEvidence(&ev); len(bad) != 0 {
			return nil, fmt.Errorf("%s (shard %d) cannot weight a plan:\n  %s", path, ev.Shard, strings.Join(bad, "\n  "))
		}
		evs[i] = &ev
	}
	first := evs[0]
	// One run, one tree, one plan: every field that names the run or the plan
	// must agree, including the per-shard loads and the run attempt — a rerun
	// of one shard is a different run of that shard.
	key := func(e *evidence) string {
		return strings.Join([]string{e.Lane, e.Mode, e.Package, e.Pattern, e.WeightsSHA256, e.SourceSHA,
			e.Toolchain, e.InventorySHA256, fmt.Sprint(e.Shards), fmt.Sprint(e.RunID), fmt.Sprint(e.RunAttempt),
			fmt.Sprint(e.PlannedMS), fmt.Sprint(e.RequirePass), fmt.Sprint(e.ForbidSkip)}, "\x00")
	}
	byShard := make(map[int]*evidence, len(evs))
	for i, e := range evs {
		if key(e) != key(first) {
			return nil, fmt.Errorf("%s does not describe the same run as %s (lane, mode, package, pattern, weights, "+
				"source SHA, toolchain, inventory, shard count, run ID, run attempt, planned loads and skip rules "+
				"must all agree)", paths[i], paths[0])
		}
		if _, dup := byShard[e.Shard]; dup {
			return nil, fmt.Errorf("%s: shard %d appears twice in the corpus", paths[i], e.Shard)
		}
		byShard[e.Shard] = e
	}
	for s := 0; s < first.Shards; s++ {
		if byShard[s] == nil {
			return nil, fmt.Errorf("the corpus has no evidence for shard %d of %d; an incomplete corpus "+
				"would weight that shard's tests at the planner's default and call them measured", s, first.Shards)
		}
	}
	owner := make(map[string]int, len(first.Inventory))
	secs := make(map[string]float64, len(first.Inventory))
	for s := 0; s < first.Shards; s++ {
		e := byShard[s]
		for _, n := range e.Assigned {
			if prev, dup := owner[n]; dup {
				return nil, fmt.Errorf("%s is assigned to both shard %d and shard %d", n, prev, s)
			}
			owner[n] = s
		}
		for _, r := range e.Results {
			secs[r.Name] = r.Seconds // unique per record, checked above
		}
	}
	for _, n := range first.Inventory {
		if _, ok := owner[n]; !ok {
			return nil, fmt.Errorf("%s is in the inventory but no shard ran it", n)
		}
	}
	wf := &weightsFile{
		Schema: weightsSchema, Package: first.Package, Pattern: first.Pattern, Unit: "seconds",
		Provenance: weightsProvenance{
			Kind: "go-test-json-corpus", Source: source, SourceSHA: first.SourceSHA,
			Toolchain: first.Toolchain, RunID: first.RunID, RunAttempt: first.RunAttempt,
			Race: true, Count: 1, Complete: true,
		},
	}
	for _, n := range first.Inventory {
		wf.Tests = append(wf.Tests, weightsEntry{Name: n, Seconds: secs[n]})
	}
	return wf, nil
}
