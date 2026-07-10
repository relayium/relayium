package relayusage

import "testing"

func TestTokenFromUsername(t *testing.T) {
	cases := map[string]string{
		"1730000000:userABC.123456": "userABC.123456",
		"1730000000:123456":         "123456",
		"noselector":                "",
		"1730000000:":               "",
		"":                          "",
	}
	for in, want := range cases {
		if got := TokenFromUsername(in); got != want {
			t.Errorf("TokenFromUsername(%q)=%q want %q", in, got, want)
		}
	}
}

func TestSplitAttrib(t *testing.T) {
	uid, code := SplitAttrib("userABC.123456")
	if uid != "userABC" || code != "123456" {
		t.Fatalf("got (%q,%q)", uid, code)
	}
	uid, code = SplitAttrib("123456") // legacy anonymous, no dot
	if uid != "" || code != "123456" {
		t.Fatalf("legacy got (%q,%q)", uid, code)
	}
}
