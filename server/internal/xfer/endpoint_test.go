package xfer

import "testing"

func TestParseEndpoint(t *testing.T) {
	cases := []struct {
		in   string
		want Endpoint
	}{
		{"me@srv:/data/x", Endpoint{User: "me", Host: "srv", Path: "/data/x"}},
		{"srv:rel/path", Endpoint{Host: "srv", Path: "rel/path"}},
		{"srv:", Endpoint{Host: "srv", Path: "."}},
		{"/local/abs", Endpoint{Path: "/local/abs"}},
		{"local/rel", Endpoint{Path: "local/rel"}},
		{"-", Endpoint{Stdin: true}},
	}
	for _, c := range cases {
		got, err := ParseEndpoint(c.in)
		if err != nil {
			t.Fatalf("ParseEndpoint(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("ParseEndpoint(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestParseEndpointRemoteDetection(t *testing.T) {
	r, _ := ParseEndpoint("me@srv:/x")
	if !r.IsRemote() {
		t.Fatal("me@srv:/x should be remote")
	}
	l, _ := ParseEndpoint("/x")
	if l.IsRemote() {
		t.Fatal("/x should be local")
	}
}
