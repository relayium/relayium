package main

// The Go half of the product↔ops deployment interface contract.
//
// `contracts/ops-deploy-v1.json` freezes the facts relayium-ops' auto-deploy
// path already assumes about this repository: which paths make it rebuild what,
// from which directory and with which argv, where the artifacts land, the
// default listener port, and — the part a bad answer rolls a release back for —
// the exact liveness/readiness routes, statuses and bodies.
//
// This file owns the RUNTIME half of that document. It drives the production
// handlers registered by `registerHealthRoutes`, through a real
// `http.ServeMux`, with the real route patterns. It deliberately does not
// declare a second handler that "behaves the same": a copy compared to a copy
// is the failure mode this contract exists to remove, and it would keep passing
// after the server it is supposed to describe changed.
//
// Two seams, chosen per claim. The method surface goes through a real
// `httptest.Server` and `http.Client`, because "what does a probe receive" is a
// question about the wire and net/http withholds a HEAD entity body at the
// server. The failure branches and the database bound stay on an
// `httptest.ResponseRecorder`, because they need a dependency state injected
// and what they assert is the handler's own decision.
//
// The declarative half — closed schema, deterministic ordering, path classes,
// placeholders, artifact cross-references and the on-disk build boundary —
// belongs to `scripts/test/ops-deploy-contract-test.mjs`, which needs no Go
// toolchain and therefore runs on every commit in `repo-hygiene.yml`.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// contractRelPath is the document this file is the Go consumer of. It is named
// verbatim because `scripts/test/contract-ci-policy-test.mjs` reads this source
// and requires it: a consumer test that quietly stopped opening the contract
// would leave a CI lane charging a runner for a file nobody reads.
const contractRelPath = "contracts/ops-deploy-v1.json"

// goConsumerRelPath is THIS file, and thisRepository is the repository it is in.
// The consumer roll in the document has to name both, or the runtime half is
// enforced by a test the contract does not know about — see
// TestOpsDeployContractConsumers.
const goConsumerRelPath = "server/ops_deploy_contract_test.go"
const thisRepository = "relayium"

// ── the document, closed ────────────────────────────────────────────────────
//
// Decoding is `DisallowUnknownFields` over the WHOLE document, not only the
// parts this file asserts about. An unknown key is a fact somebody added
// without a consumer, and the point of a closed contract is that it cannot be
// extended in silence.

type opsDeployContract struct {
	Contract              string              `json:"contract"`
	ContractVersion       int                 `json:"contractVersion"`
	Documentation         string              `json:"documentation"`
	Consumers             []contractConsumer  `json:"consumers"`
	Vocabularies          map[string][]string `json:"vocabularies"`
	BuildUnits            []contractBuildUnit `json:"buildUnits"`
	Artifacts             []contractArtifact  `json:"artifacts"`
	RepositoryRootEntries []contractRootEntry `json:"repositoryRootEntries"`
	Listener              contractListener    `json:"listener"`
	HealthEndpoints       []contractHealth    `json:"healthEndpoints"`
	Probe                 contractProbe       `json:"probe"`
}

// contractConsumer is one implementation that reads this document. `status`
// separates a consumer that already enforces the contract from one that is
// only planned, and `repository` selects whether this repository can open the
// reader at all — an external reader is a path in another repository, so it is
// recorded rather than verified here.
type contractConsumer struct {
	ID         string  `json:"id"`
	Repository string  `json:"repository"`
	Status     string  `json:"status"`
	Reader     *string `json:"reader"`
}

type contractBuildUnit struct {
	Unit               string          `json:"unit"`
	WorkingDirectory   string          `json:"workingDirectory"`
	Manifest           string          `json:"manifest"`
	Inputs             []contractInput `json:"inputs"`
	Command            contractCommand `json:"command"`
	Produces           []string        `json:"produces"`
	RebuildWhenMissing string          `json:"rebuildWhenMissing"`
}

type contractInput struct {
	Path     string `json:"path"`
	Class    string `json:"class"`
	Presence string `json:"presence"`
}

type contractCommand struct {
	Program    string   `json:"program"`
	Argv       []string `json:"argv"`
	OutputFlag *string  `json:"outputFlag"`
}

type contractArtifact struct {
	ID         string  `json:"id"`
	Path       string  `json:"path"`
	Kind       string  `json:"kind"`
	PathKind   string  `json:"pathKind"`
	ProducedBy *string `json:"producedBy"`
	GitTracked bool    `json:"gitTracked"`
}

type contractRootEntry struct {
	Entry  string `json:"entry"`
	Effect string `json:"effect"`
}

type contractListener struct {
	DefaultAddress     string `json:"defaultAddress"`
	DefaultPort        int    `json:"defaultPort"`
	AddressFlag        string `json:"addressFlag"`
	AddressEnvironment string `json:"addressEnvironment"`
}

type contractHealth struct {
	ID                          string                `json:"id"`
	Path                        string                `json:"path"`
	MethodPolicy                string                `json:"methodPolicy"`
	SuccessStatus               int                   `json:"successStatus"`
	SuccessBody                 string                `json:"successBody"`
	SuccessBodyTerminator       string                `json:"successBodyTerminator"`
	FailureStatus               *int                  `json:"failureStatus"`
	FailureModes                []contractFailureMode `json:"failureModes"`
	DatabaseTimeoutMilliseconds *int                  `json:"databaseTimeoutMilliseconds"`
}

type contractFailureMode struct {
	Reason         string `json:"reason"`
	Body           string `json:"body"`
	BodyTerminator string `json:"bodyTerminator"`
}

type contractProbe struct {
	Methods []string `json:"methods"`
	// BodylessMethods are the methods for which the DEPLOYED server sends no
	// entity body. Go's net/http suppresses the body it wrote for a HEAD
	// response, so `successBody` is the wire entity body for every method in
	// Methods that is NOT listed here.
	BodylessMethods  []string `json:"bodylessMethods"`
	NonMatchingPaths []string `json:"nonMatchingPaths"`
}

// loadOpsDeployContract reads and closes the document, or fails the test.
func loadOpsDeployContract(t *testing.T) opsDeployContract {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", contractRelPath))
	if err != nil {
		t.Fatalf("read %s: %v", contractRelPath, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var contract opsDeployContract
	if err := decoder.Decode(&contract); err != nil {
		t.Fatalf("%s: %v", contractRelPath, err)
	}
	if decoder.More() {
		t.Fatalf("%s: trailing content after the contract object", contractRelPath)
	}
	if contract.Contract != "relayium.ops.deploy" || contract.ContractVersion != 1 {
		t.Fatalf("%s: this file is the consumer of relayium.ops.deploy v1, but the document says %q v%d. "+
			"A consumer silently reading a different or later contract is the one failure a version number exists to stop.",
			contractRelPath, contract.Contract, contract.ContractVersion)
	}
	return contract
}

// endpoint returns the frozen description of one health endpoint.
func (c opsDeployContract) endpoint(t *testing.T, id string) contractHealth {
	t.Helper()
	for _, e := range c.HealthEndpoints {
		if e.ID == id {
			return e
		}
	}
	t.Fatalf("%s declares no health endpoint %q; it declares %v. Every assertion below is about "+
		"an endpoint the deploy path polls by name.", contractRelPath, id, healthIDs(c))
	return contractHealth{}
}

func healthIDs(c opsDeployContract) []string {
	out := make([]string, 0, len(c.HealthEndpoints))
	for _, e := range c.HealthEndpoints {
		out = append(out, e.ID)
	}
	return out
}

// wantBody applies the frozen terminator. `none` is the whole point of the
// field: /readyz answers `ready` with no trailing newline, and `http.Error`
// appends one — so the two directions cannot share a default.
func wantBody(t *testing.T, body, terminator string) string {
	t.Helper()
	switch terminator {
	case "none":
		return body
	case "newline":
		return body + "\n"
	default:
		t.Fatalf("unknown body terminator %q in %s", terminator, contractRelPath)
		return ""
	}
}

// ── the probes, one per frozen readiness failure mode ───────────────────────

var errProbe = errors.New("probe failed")

// readinessProbes maps each frozen failure reason to the dependency state that
// produces it. The keys are compared to the contract's own list below, so a
// reason added to the document with no state to reach it fails rather than
// being skipped, and a state here with no reason in the document fails too.
var readinessProbes = map[string]readinessProbe{
	"databaseUnavailable": {
		pingDatabase: nil,
		blobsReady:   func() error { return nil },
	},
	"databasePingFailed": {
		pingDatabase: func(context.Context) error { return errProbe },
		blobsReady:   func() error { return nil },
	},
	"blobStoreUnavailable": {
		pingDatabase: func(context.Context) error { return nil },
		blobsReady:   nil,
	},
	"blobStoreNotReady": {
		pingDatabase: func(context.Context) error { return nil },
		blobsReady:   func() error { return errProbe },
	},
}

// readyProbe is the all-dependencies-healthy state.
func readyProbe() readinessProbe {
	return readinessProbe{
		pingDatabase: func(context.Context) error { return nil },
		blobsReady:   func() error { return nil },
	}
}

// healthMux is the PRODUCTION registration on a real ServeMux, so the route
// patterns under test are the ones main() installs.
func healthMux(probe readinessProbe) *http.ServeMux {
	mux := http.NewServeMux()
	registerHealthRoutes(mux, func() readinessProbe { return probe })
	return mux
}

// serveHealth records what the HANDLER wrote.
//
// That is the right seam for the failure branches and the database bound below:
// each needs a dependency state injected, and what is being asserted is the
// handler's own decision. It is the WRONG seam for a claim about what a client
// receives — see serveHealthOverWire.
func serveHealth(probe readinessProbe, method, path string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	healthMux(probe).ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
	return recorder
}

// wireResponse is what a real client actually received.
type wireResponse struct {
	status        int
	body          string
	contentLength string
}

// serveHealthOverWire drives the same production registration through a real
// `httptest.Server` and a real `http.Client`.
//
// The difference from serveHealth is not stylistic. net/http suppresses the
// entity body of a HEAD response AT THE SERVER, after the handler has written
// it — so a ResponseRecorder reports `ready` for a request every deployed
// client answers with nothing. A contract that froze the recorder's answer as
// the wire's would be false about the only surface ops polls.
func serveHealthOverWire(t *testing.T, probe readinessProbe, method, path string) wireResponse {
	t.Helper()
	server := httptest.NewServer(healthMux(probe))
	defer server.Close()

	request, err := http.NewRequest(method, server.URL+path, nil)
	if err != nil {
		t.Fatalf("build a %s %s request: %v", method, path, err)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("%s %s over the wire: %v", method, path, err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read the %s %s response body: %v", method, path, err)
	}
	return wireResponse{
		status:        response.StatusCode,
		body:          string(body),
		contentLength: response.Header.Get("Content-Length"),
	}
}

// ── 1. the success surface on the wire, for every method the contract accepts ─
//
// Driven through a real server and a real client, because the claim is about
// what a deployed client receives. Both halves of the method policy are proved
// here: every method is ACCEPTED with the frozen status, and the frozen
// successBody is what a non-bodyless method actually gets back.

func TestOpsDeployContractHealthSuccess(t *testing.T) {
	contract := loadOpsDeployContract(t)

	if len(contract.Probe.Methods) == 0 {
		t.Fatalf("%s freezes no probe methods, so the `any`-method policy below would be asserted "+
			"against nothing.", contractRelPath)
	}
	bodyless := make(map[string]bool, len(contract.Probe.BodylessMethods))
	for _, method := range contract.Probe.BodylessMethods {
		if !slices.Contains(contract.Probe.Methods, method) {
			t.Fatalf("%s.probe.bodylessMethods names %q, which is not one of the methods it "+
				"freezes (%v). A body rule for a method nothing probes is asserted against "+
				"nothing.", contractRelPath, method, contract.Probe.Methods)
		}
		bodyless[method] = true
	}

	for _, id := range []string{"liveness", "readiness"} {
		endpoint := contract.endpoint(t, id)
		if endpoint.MethodPolicy != "any" {
			t.Fatalf("%s/%s declares methodPolicy %q; this file only knows how to prove %q.",
				contractRelPath, id, endpoint.MethodPolicy, "any")
		}
		want := wantBody(t, endpoint.SuccessBody, endpoint.SuccessBodyTerminator)
		for _, method := range contract.Probe.Methods {
			got := serveHealthOverWire(t, readyProbe(), method, endpoint.Path)
			if got.status != endpoint.SuccessStatus {
				t.Errorf("%s %s answered %d; the contract freezes %d. The deploy path treats "+
					"anything else as a failed release and rolls the binary back.",
					method, endpoint.Path, got.status, endpoint.SuccessStatus)
			}
			if !bodyless[method] {
				if got.body != want {
					t.Errorf("%s %s answered body %q on the wire; the contract freezes %q "+
						"(terminator %q). The deploy poll matches this body as a WHOLE line.",
						method, endpoint.Path, got.body, want, endpoint.SuccessBodyTerminator)
				}
				continue
			}
			// The route is still accepted — the status above proves that — but
			// net/http sends no entity body, so a client reads nothing.
			if got.body != "" {
				t.Errorf("%s %s delivered body %q; %s lists %s in probe.bodylessMethods, which "+
					"says a client receives no entity body at all.",
					method, endpoint.Path, got.body, contractRelPath, method)
			}
			// Content-Length still reports the body the handler wrote. That is
			// how "suppressed in transit" is told apart from "the handler
			// stopped writing one", which would break every OTHER method.
			if wantLength := strconv.Itoa(len(want)); got.contentLength != wantLength {
				t.Errorf("%s %s answered Content-Length %q; want %q — the length of the %q the "+
					"handler still writes and net/http then withholds. A different length means "+
					"the handler itself changed, not just the transfer.",
					method, endpoint.Path, got.contentLength, wantLength, want)
			}
		}
	}
}

// The negative proof that the seam above is load-bearing.
//
// For every bodyless method the ResponseRecorder and the wire DISAGREE, and the
// contract states the wire's answer. If TestOpsDeployContractHealthSuccess were
// reverted to driving the mux directly through a recorder — or if
// serveHealthOverWire were quietly reimplemented on one — its "no entity body"
// case would be asserted against a recorder holding the success body, and this
// test names that in one line instead of leaving it to be re-derived.

func TestOpsDeployContractBodylessMethodsDifferFromTheRecorder(t *testing.T) {
	contract := loadOpsDeployContract(t)

	if len(contract.Probe.BodylessMethods) == 0 {
		t.Fatalf("%s freezes no bodylessMethods. HEAD is in probe.methods and net/http withholds "+
			"a HEAD body, so an empty list would let the contract claim a body ops never "+
			"receives.", contractRelPath)
	}
	for _, id := range []string{"liveness", "readiness"} {
		endpoint := contract.endpoint(t, id)
		want := wantBody(t, endpoint.SuccessBody, endpoint.SuccessBodyTerminator)
		for _, method := range contract.Probe.BodylessMethods {
			handlerWrote := serveHealth(readyProbe(), method, endpoint.Path).Body.String()
			if handlerWrote != want {
				t.Fatalf("the %s handler wrote %q for %s; want %q. This test compares the two "+
					"seams, so it needs the handler half to be the frozen body first.",
					endpoint.Path, handlerWrote, method, want)
			}
			onTheWire := serveHealthOverWire(t, readyProbe(), method, endpoint.Path).body
			if onTheWire == handlerWrote {
				t.Errorf("%s %s reads %q through BOTH the ResponseRecorder and the client, so the "+
					"wire seam is not a wire: net/http withholds a %s entity body, and a helper "+
					"that reproduces the recorder proves nothing about what ops receives.",
					method, endpoint.Path, onTheWire, method)
			}
		}
	}
}

// The route patterns are exact. `http.ServeMux` would treat a trailing slash as
// a subtree, and a readiness route that also answered `/readyz/anything` is a
// different contract from the one ops polls.

func TestOpsDeployContractRoutesAreExact(t *testing.T) {
	contract := loadOpsDeployContract(t)

	liveness := contract.endpoint(t, "liveness")
	readiness := contract.endpoint(t, "readiness")
	if liveness.Path != healthzPath || readiness.Path != readyzPath {
		t.Fatalf("the server registers %q and %q; %s freezes %q and %q. The contract and the "+
			"routes it describes have drifted apart.",
			healthzPath, readyzPath, contractRelPath, liveness.Path, readiness.Path)
	}

	if len(contract.Probe.NonMatchingPaths) == 0 {
		t.Fatalf("%s freezes no non-matching paths, so exact-match routing is asserted by nothing.",
			contractRelPath)
	}
	for _, path := range contract.Probe.NonMatchingPaths {
		if path == liveness.Path || path == readiness.Path {
			t.Fatalf("%s lists %q as a non-matching path AND as a health route. One of the two is "+
				"wrong, and this case would otherwise prove the opposite of what it says.",
				contractRelPath, path)
		}
		recorder := serveHealth(readyProbe(), http.MethodGet, path)
		if recorder.Code != http.StatusNotFound {
			t.Errorf("GET %s answered %d, so it reached a health handler. The contract freezes "+
				"exactly %q and %q; a route that also answers neighbouring paths reports a "+
				"healthy server for a request nobody meant to be a probe.",
				path, recorder.Code, liveness.Path, readiness.Path)
		}
	}
}

// ── 2. every frozen readiness failure branch ────────────────────────────────

func TestOpsDeployContractReadinessFailureModes(t *testing.T) {
	contract := loadOpsDeployContract(t)
	readiness := contract.endpoint(t, "readiness")

	if readiness.FailureStatus == nil {
		t.Fatalf("%s/readiness declares a null failureStatus but %d failure modes. The deploy "+
			"path distinguishes 'not ready yet' from 'wrong service' by that status.",
			contractRelPath, len(readiness.FailureModes))
	}

	// The frozen reason list and the states this file can actually reach must be
	// the SAME set. Either direction alone is vacuous: an unreachable reason is a
	// branch nobody tests, and an untracked state is a 503 nobody froze.
	frozen := make([]string, 0, len(readiness.FailureModes))
	for _, mode := range readiness.FailureModes {
		frozen = append(frozen, mode.Reason)
	}
	reachable := make([]string, 0, len(readinessProbes))
	for reason := range readinessProbes {
		reachable = append(reachable, reason)
	}
	sort.Strings(frozen)
	sort.Strings(reachable)
	if strings.Join(frozen, ",") != strings.Join(reachable, ",") {
		t.Fatalf("%s freezes readiness failure reasons %v, but this file can construct %v. A "+
			"reason with no dependency state to reach it is a branch this contract claims to "+
			"cover and does not.", contractRelPath, frozen, reachable)
	}

	for _, mode := range readiness.FailureModes {
		probe, ok := readinessProbes[mode.Reason]
		if !ok {
			t.Fatalf("no probe for frozen reason %q", mode.Reason)
		}
		recorder := serveHealth(probe, http.MethodGet, readiness.Path)
		if recorder.Code != *readiness.FailureStatus {
			t.Errorf("readiness with %s answered %d; the contract freezes %d.",
				mode.Reason, recorder.Code, *readiness.FailureStatus)
		}
		want := wantBody(t, mode.Body, mode.BodyTerminator)
		if got := recorder.Body.String(); got != want {
			t.Errorf("readiness with %s answered body %q; the contract freezes %q.",
				mode.Reason, got, want)
		}
	}

	// Liveness is deliberately dependency-free: it answers while the database is
	// down, which is what makes the two endpoints worth having separately.
	liveness := contract.endpoint(t, "liveness")
	if len(liveness.FailureModes) != 0 || liveness.FailureStatus != nil {
		t.Fatalf("%s/liveness freezes failure modes %v and status %v. Liveness has no "+
			"dependencies to fail on, and a contract that says otherwise describes a different "+
			"endpoint.", contractRelPath, liveness.FailureModes, liveness.FailureStatus)
	}
	for _, reason := range frozen {
		recorder := serveHealth(readinessProbes[reason], http.MethodGet, liveness.Path)
		if recorder.Code != liveness.SuccessStatus {
			t.Errorf("liveness answered %d while readiness dependency state %q was in force; the "+
				"contract freezes %d unconditionally.", recorder.Code, reason, liveness.SuccessStatus)
		}
	}
}

// ── 3. the readiness database bound ─────────────────────────────────────────
//
// Asserted by reading the DEADLINE the handler installs rather than by waiting
// for it. A test that slept would take two seconds to prove one number and
// would go flaky on a loaded runner; the deadline is the same fact, available
// immediately.

func TestOpsDeployContractReadinessDatabaseTimeout(t *testing.T) {
	contract := loadOpsDeployContract(t)
	readiness := contract.endpoint(t, "readiness")

	if readiness.DatabaseTimeoutMilliseconds == nil {
		t.Fatalf("%s/readiness freezes no databaseTimeoutMilliseconds, but it freezes a "+
			"databasePingFailed mode — so the bound this file exists to pin is unstated.",
			contractRelPath)
	}
	frozen := time.Duration(*readiness.DatabaseTimeoutMilliseconds) * time.Millisecond
	if readyzDatabaseTimeout != frozen {
		t.Fatalf("the server bounds the readiness database ping at %s; %s freezes %s.",
			readyzDatabaseTimeout, contractRelPath, frozen)
	}

	var deadline time.Time
	var hasDeadline bool
	before := time.Now()
	probe := readinessProbe{
		pingDatabase: func(ctx context.Context) error {
			deadline, hasDeadline = ctx.Deadline()
			return nil
		},
		blobsReady: func() error { return nil },
	}
	recorder := serveHealth(probe, http.MethodGet, readiness.Path)
	if recorder.Code != readiness.SuccessStatus {
		t.Fatalf("readiness answered %d for a healthy probe; want %d", recorder.Code, readiness.SuccessStatus)
	}
	if !hasDeadline {
		t.Fatalf("the readiness handler passed a context with NO deadline to the database ping. "+
			"%s freezes %s, and an unbounded ping makes the deploy poll wait on the database "+
			"instead of on the server.", contractRelPath, frozen)
	}
	budget := deadline.Sub(before)
	// `before` is taken ahead of the request, so the handler's own setup can only
	// push the deadline LATER: the window is [frozen, frozen+slack]. Below
	// `frozen` means a shorter bound was installed; materially above it, a
	// longer one.
	if budget < frozen || budget > frozen+250*time.Millisecond {
		t.Fatalf("the readiness database ping was given %s; %s freezes %s.",
			budget, contractRelPath, frozen)
	}

	// And the bound is load-bearing: a ping that never returns must produce the
	// frozen failure, not a hung probe.
	blocked := readinessProbe{
		pingDatabase: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() },
		blobsReady:   func() error { return nil },
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- serveHealth(blocked, http.MethodGet, readiness.Path) }()
	select {
	case got := <-done:
		if readiness.FailureStatus == nil || got.Code != *readiness.FailureStatus {
			t.Fatalf("a database ping that blocks until the deadline answered %d; the contract "+
				"freezes %v.", got.Code, readiness.FailureStatus)
		}
	case <-time.After(frozen + 10*time.Second):
		t.Fatalf("readiness did not answer within %s of the frozen %s bound, so the deadline is "+
			"not enforced on the request path at all.", 10*time.Second, frozen)
	}
}

// ── 4. the default listener address ─────────────────────────────────────────
//
// Two halves, and both are needed. The constant must agree with the contract,
// and the FLAG must still be defaulted from the constant — otherwise the
// constant becomes a decoration this test compares to a document while the
// server listens somewhere else.

func TestOpsDeployContractListenerDefault(t *testing.T) {
	contract := loadOpsDeployContract(t)
	listener := contract.Listener

	if defaultListenAddress != listener.DefaultAddress {
		t.Fatalf("the server's default listen address is %q; %s freezes %q.",
			defaultListenAddress, contractRelPath, listener.DefaultAddress)
	}
	at := strings.LastIndex(defaultListenAddress, ":")
	if at < 0 {
		t.Fatalf("the default listen address %q has no port", defaultListenAddress)
	}
	port, err := strconv.Atoi(defaultListenAddress[at+1:])
	if err != nil {
		t.Fatalf("the default listen address %q has no numeric port: %v", defaultListenAddress, err)
	}
	if port != listener.DefaultPort {
		t.Fatalf("the default listen address %q resolves to port %d; %s freezes %d. The deploy "+
			"path addresses 127.0.0.1:%d directly.",
			defaultListenAddress, port, contractRelPath, listener.DefaultPort, listener.DefaultPort)
	}

	flagDefault, err := addrFlagDefaultExpr()
	if err != nil {
		t.Fatalf("read the -%s flag's default: %v", listener.AddressFlag, err)
	}
	wantExpr := fmt.Sprintf("envStr(%q, defaultListenAddress)", listener.AddressEnvironment)
	if flagDefault != wantExpr {
		t.Fatalf("main.go defaults -%s from `%s`; want `%s`. The contract's port is only a fact "+
			"about this server while the flag is defaulted from the constant the contract is "+
			"compared to — a literal here would let the two drift with every test still green.",
			listener.AddressFlag, flagDefault, wantExpr)
	}
}

// addrFlagDefaultExpr returns the source text of the second argument of the
// `flag.String("addr", ...)` call in main.go, normalised.
func addrFlagDefaultExpr() (string, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		return "", err
	}
	var found string
	var count int
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) < 2 {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "String" {
			return true
		}
		pkg, ok := selector.X.(*ast.Ident)
		if !ok || pkg.Name != "flag" {
			return true
		}
		name, ok := call.Args[0].(*ast.BasicLit)
		if !ok || name.Kind != token.STRING || name.Value != `"addr"` {
			return true
		}
		count++
		inner, ok := call.Args[1].(*ast.CallExpr)
		if !ok {
			found = "<not an envStr call>"
			return false
		}
		fn, ok := inner.Fun.(*ast.Ident)
		if !ok {
			found = "<not a plain function call>"
			return false
		}
		parts := make([]string, 0, len(inner.Args))
		for _, arg := range inner.Args {
			switch typed := arg.(type) {
			case *ast.BasicLit:
				parts = append(parts, typed.Value)
			case *ast.Ident:
				parts = append(parts, typed.Name)
			default:
				parts = append(parts, "<expression>")
			}
		}
		found = fmt.Sprintf("%s(%s)", fn.Name, strings.Join(parts, ", "))
		return false
	})
	if count != 1 {
		return "", fmt.Errorf(`main.go declares %d flag.String("addr", ...) calls; want exactly 1`, count)
	}
	return found, nil
}

// ── 5. the consumer roll, anchored on this file ─────────────────────────────
//
// `consumers` is a STATUS list, not a membership list. The relayium-ops half
// that reads this document and enforces it against the deploy script does not
// exist yet, and a list that named it flat would record a check nobody runs as
// one that already guards the deploy. So each entry carries the repository it
// lives in and whether it is active or pending, and the two rules that make the
// distinction mean something are asserted here and in the declarative half:
//
//   * a `pending` consumer names no reader — there is nothing to point at;
//   * an `active` consumer names one, and a reader in THIS repository must
//     exist on disk.
//
// Phase B flips `ops` to active and fills in its reader without touching this
// schema. Until it does, nothing here may present it as enforced.

func TestOpsDeployContractConsumers(t *testing.T) {
	contract := loadOpsDeployContract(t)

	statuses := contract.Vocabularies["consumerStatuses"]
	repositories := contract.Vocabularies["consumerRepositories"]
	if len(statuses) == 0 || len(repositories) == 0 {
		t.Fatalf("%s declares no consumerStatuses/consumerRepositories vocabulary, so every status "+
			"below would be free text.", contractRelPath)
	}

	var self *contractConsumer
	seen := make(map[string]bool, len(contract.Consumers))
	for i := range contract.Consumers {
		consumer := contract.Consumers[i]
		at := fmt.Sprintf("%s.consumers[%q]", contractRelPath, consumer.ID)
		if seen[consumer.ID] {
			t.Errorf("%s is declared twice. A repeated id is two statuses for one reader, and "+
				"the second silently wins.", at)
		}
		seen[consumer.ID] = true

		if !slices.Contains(statuses, consumer.Status) {
			t.Errorf("%s has status %q, which is not in vocabularies.consumerStatuses %v.",
				at, consumer.Status, statuses)
		}
		if !slices.Contains(repositories, consumer.Repository) {
			t.Errorf("%s lives in repository %q, which is not in "+
				"vocabularies.consumerRepositories %v.", at, consumer.Repository, repositories)
		}

		switch consumer.Status {
		case "pending":
			if consumer.Reader != nil {
				t.Errorf("%s is pending but names reader %q. A consumer with a reader on record is "+
					"either enforcing this contract or broken; neither is pending.",
					at, *consumer.Reader)
			}
		case "active":
			if consumer.Reader == nil {
				t.Errorf("%s is active but names no reader. `active` is the claim that something "+
					"reads this document today, and an entry with nothing to point at is how "+
					"planned enforcement gets recorded as current.", at)
			}
		}

		if consumer.Repository == thisRepository && consumer.Reader != nil {
			if _, err := os.Stat(filepath.Join("..", *consumer.Reader)); err != nil {
				t.Errorf("%s names reader %q in this repository, which is not there: %v.",
					at, *consumer.Reader, err)
			}
		}
		if consumer.Reader != nil && *consumer.Reader == goConsumerRelPath {
			self = &contract.Consumers[i]
		}
	}

	if self == nil {
		t.Fatalf("%s declares no consumer whose reader is %s — this file, which parses the "+
			"document on every run. A consumer roll that omits a reader that actually runs is the "+
			"defect the status column exists to prevent, pointed the other way.",
			contractRelPath, goConsumerRelPath)
	}
	if self.Status != "active" || self.Repository != thisRepository {
		t.Errorf("%s records this file as %q in repository %q; it is running, in %q, so it is "+
			"active here.", contractRelPath, self.Status, self.Repository, thisRepository)
	}
}
