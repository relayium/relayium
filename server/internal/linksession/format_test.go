package linksession

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/linkcrypto"
	"github.com/relayium/relayium/internal/linkwire"
)

// secretForms returns the ways a secret could show up in text output.
func secretForms(b []byte) []string {
	if len(b) < 8 {
		return nil
	}
	dec := make([]string, 6)
	for i := range dec {
		dec[i] = fmt.Sprint(b[i])
	}
	return []string{
		hex.EncodeToString(b[:8]),
		strings.ToUpper(hex.EncodeToString(b[:8])),
		base64.StdEncoding.EncodeToString(b)[:12],
		strings.Join(dec, " "), // %v of a byte array/slice
		strings.Join(dec, ", "),
		fmt.Sprintf("%#x", b[0]) + ", " + fmt.Sprintf("%#x", b[1]), // %#v of a byte array
	}
}

// Key-bearing objects never print their secrets, on any path. The negative
// control proves the naive wrapper DOES leak, so this test can fail.
func TestSafeFormatting(t *testing.T) {
	l := openLoop(t, CmdPair, CmdPair)
	s := l.a.s
	lk := s.lk
	secrets := map[string][]byte{
		"send": lk.keys.Send(), "recv": lk.keys.Recv(), "resumeAuth": lk.keys.ResumeAuth(),
		"textSend": lk.keys.TextSend(), "textRecv": lk.keys.TextRecv(), "nonce": bytes.Clone(lk.nonce),
	}
	sas := lk.sas
	pk, err := derive(lk, l.b.s.lk.self.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	defer pk.wipe()

	// Any FOREIGN struct that reaches a key-bearing value through an
	// unexported field leaks under some verb, by pointer too: for %s/%d/%x fmt
	// takes its bad-verb path and re-prints the pointee at depth 0, walking
	// every field. No type can protect itself there, so the rule is on the
	// holder: TestKeyBearingTypesRedact requires every package type that
	// reaches a key to implement the set, and both holders below are negative
	// controls for it.
	type holderPtr struct{ l *Link }
	type holderVal struct{ lv Link }
	for _, typ := range []reflect.Type{reflect.TypeOf(holderPtr{}), reflect.TypeOf(holderVal{})} {
		if !reaches(typ, map[reflect.Type]bool{}) || len(missingFormatters(typ)) == 0 {
			t.Fatalf("reflection rule does not flag %v", typ)
		}
	}
	var outs []string
	for _, v := range []any{s, *s, lk, *lk, pk, *pk, []*Link{lk}, map[string]*Session{"a": s}, []any{*lk, *s}, struct{ S *Session }{s}} {
		for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
			outs = append(outs, fmt.Sprintf(verb, v))
		}
		outs = append(outs, fmt.Sprint(v), fmt.Sprintln(v))
	}
	outs = append(outs, fmt.Errorf("wrap: %w", fmt.Errorf("%v %+v", lk, s)).Error())
	for _, v := range []any{s, *s, lk, *lk, pk, struct{ L *Link }{lk}, struct{ S Session }{*s}} {
		j, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		outs = append(outs, string(j))
	}
	var sb strings.Builder
	slog.New(slog.NewTextHandler(&sb, nil)).Info("x", "session", s, "link", lk, "linkv", *lk, "pending", pk)
	slog.New(slog.NewJSONHandler(&sb, nil)).Info("x", "session", *s, "link", lk, "group", slog.GroupValue(slog.Any("l", lk)))
	outs = append(outs, sb.String())

	for _, o := range outs {
		for name, sec := range secrets {
			for _, form := range secretForms(sec) {
				if strings.Contains(o, form) {
					t.Fatalf("%s leaked as %q in: %.200s", name, form, o)
				}
			}
		}
		if strings.Contains(o, sas) {
			t.Fatalf("SAS leaked in: %.200s", o)
		}
	}

	// negative controls: Go's fmt bypasses a nested Format behind an
	// unexported field — by value under %+v, and even by pointer under %s —
	// so naive holders leak and this test is able to fail.
	type naive struct{ keys linkcrypto.SessionKeys }
	badVerb := "%s" // a variable, so vet does not reject the deliberate misuse
	for i, leak := range []string{fmt.Sprintf("%+v", naive{*lk.keys}), fmt.Sprintf(badVerb, holderPtr{lk})} {
		caught := false
		for _, sec := range secrets {
			for _, form := range secretForms(sec) {
				caught = caught || strings.Contains(leak, form)
			}
		}
		if !caught {
			t.Fatalf("negative control %d did not leak (%.80s): the redaction test would be vacuous", i, leak)
		}
		t.Logf("negative control %d leaks as expected: %.60s...", i, leak)
	}
	t.Logf("safe forms: %v | %v", s, lk)
}

// ---------------------------------------------------------------- reflection rule

// keyBearingLeaves are the types that hold a key, codec or secret directly.
var keyBearingLeaves = []reflect.Type{
	reflect.TypeOf(linkcrypto.KeyPair{}),
	reflect.TypeOf(linkcrypto.SessionKeys{}),
	reflect.TypeOf(linkwire.FileSender{}),
	reflect.TypeOf(linkwire.FileReceiver{}),
	reflect.TypeOf(linkwire.TextSender{}),
	reflect.TypeOf(linkwire.TextReceiver{}),
	reflect.TypeOf(Link{}),
	reflect.TypeOf(pendingKeys{}),
	reflect.TypeOf(Renewal{}), // holds a copy of the link's resumeAuth (A11)
}

// packageStructs registers every struct type declared in the package's
// non-test sources. TestKeyBearingTypesRedact fails if the source declares a
// struct that is not listed here, so a new type cannot skip the rule.
var packageStructs = map[string]reflect.Type{
	"Table": reflect.TypeOf(Table{}), "Row": reflect.TypeOf(Row{}), "Machine": reflect.TypeOf(Machine{}),
	"Step": reflect.TypeOf(Step{}), "signalInfo": reflect.TypeOf(signalInfo{}), "Link": reflect.TypeOf(Link{}),
	"pendingKeys": reflect.TypeOf(pendingKeys{}), "Authz": reflect.TypeOf(Authz{}), "Epoch": reflect.TypeOf(Epoch{}),
	"Config": reflect.TypeOf(Config{}), "RoomView": reflect.TypeOf(RoomView{}), "Effect": reflect.TypeOf(Effect{}),
	"timer": reflect.TypeOf(timer{}), "tables": reflect.TypeOf(tables{}), "capturedSignal": reflect.TypeOf(capturedSignal{}),
	"laneFrame": reflect.TypeOf(laneFrame{}), "fileIn": reflect.TypeOf(fileIn{}), "fileOut": reflect.TypeOf(fileOut{}),
	"queuedBatch": reflect.TypeOf(queuedBatch{}), "Session": reflect.TypeOf(Session{}),
	// A11 relay renewal
	"IceGrant": reflect.TypeOf(IceGrant{}), "RenewBound": reflect.TypeOf(RenewBound{}),
	"RenewCandidate": reflect.TypeOf(RenewCandidate{}), "RenewDeps": reflect.TypeOf(RenewDeps{}),
	"RenewProbeFrame": reflect.TypeOf(RenewProbeFrame{}), "RenewSignal": reflect.TypeOf(RenewSignal{}),
	"Renewal": reflect.TypeOf(Renewal{}), "SdpPin": reflect.TypeOf(SdpPin{}),
	"renewAttempt": reflect.TypeOf(renewAttempt{}), "renewBudget": reflect.TypeOf(renewBudget{}),
	"renewCommitted": reflect.TypeOf(renewCommitted{}), "renewConfig": reflect.TypeOf(renewConfig{}),
	"renewPayload": reflect.TypeOf(renewPayload{}), "renewRequest": reflect.TypeOf(renewRequest{}),
	"renewVerified": reflect.TypeOf(renewVerified{}),
}

func declaredStructs(t *testing.T) []string {
	t.Helper()
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		n := e.Name()
		if !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, n, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(node ast.Node) bool {
			if ts, ok := node.(*ast.TypeSpec); ok {
				if _, isStruct := ts.Type.(*ast.StructType); isStruct {
					names = append(names, ts.Name.Name)
				}
			}
			return true
		})
	}
	sort.Strings(names)
	return names
}

// reaches reports whether a value of type t can reach a key-bearing leaf.
func reaches(t reflect.Type, seen map[reflect.Type]bool) bool {
	for _, leaf := range keyBearingLeaves {
		if t == leaf {
			return true
		}
	}
	if seen[t] {
		return false
	}
	seen[t] = true
	switch t.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Array, reflect.Chan:
		return reaches(t.Elem(), seen)
	case reflect.Map:
		return reaches(t.Key(), seen) || reaches(t.Elem(), seen)
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			if reaches(t.Field(i).Type, seen) {
				return true
			}
		}
	}
	return false
}

var (
	formatterT = reflect.TypeOf((*fmt.Formatter)(nil)).Elem()
	stringerT  = reflect.TypeOf((*fmt.Stringer)(nil)).Elem()
	goStrT     = reflect.TypeOf((*fmt.GoStringer)(nil)).Elem()
	marshalT   = reflect.TypeOf((*json.Marshaler)(nil)).Elem()
	logValT    = reflect.TypeOf((*slog.LogValuer)(nil)).Elem()
)

// missingFormatters lists what t lacks ON THE VALUE RECEIVER: a
// pointer-receiver method is invisible when fmt prints a T value.
func missingFormatters(t reflect.Type) []string {
	var out []string
	for name, it := range map[string]reflect.Type{"Format": formatterT, "String": stringerT, "GoString": goStrT, "MarshalJSON": marshalT, "LogValue": logValT} {
		if !t.Implements(it) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func TestKeyBearingTypesRedact(t *testing.T) {
	declared := declaredStructs(t)
	if len(declared) == 0 {
		t.Fatal("no struct types found: the source walk is broken")
	}
	for _, n := range declared {
		if _, ok := packageStructs[n]; !ok {
			t.Errorf("struct %s is not registered in packageStructs", n)
		}
	}
	var bearing []string
	for _, n := range declared {
		typ := packageStructs[n]
		if typ == nil || !reaches(typ, map[reflect.Type]bool{}) {
			continue
		}
		bearing = append(bearing, n)
		if m := missingFormatters(typ); len(m) > 0 {
			t.Errorf("%s holds a key/codec/SAS but lacks %v on its value receiver", n, m)
		}
	}
	t.Logf("%d struct types walked; key-bearing: %v", len(declared), bearing)

	// negative control: the same walk flags a holder without the set.
	type naiveHolder struct{ lk *Link }
	nt := reflect.TypeOf(naiveHolder{})
	if !reaches(nt, map[reflect.Type]bool{}) || len(missingFormatters(nt)) == 0 {
		t.Fatal("negative control: the reflection rule does not flag a naive holder")
	}
	type deep struct {
		m map[string][]*struct{ s Session }
	}
	if !reaches(reflect.TypeOf(deep{}), map[reflect.Type]bool{}) {
		t.Fatal("negative control: the walk does not see through maps/slices/pointers")
	}
}
