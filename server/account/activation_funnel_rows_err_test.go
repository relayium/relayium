package account

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// TestActivationFunnelSchemaSurfacesRowIterationError proves the startup
// validator reports a mid-iteration driver failure on PRAGMA table_info as that
// failure, not as a schema "column mismatch". The fault is injected after 0, 1
// and 2 of the table's three real columns, so every truncation point is covered.
func TestActivationFunnelSchemaSurfacesRowIterationError(t *testing.T) {
	store, fault := newRowFaultStore(t)

	// Control: the unfaulted validator accepts the real schema through the seam.
	if err := validateActivationFunnelSchema(store.db); err != nil {
		t.Fatalf("control validation: %v", err)
	}

	for after := 0; after < 3; after++ {
		t.Run(fmt.Sprintf("after_%d_rows", after), func(t *testing.T) {
			fault.arm("table_info(activation_funnel_monthly)", after)
			err := validateActivationFunnelSchema(store.db)
			fired := fault.disarm()
			if len(fired) != 1 {
				t.Fatalf("fault fired %d times, want 1: %q", len(fired), fired)
			}
			if !errors.Is(err, errInjectedRowFault) {
				t.Fatalf("validator error = %v, want wrapped %v", err, errInjectedRowFault)
			}
			if !strings.HasPrefix(err.Error(), "activation funnel schema: ") {
				t.Fatalf("validator error %q lacks the schema prefix", err)
			}
		})
	}

	// The faulted rows were closed: the single-connection pool is still usable.
	if err := validateActivationFunnelSchema(store.db); err != nil {
		t.Fatalf("post-fault validation: %v", err)
	}
}
