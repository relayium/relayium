package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// revealSite is one non-test construction of an account.LogMailer.
type revealSite struct {
	file          string
	hasReveal     bool // the literal mentions RevealLinks at all
	literalReveal bool // ... and hardcodes it to `true`
}

// TestRevealLinksHasExactlyOneProductionSite enforces invariant I5 as an
// executable rule instead of a review habit: plaintext credential links may be
// enabled from exactly one place in non-test code, and even there the value must
// come from the validated mail plan rather than a hardcoded `true`.
//
// It parses every non-test Go file in the repository and finds each composite
// literal whose type is LogMailer (either `account.LogMailer` from outside the
// package or a bare `LogMailer` inside it).
func TestRevealLinksHasExactlyOneProductionSite(t *testing.T) {
	repoRoot, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}

	var sites []revealSite
	fset := token.NewFileSet()
	err = filepath.WalkDir(repoRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "dist", "vendor", ".build", ".worktrees":
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			return err // a Go file that does not parse must not be silently skipped
		}
		rel, _ := filepath.Rel(repoRoot, path)
		ast.Inspect(f, func(n ast.Node) bool {
			lit, ok := n.(*ast.CompositeLit)
			if !ok || !isLogMailerType(lit.Type) {
				return true
			}
			site := revealSite{file: rel}
			for _, elt := range lit.Elts {
				kv, ok := elt.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				key, ok := kv.Key.(*ast.Ident)
				if !ok || key.Name != "RevealLinks" {
					continue
				}
				site.hasReveal = true
				if id, ok := kv.Value.(*ast.Ident); ok && id.Name == "true" {
					site.literalReveal = true
				}
			}
			sites = append(sites, site)
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(sites) == 0 {
		t.Fatal("found no LogMailer construction at all — this policy test has stopped seeing the code it guards")
	}

	var withReveal []string
	for _, s := range sites {
		if s.literalReveal {
			t.Errorf("%s hardcodes RevealLinks: true. Plaintext credential links must come from planMail, "+
				"which refuses them unless there is no SMTP and the base URL is a literal local address.", s.file)
		}
		if s.hasReveal {
			withReveal = append(withReveal, s.file)
		}
	}

	const authorized = "server/main.go"
	if len(withReveal) != 1 || withReveal[0] != authorized {
		t.Fatalf("exactly one non-test site may set RevealLinks, and it must be %s; found %v "+
			"(all LogMailer constructions: %v)", authorized, withReveal, siteFiles(sites))
	}
}

// TestPlanMailIsTheOnlySourceOfReveal pins the other half of I5: within non-test
// code, `RevealLinks: true` as a value may only ever be produced by the
// dev-log-links branch of planMail.
func TestPlanMailIsTheOnlySourceOfReveal(t *testing.T) {
	src, err := os.ReadFile("mailconfig.go")
	if err != nil {
		t.Fatalf("read mailconfig.go: %v", err)
	}
	if n := strings.Count(string(src), "RevealLinks: true"); n != 1 {
		t.Fatalf("planMail should enable reveal in exactly one branch, found %d occurrences", n)
	}
	// And that one occurrence must be inside the dev-log-links case, after the
	// SMTP and local-base-URL guards.
	text := string(src)
	caseIdx := strings.Index(text, "case mailTransportDevLogLinks:")
	revealIdx := strings.Index(text, "RevealLinks: true")
	if caseIdx < 0 || revealIdx < caseIdx {
		t.Fatal("RevealLinks: true is not inside the dev-log-links branch")
	}
	guard := text[caseIdx:revealIdx]
	for _, want := range []string{"smtpAddr != \"\"", "requireLocalBaseURL(baseURL)"} {
		if !strings.Contains(guard, want) {
			t.Errorf("the dev-log-links branch must check %s before revealing links", want)
		}
	}
}

func isLogMailerType(e ast.Expr) bool {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name == "LogMailer"
	case *ast.SelectorExpr:
		return t.Sel.Name == "LogMailer"
	}
	return false
}

func siteFiles(sites []revealSite) []string {
	out := make([]string, 0, len(sites))
	for _, s := range sites {
		out = append(out, s.file)
	}
	return out
}
