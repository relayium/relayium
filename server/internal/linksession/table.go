// Package linksession is the pure `link/1` pairing-session state machine for
// the relayium CLI (W-N18 phase 2a3, design A08).
//
// It decides; it never performs I/O. Every machine — discovery, link
// establishment, file lane, text lane — is an explicit transition table in
// which each (class, state, event) triple has exactly one row, and the
// totality test fails if a triple is missing or duplicated. Session composes
// the tables with the linkwire classifiers and codecs, the admission and
// authorisation policies, the epoch fences and an injected clock, and reports
// what the caller must do as an ordered list of Effect values. The caller owns
// sockets, the WebRTC transport, the filesystem and the terminal.
//
// Nothing here imports a transport. The package never decides a wire by
// elapsed time (property P1): a timer can only end something.
package linksession

import (
	"fmt"
	"sort"
	"strings"
)

// Outcome is the externally visible class of a transition.
type Outcome string

const (
	OK       Outcome = "ok"           // legal transition
	Ignore   Outcome = "ignore"       // legal no-op: stale, duplicate or irrelevant input; nothing emitted
	Drop     Outcome = "drop-silent"  // untrusted input refused WITHOUT any reply (a reply would leak state)
	Capture  Outcome = "capture"      // held in a bounded buffer and replayed in arrival order later
	FailLane Outcome = "fail-lane"    // this lane is dead; the other lane and the link survive
	FailLink Outcome = "fail-link"    // the link ends; codecs are destroyed, never reused
	FailSess Outcome = "fail-session" // the whole pairing session ends with a named reason
)

// Same is the To value meaning "stay in the current state".
const Same = -1

// Row is one transition. Do is the ordered list of actions; the session
// executes exactly these, so a row is the single place a behaviour is decided.
type Row struct {
	Class  int
	From   int
	On     int
	To     int
	Result Outcome
	Do     []string
}

// Table is a total transition function for one machine.
type Table struct {
	Name    string
	Classes []string
	States  []string
	Events  []string
	rows    map[[3]int]Row
}

func newTable(name string, classes, states, events []string) *Table {
	return &Table{Name: name, Classes: classes, States: states, Events: events, rows: map[[3]int]Row{}}
}

// all returns every class index; used when a row does not depend on the class.
func (t *Table) all() []int {
	out := make([]int, len(t.Classes))
	for i := range out {
		out[i] = i
	}
	return out
}

// add registers one row per (class, event). A duplicate is a programming error
// in the table and panics at init, so it can never ship silently.
func (t *Table) add(classes []int, from int, ons []int, to int, res Outcome, do ...string) {
	for _, c := range classes {
		for _, on := range ons {
			k := [3]int{c, from, on}
			if _, dup := t.rows[k]; dup {
				panic(fmt.Sprintf("%s: duplicate row class=%s from=%s on=%s", t.Name, t.Classes[c], t.States[from], t.Events[on]))
			}
			t.rows[k] = Row{Class: c, From: from, On: on, To: to, Result: res, Do: append([]string(nil), do...)}
		}
	}
}

// Lookup returns the row for a triple.
func (t *Table) Lookup(class, from, on int) (Row, bool) {
	r, ok := t.rows[[3]int{class, from, on}]
	return r, ok
}

// Missing lists every triple without a row.
func (t *Table) Missing() []string {
	var out []string
	for c := range t.Classes {
		for s := range t.States {
			for e := range t.Events {
				if _, ok := t.rows[[3]int{c, s, e}]; !ok {
					out = append(out, fmt.Sprintf("%s/%s/%s", t.Classes[c], t.States[s], t.Events[e]))
				}
			}
		}
	}
	return out
}

// Rows returns every row in deterministic order.
func (t *Table) Rows() []Row {
	out := make([]Row, 0, len(t.rows))
	for _, r := range t.rows {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Class != b.Class {
			return a.Class < b.Class
		}
		if a.From != b.From {
			return a.From < b.From
		}
		return a.On < b.On
	})
	return out
}

// clone copies a table, for mutation tests and negative controls.
func (t *Table) clone(name string) *Table {
	c := newTable(name, t.Classes, t.States, t.Events)
	for k, r := range t.rows {
		r.Do = append([]string(nil), r.Do...)
		c.rows[k] = r
	}
	return c
}

// Machine runs one table instance.
type Machine struct {
	T     *Table
	Class int
	State int
	Trace []Step
	// entries counts state changes, so a timer armed in one visit to a state
	// is never mistaken for one armed in a later visit.
	entries uint64
}

// Step is one fired transition, recorded for assertions and vectors.
type Step struct {
	From, On, To string
	Result       Outcome
	Do           []string
}

// maxTrace bounds the recorded trace of a long-lived machine; the oldest half
// is dropped past it. Tests read short traces only.
const maxTrace = 4096

// NewMachine starts a machine in initial.
func NewMachine(t *Table, class, initial int) *Machine {
	return &Machine{T: t, Class: class, State: initial}
}

// Peek returns the row that Fire(ev) would apply, without applying it.
func (m *Machine) Peek(ev int) Row {
	r, ok := m.T.Lookup(m.Class, m.State, ev)
	if !ok {
		// Unreachable when the totality test passes; fail closed anyway.
		r = Row{Class: m.Class, From: m.State, On: ev, To: Same, Result: FailSess, Do: []string{"bug:missing-row"}}
	}
	return r
}

// Fire applies one event and returns the row that fired.
func (m *Machine) Fire(ev int) Row {
	r := m.Peek(ev)
	to := m.State
	if r.To != Same {
		to = r.To
	}
	if len(m.Trace) >= maxTrace {
		m.Trace = append(m.Trace[:0], m.Trace[maxTrace/2:]...)
	}
	m.Trace = append(m.Trace, Step{From: m.T.States[m.State], On: m.T.Events[ev], To: m.T.States[to], Result: r.Result, Do: r.Do})
	if to != m.State {
		m.entries++
	}
	m.State = to
	return r
}

// StateName is the current state's name.
func (m *Machine) StateName() string { return m.T.States[m.State] }

func has(do []string, a string) bool {
	for _, x := range do {
		if x == a {
			return true
		}
	}
	return false
}

func hasPrefix(do []string, p string) bool {
	for _, x := range do {
		if strings.HasPrefix(x, p) {
			return true
		}
	}
	return false
}

// reportOf returns the last "report:" action of a row, without the prefix.
func reportOf(do []string) string {
	for i := len(do) - 1; i >= 0; i-- {
		if r, ok := strings.CutPrefix(do[i], "report:"); ok {
			return r
		}
	}
	return ""
}

func ints(xs ...int) []int { return xs }
