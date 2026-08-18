package account

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// Refund creation is a deliberately small authority boundary. Provider POSTs
// may live only in the two durable operator sagas; workers and webhook handlers
// are limited to discovery, cancellation, evidence and alerts.
func TestStripeRefundPostsAreOperatorOnly(t *testing.T) {
	allowed := map[string]bool{
		"executeDuplicateRefundAction": true,
		"ResolveBillingDeletionRefund": true,
	}
	files := []string{"billing_duplicate_refund.go", "billing_deletion_manual.go", "stripe.go", "billing.go", "billing_deletion.go"}
	for _, name := range files {
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), name, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				post, refunds := false, false
				for _, arg := range call.Args {
					ast.Inspect(arg, func(part ast.Node) bool {
						switch value := part.(type) {
						case *ast.SelectorExpr:
							post = post || value.Sel.Name == "MethodPost"
						case *ast.BasicLit:
							decoded, _ := strconv.Unquote(value.Value)
							refunds = refunds || strings.Contains(decoded, "/v1/refunds")
						}
						return true
					})
				}
				if post && refunds && !allowed[fn.Name.Name] {
					t.Errorf("%s may reach Stripe refund endpoint outside an operator saga", fn.Name.Name)
				}
				return true
			})
		}
	}

	src, err := os.ReadFile("billing_duplicate_refund.go")
	if err != nil {
		t.Fatal(err)
	}
	runStart := strings.Index(string(src), "func (s *Service) runDuplicateRefund")
	runEnd := strings.Index(string(src)[runStart:], "func (s *Service) ReconcileDuplicateRefunds")
	if runStart < 0 || runEnd < 0 || strings.Contains(string(src)[runStart:runStart+runEnd], "ResolveDuplicateRefund(") {
		t.Fatal("duplicate refund worker regained operator refund authority")
	}
}
