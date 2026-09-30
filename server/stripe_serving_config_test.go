package main

import "testing"

func TestStripeServingConfigRequiresWebhookSecret(t *testing.T) {
	cases := []struct {
		key, secret string
		wantErr     bool
	}{
		{"", "", false},                   // billing disabled
		{"sk_live_x", "whsec_x", false},   // configured
		{"sk_live_x", "", true},           // A-M1: empty key is forgeable
		{"sk_live_x", "  \t", true},       // whitespace is just as forgeable
		{"sk_test_x", " whsec_x ", false}, // bytes kept as given; not blank
	}
	for _, c := range cases {
		if err := stripeServingConfigError(c.key, c.secret); (err != nil) != c.wantErr {
			t.Errorf("key=%q secret=%q: err=%v, wantErr=%v", c.key, c.secret, err, c.wantErr)
		}
	}
}
