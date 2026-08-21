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
// ## Usage
//
//	go run ../scripts/go-race-shard.go -shard 3            # from server/
//	go run ../scripts/go-race-shard.go -shard 3 -list      # names, not a regex
//	go run scripts/go-race-shard.go -shard 0 -names-from f # no build required
//	go run scripts/go-race-shard.go -where TestFoo         # which shard owns it
package main

import (
	"bufio"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
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

// listTests runs `go test -race -list` and returns the top-level test names.
//
// -race is deliberate even though listing needs no race detector: the shard job
// runs the very same package with -race immediately afterwards, so listing
// under the same build tags populates the build cache it is about to use rather
// than compiling the package twice.
func listTests(dir, pkg string) ([]string, error) {
	cmd := exec.Command("go", "test", "-race", "-list", "^Test", pkg)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("go test -race -list ^Test %s (in %s): %w\n%s", pkg, dir, err, stderr.String())
	}
	return parseTestList(stdout.String())
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

// partition assigns every name to a shard and proves the result is a partition
// of the input. It is the only place assignments are produced, so the shard job
// cannot skip the proof.
func partition(names []string, shards int) ([][]string, error) {
	if shards < 1 {
		return nil, fmt.Errorf("shards = %d, want at least 1", shards)
	}
	if len(names) == 0 {
		return nil, errors.New("no top-level tests to assign: an empty list would " +
			"produce shards that run nothing and report success")
	}
	seen := make(map[string]bool, len(names))
	out := make([][]string, shards)
	for _, name := range names {
		if name == "" || strings.ContainsAny(name, " \t\r\n") {
			return nil, fmt.Errorf("invalid test name %q: the -list output was misparsed", name)
		}
		if seen[name] {
			return nil, fmt.Errorf("duplicate test name %q in the input list", name)
		}
		seen[name] = true
		s := shardOf(name, shards)
		out[s] = append(out[s], name)
	}

	// Prove the partition rather than trusting the loop above. This is cheap
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

func main() {
	var (
		shard     = flag.Int("shard", -1, "0-based shard index to print")
		shards    = flag.Int("shards", 8, "total number of shards")
		dir       = flag.String("dir", ".", "directory to run `go test -list` in")
		pkg       = flag.String("package", "./account", "package to list tests from")
		namesFrom = flag.String("names-from", "", "read the test list from this file instead of running go test")
		asList    = flag.Bool("list", false, "print the assigned test names, one per line, instead of the regex")
		where     = flag.String("where", "", "print the shard index that owns this test name, and exit")
	)
	flag.Parse()

	if *shards < 1 {
		fail(fmt.Errorf("-shards %d, want at least 1", *shards))
	}

	// -where answers "which shard owns this name" without needing a list at
	// all. The partition rules below deliberately refuse an empty shard, which
	// makes a single name impossible to probe through -shard; this is how the
	// hash is pinned by value in scripts/test/go-race-shard-test.sh without
	// loosening that refusal.
	if *where != "" {
		if strings.ContainsAny(*where, " \t\r\n") {
			fail(fmt.Errorf("invalid test name %q", *where))
		}
		fmt.Println(shardOf(*where, *shards))
		return
	}

	if *shard < 0 || *shard >= *shards {
		fail(fmt.Errorf("-shard %d is out of range for -shards %d (valid: 0..%d)", *shard, *shards, *shards-1))
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
		names, err = listTests(*dir, *pkg)
		if err != nil {
			fail(err)
		}
	}

	parts, err := partition(names, *shards)
	if err != nil {
		fail(err)
	}

	assigned := parts[*shard]
	fmt.Fprintf(os.Stderr, "go-race-shard: shard %d/%d owns %d of %d top-level tests\n",
		*shard, *shards, len(assigned), len(names))
	if *asList {
		fmt.Println(strings.Join(assigned, "\n"))
		return
	}
	fmt.Println(runRegex(assigned))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "go-race-shard:", err)
	os.Exit(1)
}
