package main

import (
	"errors"

	"github.com/relayium/relayium/account"
)

// stripeServingConfigError refuses to serve with Stripe billing enabled but no
// usable webhook signing secret (audit 2026-09-28 A-M1). Checkout would still
// take payment, yet every webhook would be refused, and the reconcile sweep
// only revisits accounts that are already paid — so a first purchase would be
// charged and never fulfilled. Better not to start: the deploy's readiness gate
// then keeps the previous build serving.
func stripeServingConfigError(stripeSecretKey, webhookSecret string) error {
	if stripeSecretKey != "" && !account.WebhookSecretConfigured(webhookSecret) {
		return errors.New("RELAYIUM_STRIPE_WEBHOOK_SECRET is required (non-blank) when Stripe billing is enabled")
	}
	return nil
}
