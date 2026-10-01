//go:build ignore

// scripts/go-race-shard.go — assigns `server/account`'s top-level tests to a
// fixed number of race shards, and prints the anchored `-run` regex for one of
// them.
//
// ## Why this exists
//
// The account race lane was one `go test -race -timeout 45m ./...`, measured at
// ~43m35s. That is not a budget with margin; it is a lane that fails by
// TIMEOUT before it fails by finding a race, and every previous response to it
// was to raise the timeout — 10m, then 25m, then 45m, then a 60m job bound.
// Splitting the 1904 top-level tests across shards makes each shard's budget
// small enough that exceeding it means a hang worth a goroutine dump, which is
// what a finite timeout is supposed to mean.
//
// ## Why the assignment is hashed rather than striped
//
// A shard must be reproducible from the test NAME alone, with no shared state
// between the eight jobs and no index file to keep in sync. Each shard job
// independently lists the package and computes the same partition, so a test
// added in the same commit is picked up by whichever shard owns its name — no
// job needs to know what the others saw.
//
// Striping the sorted list (index % shards) would also be deterministic, but
// every insertion shifts every later test to a different shard, so one added
// test rewrites the whole partition and no shard's duration is comparable to
// its own previous run.
//
// ## The hash
//
// FNV-1a, 32-bit, over the test name's bytes, taken modulo the shard count:
//
//	h = 2166136261
//	for each byte b: h = (h XOR b) * 16777619   (mod 2^32)
//	shard = h % shards
//
// It is written out here, and pinned by golden cases in
// scripts/test/go-race-shard-test.sh, because the VALUE matters: this is a
// stable contract between CI runs, not an implementation detail. Changing the
// hash reshuffles every shard, so it must be a deliberate edit that breaks a
// test, not a silent refactor.
//
// ## Self-verification
//
// Every invocation computes the assignment for ALL shards and proves the
// partition before printing anything: every listed test lands in exactly one
// shard, the union of the shards is exactly the input list, and no two shards
// intersect. A shard that would run no tests is an error, not a silent pass —
// eight green jobs that between them ran nothing is the failure this whole
// change exists to make impossible.
//
// ## Weighted mode (-weights)
//
// FNV balances test COUNT, not test COST, and the two differ: the slowest
// account shard measured 24.9% of the serial run against the 13.4% its count
// predicts. -weights FILE switches the assignment to longest-processing-time
// first over measured per-test seconds:
//
//   - sort the compiled list by weight, heaviest first, ties by name in byte
//     order;
//   - give each test to the shard with the smallest planned load so far, ties
//     to the lowest shard index.
//
// Both orders are total, so every job derives the same plan from the same list
// regardless of the order `go test -list` emits it in. Loads are integer
// milliseconds so the plan never depends on floating-point summation.
//
// The COMPILED list stays authoritative; the weights file only orders it. A
// listed test with no measured weight still joins the plan, at the largest
// measured weight in the file (at least 1 ms), so a new test lands first rather
// than last and cannot be omitted. A weight naming no compiled test is ignored
// and counted on stderr — a renamed or deleted test must not turn CI red, and
// it can never reach a selector because selectors are built from the list. A
// measured 0.00s (go test rounds to 10 ms) plans as 1 ms, so the first SHARDS
// tests always open SHARDS distinct shards and a list at least SHARDS long can
// never leave one empty through a tie.
//
// The file itself must be what it claims to be: the schema below, no unknown
// fields, the same -package and -pattern this invocation lists, provenance
// that says -race, -count=1 and a complete measurement of a named hosted run
// (known kind, 40-hex commit, `go version` toolchain, positive run ID and
// attempt), no duplicated or missing keys, and every entry a
// unique test name that the pattern matches with a finite weight in
// [0, 21600] seconds. Anything else is an error, never a silent fallback to
// FNV — a planner that quietly ignored its input would report balanced shards
// it never built. scripts/go-race-timings.go `corpus` writes this file from
// the evidence the shard jobs upload.
//
// Weighted mode is opt-in. The account lane keeps FNV until a real eight-shard
// corpus exists and has been accepted; no weight in this repository is
// estimated.
//
// ## Other packages and patterns
//
// -package and -pattern select what is listed (default ./account and ^Test).
// The A11 renewal lane lists ./cmd/relayium with the same pattern `test` and
// `race-rest` -skip, so the shards' union is exactly the set those jobs skip.
// Every listed name must match -pattern, which catches a misparse of the list.
//
// ## Plan output
//
// -plan-out FILE writes this shard's plan as JSON (schema
// relayium.go-race-plan/1): mode, package, pattern, the weights file's SHA-256,
// shard and shard count, the sorted compiled inventory and the assigned names.
// scripts/go-race-timings.go `evidence` reads it, so the timing evidence the
// job uploads names the inventory and assignment the job actually ran rather
// than restating them. -loads prints every shard's planned milliseconds.
//
// ## Usage
//
//	go run ../scripts/go-race-shard.go -shard 3            # from server/
//	go run ../scripts/go-race-shard.go -shard 3 -list      # names, not a regex
//	go run scripts/go-race-shard.go -shard 0 -names-from f # no build required
//	go run scripts/go-race-shard.go -where TestFoo         # which shard owns it (FNV)
//	go run ../scripts/go-race-shard.go -package ./cmd/relayium \
//	    -pattern '^(TestLinkRenew|TestLDRenew)' \
//	    -weights ../scripts/go-race-timings-renewal.json -shards 2 -shard 0
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
	"os/exec"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

const (
	fnvOffset32 = 2166136261
	fnvPrime32  = 16777619
)

// shardOf is the whole assignment rule. See the package comment.
func shardOf(name string, shards int) int {
	h := uint32(fnvOffset32)
	for i := 0; i < len(name); i++ {
		h ^= uint32(name[i])
		h *= fnvPrime32
	}
	return int(h % uint32(shards))
}

// listTests runs `go test -race -list <pattern>` and returns the top-level test
// names.
//
// -race is deliberate even though listing needs no race detector: the shard job
// runs the very same package with -race immediately afterwards, so listing
// under the same build tags populates the build cache it is about to use rather
// than compiling the package twice.
func listTests(dir, pkg, pattern string) ([]string, error) {
	cmd := exec.Command("go", "test", "-race", "-list", pattern, pkg)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("go test -race -list %s %s (in %s): %w\n%s", pattern, pkg, dir, err, stderr.String())
	}
	return parseTestList(stdout.String())
}

// checkPattern refuses a listed name the -list pattern does not match. go test
// only lists matching names, so a mismatch means the list was misparsed or
// came from a different pattern — and a shard built from it would not be the
// set `test` and `race-rest` -skip.
func checkPattern(names []string, pattern string) error {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("-pattern %q does not compile: %w", pattern, err)
	}
	for _, name := range names {
		if !re.MatchString(name) {
			return fmt.Errorf("listed test %q does not match -pattern %q", name, pattern)
		}
	}
	return nil
}

// parseTestList extracts the test names from `go test -list` output.
//
// ## What it must drop, and what it must NOT drop
//
// go test prints a trailing summary line — `ok  <pkg> 0.070s`, or `FAIL <pkg>`,
// or a `?   <pkg> [no test files]` — after the names. Those have to be dropped,
// and they are recognisable because a Go test function name is a valid Go
// identifier: it cannot contain whitespace, and no summary line names a test
// even after its own leading padding is removed.
//
// The rule is therefore split in two, and the split is the whole point:
//
//   - The CLAIM is judged on the trimmed line. If what remains after trimming
//     starts with "Test", the line is claiming to name a test.
//   - The VERDICT is judged on the original line. A name go test actually
//     emitted is the trimmed form exactly, with no whitespace anywhere in it.
//
// A line that makes the claim and fails the verdict is an ERROR, never a skip.
// Skipping is what went wrong twice. First `TestFoo Bar` — a name the caller
// believes is a test — matched the "Test" prefix, contained a space, and was
// silently discarded. Then `  TestIndented` survived the repair, because its
// "Test" is not at byte 0: the raw prefix test missed it and it left through
// the summary-output branch instead. Both endings are the same: the partition
// proves itself over the REMAINING names and reports success, so a test the
// caller listed stops being race-checked with every check green. That is the
// silent-omission failure the shard proof exists to prevent, arriving one layer
// earlier where the proof cannot see it.
func parseTestList(out string) ([]string, error) {
	var names []string
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	line := 0
	for sc.Scan() {
		line++
		// Only \r is trimmed off the retained value: a name arriving with stray
		// indentation is a misparse worth reporting, not worth repairing.
		text := strings.TrimRight(sc.Text(), "\r")
		trimmed := strings.TrimSpace(text)
		if !strings.HasPrefix(trimmed, "Test") {
			continue // summary output: "ok  <pkg> 0.070s", "FAIL", "?   <pkg> ..."
		}
		if text != trimmed || strings.ContainsAny(text, " \t") {
			// Nothing go test emits reaches here. Its summary lines start with
			// "ok"/"FAIL"/"?" and still do after trimming, even for a package
			// whose path ends in "Test", so they leave through the branch above.
			return nil, fmt.Errorf("line %d of the test list, %q, names a test once trimmed "+
				"but is not a name go test emitted: a Go test function name is an identifier, "+
				"so it carries no leading, trailing or interior whitespace. Dropping it would "+
				"silently remove a test from every shard", line, text)
		}
		names = append(names, text)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("reading the test list: %w", err)
	}
	return names, nil
}

// partition assigns every name to a shard by FNV and proves the result is a
// partition of the input.
func partition(names []string, shards int) ([][]string, error) {
	if err := checkNames(names, shards); err != nil {
		return nil, err
	}
	out := make([][]string, shards)
	for _, name := range names {
		s := shardOf(name, shards)
		out[s] = append(out[s], name)
	}
	return prove(names, out)
}

// partitionWeighted assigns every name by longest-processing-time first (see
// the package comment) and proves the result is a partition of the input. It
// also returns each shard's planned load in milliseconds.
func partitionWeighted(names []string, shards int, w *weights) ([][]string, []int64, error) {
	if err := checkNames(names, shards); err != nil {
		return nil, nil, err
	}
	type item struct {
		name string
		ms   int64
	}
	items := make([]item, len(names))
	for i, name := range names {
		ms, ok := w.ms[name]
		if !ok {
			ms = w.unknownMS
		}
		items[i] = item{name, ms}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ms != items[j].ms {
			return items[i].ms > items[j].ms
		}
		return items[i].name < items[j].name
	})
	out := make([][]string, shards)
	loads := make([]int64, shards)
	for _, it := range items {
		best := 0
		for s := 1; s < shards; s++ {
			if loads[s] < loads[best] {
				best = s
			}
		}
		out[best] = append(out[best], it.name)
		loads[best] += it.ms
	}
	parts, err := prove(names, out)
	return parts, loads, err
}

// checkNames is the input half of the proof, shared by both modes.
func checkNames(names []string, shards int) error {
	if shards < 1 {
		return fmt.Errorf("shards = %d, want at least 1", shards)
	}
	if len(names) == 0 {
		return errors.New("no top-level tests to assign: an empty list would " +
			"produce shards that run nothing and report success")
	}
	seen := make(map[string]bool, len(names))
	for _, name := range names {
		if name == "" || strings.ContainsAny(name, " \t\r\n") {
			return fmt.Errorf("invalid test name %q: the -list output was misparsed", name)
		}
		if seen[name] {
			return fmt.Errorf("duplicate test name %q in the input list", name)
		}
		seen[name] = true
	}
	return nil
}

// prove checks that out is a partition of names. It is the only way either
// mode returns an assignment, so the shard job cannot skip the proof.
func prove(names []string, out [][]string) ([][]string, error) {
	shards := len(out)
	// Prove the partition rather than trusting the assignment. This is cheap
	// and it is the assertion the whole split rests on: a test silently
	// assigned to no shard is a test that stopped being race-checked, and
	// nothing downstream would ever report it.
	total := 0
	placed := make(map[string]int, len(names))
	for i, shard := range out {
		if len(shard) == 0 {
			return nil, fmt.Errorf("shard %d of %d was assigned no tests from %d names", i, shards, len(names))
		}
		sort.Strings(shard)
		total += len(shard)
		for _, name := range shard {
			if prev, dup := placed[name]; dup {
				return nil, fmt.Errorf("%q assigned to both shard %d and shard %d", name, prev, i)
			}
			placed[name] = i
		}
	}
	if total != len(names) || len(placed) != len(names) {
		return nil, fmt.Errorf("partition covers %d/%d names (%d placed): the shards are not the input list",
			total, len(names), len(placed))
	}
	for _, name := range names {
		if _, ok := placed[name]; !ok {
			return nil, fmt.Errorf("%q was assigned to no shard", name)
		}
	}
	return out, nil
}

// runRegex is the -run pattern for one shard.
//
// Each name is anchored on BOTH ends. `^TestFoo$` still runs every subtest
// beneath TestFoo — go test matches -run element-wise against the slash
// separated parts of a test's name, and a single-element pattern constrains
// only the top level — so a shard runs its tests whole. Without the `$`,
// `^TestUser` would also drag in TestUserDelete, TestUserRename and anything
// else sharing the prefix, and those tests would then run in TWO shards.
//
// QuoteMeta escapes each name even though a Go test function name cannot
// currently contain a regex metacharacter. The cost is nothing and the failure
// it prevents is silent: one unescaped character turns an exact list into a
// pattern that quietly selects a different set of tests.
func runRegex(shard []string) string {
	escaped := make([]string, len(shard))
	for i, name := range shard {
		escaped[i] = regexp.QuoteMeta(name)
	}
	return "^(" + strings.Join(escaped, "|") + ")$"
}

// proveSelectors compiles every shard's -run pattern and checks it selects
// exactly that shard's names out of the whole list — no fewer (a quoting
// mistake), no more (a missing anchor dragging TestUserDelete in with
// TestUser). A test name matched by two selectors would run twice; one matched
// by none would not run at all.
func proveSelectors(names []string, parts [][]string) error {
	for i, shard := range parts {
		re, err := regexp.Compile(runRegex(shard))
		if err != nil {
			return fmt.Errorf("shard %d's -run pattern does not compile: %w", i, err)
		}
		own := make(map[string]bool, len(shard))
		for _, name := range shard {
			own[name] = true
		}
		for _, name := range names {
			if re.MatchString(name) != own[name] {
				return fmt.Errorf("shard %d's -run pattern matches %q = %v, but the plan says %v",
					i, name, !own[name], own[name])
			}
		}
	}
	return nil
}

// weightsSchema is the only schema -weights accepts.
const weightsSchema = "relayium.go-test-weights/1"

// maxWeightSeconds bounds one test's weight. Six hours is GitHub's own job
// ceiling: a larger number is a unit error, not a measurement.
const maxWeightSeconds = 21600

type weightsFile struct {
	Schema     string             `json:"schema"`
	Package    string             `json:"package"`
	Pattern    string             `json:"pattern"`
	Unit       string             `json:"unit"`
	Provenance weightsProvenance  `json:"provenance"`
	Tests      []weightsFileEntry `json:"tests"`
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

type weightsFileEntry struct {
	Name    string  `json:"name"`
	Seconds float64 `json:"seconds"`
}

// The provenance a weights file may claim. go-test-v-log is a hosted job's
// `-v` log read for its top-level PASS lines (the renewal file, from before
// the JSON evidence existed); go-test-json-corpus is scripts/go-race-timings.go
// `corpus` output. Either way the source names a real hosted run.
var (
	provenanceKinds = map[string]bool{"go-test-v-log": true, "go-test-json-corpus": true}
	commitRe        = regexp.MustCompile(`^[0-9a-f]{40}$`)
	toolchainRe     = regexp.MustCompile(`^go version go[0-9]+\.[0-9]+(\.[0-9]+)?([a-z]+[0-9]+)? [a-z0-9]+/[a-z0-9]+$`)
)

const (
	maxRunID        = 1<<53 - 1
	maxRunAttempt   = 1000
	maxSourceLength = 1000
)

// weights is a validated weights file, in integer milliseconds.
type weights struct {
	ms        map[string]int64
	unknownMS int64
	sha256    string
}

var testIdent = regexp.MustCompile(`^Test[A-Za-z0-9_]*$`)

// loadWeights reads and validates a weights file. Every rule is stated in the
// package comment; every violation is an error.
func loadWeights(path, pkg, pattern string) (*weights, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	var f weightsFile
	if err := decodeStrict(raw, &f); err != nil {
		return nil, fmt.Errorf("weights %s: %w", path, err)
	}
	bad := func(format string, a ...any) error {
		return fmt.Errorf("weights %s: "+format, append([]any{path}, a...)...)
	}
	if f.Schema != weightsSchema {
		return nil, bad("schema %q, want %q", f.Schema, weightsSchema)
	}
	if f.Package != pkg || f.Pattern != pattern {
		return nil, bad("measured package %q pattern %q, but this plan lists package %q pattern %q",
			f.Package, f.Pattern, pkg, pattern)
	}
	if f.Unit != "seconds" {
		return nil, bad("unit %q, want \"seconds\"", f.Unit)
	}
	p := f.Provenance
	if !provenanceKinds[p.Kind] {
		return nil, bad("provenance kind %q is not a known measurement", p.Kind)
	}
	if strings.TrimSpace(p.Source) == "" || len(p.Source) > maxSourceLength {
		return nil, bad("provenance source must describe the hosted run in 1..%d characters", maxSourceLength)
	}
	if !commitRe.MatchString(p.SourceSHA) {
		return nil, bad("provenance sourceSHA %q is not a 40-hex commit", p.SourceSHA)
	}
	if !toolchainRe.MatchString(p.Toolchain) {
		return nil, bad("provenance toolchain %q is not `go version` output", p.Toolchain)
	}
	if p.RunID < 1 || p.RunID > maxRunID || p.RunAttempt < 1 || p.RunAttempt > maxRunAttempt {
		return nil, bad("provenance run %d attempt %d is not a real GitHub run", p.RunID, p.RunAttempt)
	}
	if !p.Race || p.Count != 1 || !p.Complete {
		return nil, bad("provenance race=%v count=%d complete=%v; only a complete -race -count=1 "+
			"measurement may weight a race lane", p.Race, p.Count, p.Complete)
	}
	if len(f.Tests) == 0 {
		return nil, bad("no tests")
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("-pattern %q does not compile: %w", pattern, err)
	}
	w := &weights{ms: make(map[string]int64, len(f.Tests)), sha256: hex.EncodeToString(sum[:])}
	for i, e := range f.Tests {
		if !testIdent.MatchString(e.Name) || !re.MatchString(e.Name) {
			return nil, bad("entry %d name %q is not a test name -pattern %q matches", i, e.Name, pattern)
		}
		if _, dup := w.ms[e.Name]; dup {
			return nil, bad("entry %d duplicates %q", i, e.Name)
		}
		sec := e.Seconds
		if math.IsNaN(sec) || math.IsInf(sec, 0) || sec < 0 || sec > maxWeightSeconds {
			return nil, bad("entry %d (%s) seconds %v is outside [0, %d]", i, e.Name, sec, maxWeightSeconds)
		}
		ms := int64(math.Round(sec * 1000))
		if ms < 1 {
			ms = 1
		}
		w.ms[e.Name] = ms
		if ms > w.unknownMS {
			w.unknownMS = ms
		}
	}
	return w, nil
}

// decodeStrict refuses what encoding/json alone accepts silently: a duplicated
// key (the last value wins), an unknown field, trailing data, and a missing or
// null field (the zero value). scripts/go-race-timings.go reads its records
// the same way.
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

// plan is what -plan-out writes; scripts/go-race-timings.go reads the same
// schema with unknown fields refused, so the two cannot drift silently.
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

func main() {
	var (
		shard     = flag.Int("shard", -1, "0-based shard index to print")
		shards    = flag.Int("shards", 8, "total number of shards")
		dir       = flag.String("dir", ".", "directory to run `go test -list` in")
		pkg       = flag.String("package", "./account", "package to list tests from")
		pattern   = flag.String("pattern", "^Test", "the -list pattern: which top-level tests to partition")
		namesFrom = flag.String("names-from", "", "read the test list from this file instead of running go test")
		asList    = flag.Bool("list", false, "print the assigned test names, one per line, instead of the regex")
		where     = flag.String("where", "", "print the FNV shard index that owns this test name, and exit")
		weightsAt = flag.String("weights", "", "plan by longest-processing-time over this weights file instead of FNV")
		planOut   = flag.String("plan-out", "", "also write this shard's plan, with the full inventory, as JSON here")
		loads     = flag.Bool("loads", false, "print every shard's planned milliseconds (weighted mode), one per line, instead of the regex")
	)
	flag.Parse()

	if *shards < 1 {
		fail(fmt.Errorf("-shards %d, want at least 1", *shards))
	}

	// -where answers "which shard owns this name" without needing a list at
	// all. The partition rules below deliberately refuse an empty shard, which
	// makes a single name impossible to probe through -shard; this is how the
	// hash is pinned by value in scripts/test/go-race-shard-test.sh without
	// loosening that refusal. A weighted shard depends on the whole list, so
	// it has no single-name answer.
	if *where != "" {
		if *weightsAt != "" {
			fail(errors.New("-where answers for FNV only: a weighted assignment depends on the whole list"))
		}
		if strings.ContainsAny(*where, " \t\r\n") {
			fail(fmt.Errorf("invalid test name %q", *where))
		}
		fmt.Println(shardOf(*where, *shards))
		return
	}

	if *shard < 0 || *shard >= *shards {
		fail(fmt.Errorf("-shard %d is out of range for -shards %d (valid: 0..%d)", *shard, *shards, *shards-1))
	}
	if *loads && *weightsAt == "" {
		fail(errors.New("-loads needs -weights: an FNV plan has no planned load"))
	}

	// The weights file is validated before the package is listed, so a
	// malformed file fails in seconds rather than after a race build.
	var w *weights
	if *weightsAt != "" {
		var err error
		if w, err = loadWeights(*weightsAt, *pkg, *pattern); err != nil {
			fail(err)
		}
	}

	var (
		names []string
		err   error
	)
	if *namesFrom != "" {
		raw, readErr := os.ReadFile(*namesFrom)
		if readErr != nil {
			fail(readErr)
		}
		names, err = parseTestList(string(raw))
		if err != nil {
			fail(err)
		}
	} else {
		names, err = listTests(*dir, *pkg, *pattern)
		if err != nil {
			fail(err)
		}
	}
	if err := checkPattern(names, *pattern); err != nil {
		fail(err)
	}

	var (
		parts   [][]string
		planned = []int64{} // an FNV plan has no loads; written as [], never null
		mode    = "fnv"
		wSHA    string
	)
	if w == nil {
		parts, err = partition(names, *shards)
	} else {
		mode, wSHA = "weighted", w.sha256
		parts, planned, err = partitionWeighted(names, *shards, w)
	}
	if err != nil {
		fail(err)
	}
	if err := proveSelectors(names, parts); err != nil {
		fail(err)
	}

	assigned := parts[*shard]
	if w != nil {
		unknown, stale := 0, 0
		listed := make(map[string]bool, len(names))
		for _, name := range names {
			listed[name] = true
			if _, ok := w.ms[name]; !ok {
				unknown++
			}
		}
		for name := range w.ms {
			if !listed[name] {
				stale++
			}
		}
		fmt.Fprintf(os.Stderr, "go-race-shard: weighted: %d listed test(s) without a measured weight planned at %d ms; "+
			"%d weight(s) name no listed test and were ignored; weights sha256 %s\n", unknown, w.unknownMS, stale, wSHA)
	}
	fmt.Fprintf(os.Stderr, "go-race-shard: %s shard %d/%d owns %d of %d top-level tests\n",
		mode, *shard, *shards, len(assigned), len(names))

	if *planOut != "" {
		inventory := append([]string(nil), names...)
		sort.Strings(inventory)
		out, err := json.MarshalIndent(plan{
			Schema: "relayium.go-race-plan/1", Mode: mode, Package: *pkg, Pattern: *pattern,
			WeightsSHA256: wSHA, Shard: *shard, Shards: *shards, PlannedMS: planned,
			Inventory: inventory, Assigned: assigned,
		}, "", "  ")
		if err != nil {
			fail(err)
		}
		if err := os.WriteFile(*planOut, append(out, '\n'), 0o644); err != nil {
			fail(err)
		}
	}

	switch {
	case *loads:
		for _, ms := range planned {
			fmt.Println(ms)
		}
	case *asList:
		fmt.Println(strings.Join(assigned, "\n"))
	default:
		fmt.Println(runRegex(assigned))
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "go-race-shard:", err)
	os.Exit(1)
}
