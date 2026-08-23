package account

// The Go half of the root Device Inbox admission contract.
//
// `contracts/device-inbox-admission-v1.json` is runtime-neutral: it is not
// generated from this package and this package is not generated from it. Three
// implementations — Go, Swift and TypeScript — each parse that one file and
// compare it to the constants they already ship. Nothing here imports a
// generated symbol, and nothing here may be "fixed" by editing the runtime to
// agree with the document: a disagreement is drift between two shipped
// implementations, and the document is the place it becomes visible.
//
// What this file asserts, and why each shape is what it is:
//
//  1. The document parses STRICTLY. An unknown key is refused
//     (`DisallowUnknownFields`), and every key is a pointer or a slice so a
//     MISSING key is distinguishable from a present one holding a zero value.
//     `noErrorValue` is exactly that case: its legal value is `""`, which is
//     also what an absent string decodes to, so a non-pointer field here would
//     make a deleted fact indistinguishable from the fact itself.
//  2. The document is internally DETERMINISTIC before it is compared to
//     anything: every list has a declared order, and a strictly-increasing
//     order check is also what refuses a duplicate.
//  3. The comparison against production is EXHAUSTIVE rather than
//     representative. The transition graph is checked as all 100 ordered pairs
//     of states against `inbox.CanTransitionTask`, not as a map equality, so
//     the check also covers the self-edge refusal and the terminal-source
//     refusal that the map shape alone cannot express.
//  4. The two closed sets that have no exported enumerator in `inbox` — the
//     capability tokens and the task error codes — are read from that package's
//     SOURCE. `ValidateDeviceErrorCode` is total over strings, so testing it
//     against the contract's own universe could only ever prove that the
//     contract's members behave; it could never notice a fifteenth code added
//     to Go and to no other implementation. The source scan is what closes
//     that, and it fails loudly when it matches nothing rather than reporting
//     an empty set as agreement.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/inbox"
)

const admissionContractPath = "contracts/device-inbox-admission-v1.json"

// repositoryMarkers identify the repository root and nothing below it.
//
// The same four files `apps/RelayiumKit/Tests/RelayiumKitTests/Support/RepoRoot.swift`
// discovers by, for the same reason: a counted `../../` chain is a hard-coded
// fact about where this package sits, and when it is wrong it does not fail to
// compile — it names a path that does not exist, and a test that reads nothing
// reports the same green as a test that read everything.
var repositoryMarkers = []string{
	"apps/RelayiumKit/Package.swift",
	"server/go.mod",
	"web/package.json",
	".github/workflows/ios.yml",
}

// repositoryRoot walks up from the test's working directory until one directory
// carries every marker. It never counts levels and never falls back to a guess.
func repositoryRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	var searched []string
	for {
		searched = append(searched, dir)
		carries := true
		for _, marker := range repositoryMarkers {
			if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(marker))); err != nil {
				carries = false
				break
			}
		}
		if carries {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("no repository root above %s: walked %d directories up to %s without finding one "+
		"carrying all of %s", searched[0], len(searched), searched[len(searched)-1],
		strings.Join(repositoryMarkers, ", "))
	return ""
}

// admissionContract mirrors the document's closed key set exactly.
//
// Every field is a pointer or a slice so `DisallowUnknownFields` (which refuses
// an EXTRA key) can be paired with an explicit presence check (which refuses a
// MISSING one). Together they make the key set closed in both directions.
type admissionContract struct {
	Contract                  *string             `json:"contract"`
	ContractVersion           *int                `json:"contractVersion"`
	Documentation             *string             `json:"documentation"`
	Consumers                 []string            `json:"consumers"`
	ProtocolVersion           *int                `json:"protocolVersion"`
	KeyAlgorithm              *string             `json:"keyAlgorithm"`
	RequiredReceiveCapability *string             `json:"requiredReceiveCapability"`
	CapabilityTokenSyntax     *capabilitySyntax   `json:"capabilityTokenSyntax"`
	CapabilityTokens          []capabilityToken   `json:"capabilityTokens"`
	TaskStates                []string            `json:"taskStates"`
	TerminalStates            []string            `json:"terminalStates"`
	DeviceReportableStates    []string            `json:"deviceReportableStates"`
	StateTransitions          map[string][]string `json:"stateTransitions"`
	NoErrorValue              *string             `json:"noErrorValue"`
	DeviceReportableErrors    []string            `json:"deviceReportableErrors"`
	CentralOnlyErrors         []string            `json:"centralOnlyErrors"`
}

type capabilitySyntax struct {
	Pattern   *string `json:"pattern"`
	MaxLength *int    `json:"maxLength"`
}

type capabilityToken struct {
	Token     *string  `json:"token"`
	DefinedBy []string `json:"definedBy"`
}

// loadAdmissionContract reads and strictly decodes the document.
func loadAdmissionContract(t *testing.T) (admissionContract, string) {
	t.Helper()
	root := repositoryRoot(t)
	path := filepath.Join(root, filepath.FromSlash(admissionContractPath))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the admission contract is unreadable at %s: %v. Every consumer test in this "+
			"repository resolves the same path; a test that cannot open it must fail rather "+
			"than skip.", path, err)
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	var c admissionContract
	if err := dec.Decode(&c); err != nil {
		t.Fatalf("%s does not decode against this build's closed key set: %v", admissionContractPath, err)
	}
	if dec.More() {
		t.Fatalf("%s carries trailing content after the top-level object", admissionContractPath)
	}
	return c, root
}

// TestDeviceInboxAdmissionContractIsWellFormed judges the document alone:
// present, ordered, duplicate-free and internally consistent. It runs before
// any comparison to production, because an ill-formed document could otherwise
// agree with this package by accident — an empty list agrees with nothing at
// all, loudly and vacuously.
func TestDeviceInboxAdmissionContractIsWellFormed(t *testing.T) {
	c, root := loadAdmissionContract(t)

	// ── 1. every fact is present ────────────────────────────────────────────
	//
	// `DisallowUnknownFields` above refused an extra key. This refuses a
	// missing one, which is the direction that would otherwise let a fact be
	// DELETED from the contract while all three consumer tests kept passing
	// over the remainder.
	for name, present := range map[string]bool{
		"contract":                  c.Contract != nil,
		"contractVersion":           c.ContractVersion != nil,
		"documentation":             c.Documentation != nil,
		"consumers":                 c.Consumers != nil,
		"protocolVersion":           c.ProtocolVersion != nil,
		"keyAlgorithm":              c.KeyAlgorithm != nil,
		"requiredReceiveCapability": c.RequiredReceiveCapability != nil,
		"capabilityTokenSyntax":     c.CapabilityTokenSyntax != nil,
		"capabilityTokens":          c.CapabilityTokens != nil,
		"taskStates":                c.TaskStates != nil,
		"terminalStates":            c.TerminalStates != nil,
		"deviceReportableStates":    c.DeviceReportableStates != nil,
		"stateTransitions":          c.StateTransitions != nil,
		"noErrorValue":              c.NoErrorValue != nil,
		"deviceReportableErrors":    c.DeviceReportableErrors != nil,
		"centralOnlyErrors":         c.CentralOnlyErrors != nil,
	} {
		if !present {
			t.Errorf("%s omits the required fact %q. A deleted fact is not a smaller contract; "+
				"it is a fact no implementation is compared against any more.",
				admissionContractPath, name)
		}
	}
	if t.Failed() {
		t.FailNow()
	}

	// ── 2. identity ─────────────────────────────────────────────────────────
	if got := *c.Contract; got != "relayium.device-inbox.admission" {
		t.Errorf("contract id is %q, want %q", got, "relayium.device-inbox.admission")
	}
	if got := *c.ContractVersion; got != 1 {
		t.Errorf("contractVersion is %d, want 1. A new version is a new file beside this one, "+
			"never a rewrite of this one: a consumer pinned to v1 must keep reading v1.", got)
	}
	if got, want := *c.Documentation, "docs/DEVICE-INBOX-ADMISSION-CONTRACT.md"; got != want {
		t.Errorf("documentation pointer is %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(*c.Documentation))); err != nil {
		t.Errorf("the document this contract points at does not exist: %v. A pointer to a missing "+
			"file is how a contract stops being explainable.", err)
	}
	assertStrictlyAscending(t, "consumers", c.Consumers)
	if want := []string{"go", "swift", "web"}; !admissionEqual(c.Consumers, want) {
		t.Errorf("consumers is %v, want %v — the three implementations that each parse this file", c.Consumers, want)
	}

	// ── 3. the state vocabulary ─────────────────────────────────────────────
	//
	// `taskStates` is the ONE list with a semantic order (PRD §10 items 3-12)
	// rather than a sortable one, so it is compared as an exact sequence to
	// production below. Every other state list is checked to be a SUBSEQUENCE
	// of it — which is a deterministic order rule and a duplicate check at once.
	index := map[string]int{}
	for i, s := range c.TaskStates {
		if _, dup := index[s]; dup {
			t.Fatalf("taskStates repeats %q. A repeated state makes every subset check below "+
				"ambiguous about which occurrence it matched.", s)
		}
		index[s] = i
	}
	assertStateSubsequence(t, "terminalStates", c.TerminalStates, index)
	assertStateSubsequence(t, "deviceReportableStates", c.DeviceReportableStates, index)

	// Every state is a transition key, terminal states included. Go's own map
	// omits terminal sources because absence is how it refuses them; the
	// document states them as EMPTY lists instead, so that a consumer with no
	// transition table of its own — Swift and the browser both — can still read
	// "terminal" off the graph and compare it to its own terminal set.
	if len(c.StateTransitions) != len(c.TaskStates) {
		t.Errorf("stateTransitions has %d keys for %d states: every state must appear, terminal "+
			"ones as an empty list, so 'has no successors' is stated rather than inferred from "+
			"absence.", len(c.StateTransitions), len(c.TaskStates))
	}
	for from, targets := range c.StateTransitions {
		if _, known := index[from]; !known {
			t.Errorf("stateTransitions names the unknown source state %q", from)
			continue
		}
		assertStateSubsequence(t, "stateTransitions["+from+"]", targets, index)
		for _, to := range targets {
			if to == from {
				t.Errorf("stateTransitions[%q] contains a self-edge. A repeat of the current "+
					"state is an idempotent no-op for a caller to recognise, not a transition — "+
					"and %q -> %q would make a second commit look like a fresh one.", from, from, to)
			}
		}
	}

	// terminalStates and the graph are two spellings of one fact, and they are
	// BOTH here on purpose: this is the redundancy a consumer without a
	// transition table uses to check its own terminal set against Go's graph.
	// Redundant facts that can disagree are worse than one fact, so they are
	// compared here, once, at the source.
	terminal := map[string]bool{}
	for _, s := range c.TerminalStates {
		terminal[s] = true
	}
	for _, s := range c.TaskStates {
		hasEdges := len(c.StateTransitions[s]) > 0
		if terminal[s] == hasEdges {
			t.Errorf("state %q is listed terminal=%t but has %d outgoing transitions. The "+
				"terminal set and the graph must be two readings of one fact.",
				s, terminal[s], len(c.StateTransitions[s]))
		}
	}

	// ── 4. the error vocabulary ─────────────────────────────────────────────
	if *c.NoErrorValue != "" {
		t.Errorf("noErrorValue is %q, want the empty string. 'Nothing has gone wrong yet' is the "+
			"absence of a token, not a token named 'none'.", *c.NoErrorValue)
	}
	assertStrictlyAscending(t, "deviceReportableErrors", c.DeviceReportableErrors)
	assertStrictlyAscending(t, "centralOnlyErrors", c.CentralOnlyErrors)
	for _, code := range append(append([]string{}, c.DeviceReportableErrors...), c.CentralOnlyErrors...) {
		if code == "" {
			t.Errorf("an error list contains the empty string. The no-error value is stated once, " +
				"in `noErrorValue`, and is not a member of either nonempty set.")
		}
	}
	central := map[string]bool{}
	for _, code := range c.CentralOnlyErrors {
		central[code] = true
	}
	for _, code := range c.DeviceReportableErrors {
		if central[code] {
			t.Errorf("%q is both device-reportable and central-only. The split is the whole "+
				"point: a device that could submit one of central's codes could forge central's "+
				"own account of events.", code)
		}
	}

	// ── 5. capability tokens ────────────────────────────────────────────────
	syntax := regexp.MustCompile(*c.CapabilityTokenSyntax.Pattern)
	consumerSet := map[string]bool{}
	for _, name := range c.Consumers {
		consumerSet[name] = true
	}
	var tokens []string
	for _, entry := range c.CapabilityTokens {
		if entry.Token == nil || entry.DefinedBy == nil {
			t.Fatalf("a capabilityTokens entry omits `token` or `definedBy`")
		}
		tokens = append(tokens, *entry.Token)
		if !syntax.MatchString(*entry.Token) {
			t.Errorf("capability token %q does not match the contract's own syntax %q",
				*entry.Token, *c.CapabilityTokenSyntax.Pattern)
		}
		if len(*entry.Token) > *c.CapabilityTokenSyntax.MaxLength {
			t.Errorf("capability token %q is longer than the contract's own maxLength %d",
				*entry.Token, *c.CapabilityTokenSyntax.MaxLength)
		}
		assertStrictlyAscending(t, "definedBy of "+*entry.Token, entry.DefinedBy)
		if len(entry.DefinedBy) == 0 {
			t.Errorf("capability token %q is defined by no consumer at all, so no test compares "+
				"it to anything", *entry.Token)
		}
		for _, name := range entry.DefinedBy {
			if !consumerSet[name] {
				t.Errorf("capability token %q names the unknown consumer %q", *entry.Token, name)
			}
		}
	}
	assertStrictlyAscending(t, "capabilityTokens", tokens)
	if !admissionContains(tokens, *c.RequiredReceiveCapability) {
		t.Errorf("requiredReceiveCapability %q is not one of the declared capability tokens",
			*c.RequiredReceiveCapability)
	}
}

// TestDeviceInboxAdmissionContractMatchesGoProduction compares the document to
// the constants and predicates this server actually enforces.
func TestDeviceInboxAdmissionContractMatchesGoProduction(t *testing.T) {
	c, root := loadAdmissionContract(t)

	// ── the protocol tokens ─────────────────────────────────────────────────
	if got := inbox.KeyAlgX25519SealedBoxV1; got != *c.KeyAlgorithm {
		t.Errorf("Go wraps with %q, the contract freezes %q", got, *c.KeyAlgorithm)
	}
	// The two bounds are checked separately rather than as one `||`. They are
	// currently the SAME constant, so a combined condition reads to `go vet` as a
	// redundant or — and, more to the point, a build that grew a dual stack must
	// fail here naming which end moved, not merely that one did.
	for _, bound := range []struct {
		what  string
		value int
	}{{"MinProtocolVersion", inbox.MinProtocolVersion}, {"MaxProtocolVersion", inbox.MaxProtocolVersion}} {
		if bound.value != *c.ProtocolVersion {
			t.Errorf("Go's %s is %d, the contract freezes protocolVersion %d. This build has no "+
				"dual stack: both bounds and the contract are one number.",
				bound.what, bound.value, *c.ProtocolVersion)
		}
	}
	if got, want := inbox.SupportedReceiveCapabilities(), []string{*c.RequiredReceiveCapability}; !admissionEqual(got, want) {
		t.Errorf("central negotiates receive capabilities %v, the contract freezes %v", got, want)
	}

	// ── the state vocabulary, as an exact ordered set ───────────────────────
	if got := inbox.TaskStates(); !admissionEqual(got, c.TaskStates) {
		t.Errorf("Go's server states are %v, the contract freezes %v (order included: it is the "+
			"PRD's, and every other list here is ordered by it)", got, c.TaskStates)
	}
	for _, s := range c.TaskStates {
		if got, want := inbox.IsTerminalTaskState(s), admissionContains(c.TerminalStates, s); got != want {
			t.Errorf("Go says terminal(%q)=%t, the contract says %t", s, got, want)
		}
		if got, want := inbox.IsDeviceReportableState(s), admissionContains(c.DeviceReportableStates, s); got != want {
			t.Errorf("Go says deviceReportable(%q)=%t, the contract says %t", s, got, want)
		}
	}

	// ── the transition graph, as all 100 ordered pairs ──────────────────────
	//
	// Every pair rather than a map comparison. A map equality would agree with
	// `CanTransitionTask` on the listed edges and say nothing at all about the
	// two refusals that are not edges: a terminal SOURCE, and `from == to`.
	// Both are load-bearing — the second is what stops `saved -> saved` from
	// overwriting an honest commit timestamp — and both are only observable by
	// asking about a pair the map does not contain.
	pairs := 0
	for _, from := range c.TaskStates {
		for _, to := range c.TaskStates {
			pairs++
			want := admissionContains(c.StateTransitions[from], to)
			if got := inbox.CanTransitionTask(from, to); got != want {
				t.Errorf("Go says %q -> %q is %t, the contract's graph says %t", from, to, got, want)
			}
		}
	}
	if want := len(c.TaskStates) * len(c.TaskStates); pairs != want {
		t.Errorf("the transition sweep covered %d pairs, want %d", pairs, want)
	}

	// ── the error vocabulary, by behaviour and by source ────────────────────
	if err := inbox.ValidateDeviceErrorCode(*c.NoErrorValue); err != nil {
		t.Errorf("Go refuses the contract's no-error value %q: %v", *c.NoErrorValue, err)
	}
	for _, code := range c.DeviceReportableErrors {
		if err := inbox.ValidateDeviceErrorCode(code); err != nil {
			t.Errorf("Go refuses the device-reportable code %q: %v", code, err)
		}
	}
	for _, code := range c.CentralOnlyErrors {
		if err := inbox.ValidateDeviceErrorCode(code); err == nil {
			t.Errorf("Go ACCEPTS %q from a device, but the contract reserves it to central. A "+
				"device that can submit central's own codes can forge central's account of events.", code)
		}
	}
	for _, code := range []string{"none", "None", "unknown", "download_failed ", "Internal", "  ", "internal_"} {
		if err := inbox.ValidateDeviceErrorCode(code); err == nil {
			t.Errorf("Go accepts the off-contract device error code %q", code)
		}
	}

	// The closed sets `inbox` does not export an enumerator for, read from its
	// source. Without this the two checks above could only prove that the
	// contract's own members behave; a code or a capability added to Go and to
	// nothing else would pass every one of them.
	assertSourceLiterals(t, root, "server/internal/inbox/task.go", `\bTaskErr(\w*)\s*=\s*"([^"]*)"`,
		append(append([]string{*c.NoErrorValue}, c.DeviceReportableErrors...), c.CentralOnlyErrors...),
		"task error code")
	assertSourceLiterals(t, root, "server/internal/inbox/inbox.go", `\bCap(\w*)\s*=\s*"([^"]*)"`,
		contractTokensFor(c, "go"), "capability token")

	// ── capability syntax: the regex and the validator agree ────────────────
	//
	// The contract states the syntax as a pattern because two of the three
	// consumers have no validator at all. Go DOES have one, so here the pattern
	// is not merely applied to the contract's own tokens — it is compared to
	// `ValidateCapabilities`'s verdict, token by token, including on shapes
	// chosen to sit either side of each rule.
	syntax := regexp.MustCompile(*c.CapabilityTokenSyntax.Pattern)
	probes := append([]string{}, contractTokensFor(c, "go")...)
	probes = append(probes,
		"inbox.receive.v10", "a.v1", "inbox.receive.v3.v1",
		"v1", "inbox", "inbox.v0", "inbox.v01", "inbox..v1", "inbox.receive.",
		"Inbox.receive.v1", "inbox.receive.V1", "inbox.receive.v1x", "inbox_receive.v1",
		"", strings.Repeat("a", *c.CapabilityTokenSyntax.MaxLength-3)+".v1",
	)
	for _, token := range probes {
		_, err := inbox.ValidateCapabilities([]string{token})
		wantOK := err == nil
		gotOK := syntax.MatchString(token) && len(token) <= *c.CapabilityTokenSyntax.MaxLength
		if gotOK != wantOK {
			t.Errorf("capability token %q: the contract's pattern says valid=%t, Go's "+
				"ValidateCapabilities says valid=%t", token, gotOK, wantOK)
		}
	}
	if inbox.MaxCapabilityLen != *c.CapabilityTokenSyntax.MaxLength {
		t.Errorf("Go bounds a capability token at %d bytes, the contract freezes %d",
			inbox.MaxCapabilityLen, *c.CapabilityTokenSyntax.MaxLength)
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

// assertSourceLiterals reads a Go source file and asserts that the string
// literals its named constants are assigned are EXACTLY `want`.
//
// Comment lines are dropped first: several of the constants below are described
// in prose immediately above themselves, and a raw scan would answer the prose.
// A scan that matches nothing fails rather than reporting an empty set as
// agreement — that is the same "read nothing, report clean" shape this whole
// batch exists to make impossible.
func assertSourceLiterals(t *testing.T, root, relPath, pattern string, want []string, what string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relPath)))
	if err != nil {
		t.Fatalf("the %s source at %s is unreadable: %v", what, relPath, err)
	}
	var code []string
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		code = append(code, line)
	}
	found := map[string]bool{}
	for _, m := range regexp.MustCompile(pattern).FindAllStringSubmatch(strings.Join(code, "\n"), -1) {
		found[m[2]] = true
	}
	if len(found) == 0 {
		t.Fatalf("the %s scan of %s matched nothing. An empty scan agrees with every contract "+
			"there is; either the pattern %q no longer describes those declarations or they moved.",
			what, relPath, pattern)
	}
	wanted := map[string]bool{}
	for _, v := range want {
		wanted[v] = true
	}
	for v := range found {
		if !wanted[v] {
			t.Errorf("%s %q is declared in %s but is absent from the contract. A value only one "+
				"implementation knows is drift, whichever direction it was added in.", what, v, relPath)
		}
	}
	for v := range wanted {
		if !found[v] {
			t.Errorf("%s %q is frozen by the contract but is declared nowhere in %s", what, v, relPath)
		}
	}
}

// contractTokensFor returns the capability tokens a named consumer declares.
func contractTokensFor(c admissionContract, consumer string) []string {
	var out []string
	for _, entry := range c.CapabilityTokens {
		if admissionContains(entry.DefinedBy, consumer) {
			out = append(out, *entry.Token)
		}
	}
	return out
}

// assertStrictlyAscending is the contract's order rule for every list without a
// semantic order — and, because it is STRICT, its duplicate check as well.
func assertStrictlyAscending(t *testing.T, what string, values []string) {
	t.Helper()
	for i := 1; i < len(values); i++ {
		if values[i-1] >= values[i] {
			t.Errorf("%s is not strictly ascending at %q, %q. Lexicographic order is what makes "+
				"this document byte-identical for one set of facts, and strictness is what "+
				"refuses a duplicate.", what, values[i-1], values[i])
		}
	}
}

// assertStateSubsequence is the order rule for a list of states: it must appear
// in `taskStates` order, which again refuses duplicates and unknown members.
func assertStateSubsequence(t *testing.T, what string, values []string, index map[string]int) {
	t.Helper()
	last := -1
	for _, s := range values {
		at, known := index[s]
		if !known {
			t.Errorf("%s names %q, which is not one of the contract's task states", what, s)
			continue
		}
		if at <= last {
			t.Errorf("%s lists %q out of taskStates order (or twice)", what, s)
		}
		last = at
	}
}

func admissionContains(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

func admissionEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
