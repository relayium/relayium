package account

import "testing"

func TestCanonicalEmail(t *testing.T) {
	cases := []struct{ in, want string }{
		{"a@gmail.com", "a@gmail.com"},
		{"a+x@gmail.com", "a@gmail.com"},
		{"a.b@gmail.com", "ab@gmail.com"},
		{"ab@gmail.com", "ab@gmail.com"},
		{"A.B+tag@GoogleMail.com", "ab@googlemail.com"},
		{"a.b@example.com", "a.b@example.com"},
		{"a+x@example.com", "a@example.com"},
		{"  A@B.com  ", "a@b.com"},
		{"notanemail", "notanemail"},
	}
	for _, c := range cases {
		if got := canonicalEmail(c.in); got != c.want {
			t.Errorf("canonicalEmail(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
