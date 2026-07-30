package main

import (
	"flag"
	"io"
	"reflect"
	"testing"
)

// newTestFS builds a FlagSet with one bool flag, one string flag and one int
// flag — enough to cover every branch of permuteFlags.
func newTestFS() *flag.FlagSet {
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var b bool
	var s string
	var n int
	fs.BoolVar(&b, "delete", false, "bool")
	fs.StringVar(&s, "ttl", "", "string")
	fs.IntVar(&n, "p", 0, "int")
	return fs
}

func mustPermute(t *testing.T, args []string) []string {
	t.Helper()
	got, err := permuteFlags(newTestFS(), args)
	if err != nil {
		t.Fatalf("permuteFlags(%q): %v", args, err)
	}
	return got
}

func TestPermuteFlagsMovesTrailingFlagsFirst(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{
			name: "bool flag after operands",
			in:   []string{"./src", "user@host:/dst", "--delete"},
			want: []string{"--delete", "--", "./src", "user@host:/dst"},
		},
		{
			name: "value flag after operands takes its value along",
			in:   []string{"./report.pdf", "--ttl", "7d"},
			want: []string{"--ttl", "7d", "--", "./report.pdf"},
		},
		{
			name: "flag=value form stays one token",
			in:   []string{"./report.pdf", "--ttl=7d"},
			want: []string{"--ttl=7d", "--", "./report.pdf"},
		},
		{
			name: "single-dash short flag with a value",
			in:   []string{"./src", "host:/dst", "-p", "2222"},
			want: []string{"-p", "2222", "--", "./src", "host:/dst"},
		},
		{
			name: "already flags-first only gains the separator",
			in:   []string{"--delete", "./src", "host:/dst"},
			want: []string{"--delete", "--", "./src", "host:/dst"},
		},
		{
			name: "flags interleaved with operands",
			in:   []string{"./a", "--delete", "./b", "--ttl", "1h", "host:/dst"},
			want: []string{"--delete", "--ttl", "1h", "--", "./a", "./b", "host:/dst"},
		},
		{
			name: "no flags at all",
			in:   []string{"./src", "host:/dst"},
			want: []string{"--", "./src", "host:/dst"},
		},
		{
			name: "empty args",
			in:   nil,
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := mustPermute(t, tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("permuteFlags(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// An explicit "--" already ends the flags; nothing after it may be treated as a
// flag, however much it looks like one (that is how `relayium __recv -- -weird`
// protects a destination path that starts with a dash).
func TestPermuteFlagsRespectsTerminator(t *testing.T) {
	got := mustPermute(t, []string{"--delete", "--", "-not-a-flag", "./b"})
	want := []string{"--delete", "--", "-not-a-flag", "./b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	fs := newTestFS()
	if err := fs.Parse(got); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !reflect.DeepEqual(fs.Args(), []string{"-not-a-flag", "./b"}) {
		t.Fatalf("operands after parse = %q", fs.Args())
	}
}

// An unknown flag must survive into the parse so flag.Parse reports it, rather
// than being silently swallowed or (worse) eating the next operand.
func TestPermuteFlagsKeepsUnknownFlagAsSingleToken(t *testing.T) {
	got := mustPermute(t, []string{"./src", "--nope", "host:/dst"})
	want := []string{"--nope", "--", "./src", "host:/dst"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if err := newTestFS().Parse(got); err == nil {
		t.Fatal("parsing an unknown flag should still fail")
	}
}

// A value flag with nothing after it can't be reordered without it swallowing
// the separator, so permuteFlags reports it instead of mis-parsing silently.
func TestPermuteFlagsDanglingValueFlagErrors(t *testing.T) {
	if _, err := permuteFlags(newTestFS(), []string{"./src", "--ttl"}); err == nil {
		t.Fatal("a value flag with no value should be an error")
	}
	// A bool flag at the end is fine — it never wanted a value.
	if _, err := permuteFlags(newTestFS(), []string{"./src", "--delete"}); err != nil {
		t.Fatalf("trailing bool flag: %v", err)
	}
}

// A lone "-" is an operand (conventionally stdin), never a flag.
func TestPermuteFlagsLoneDashIsOperand(t *testing.T) {
	got := mustPermute(t, []string{"-", "--delete"})
	want := []string{"--delete", "--", "-"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestParseArgsSurfacesDanglingFlagError(t *testing.T) {
	fs := newTestFS()
	if err := parseArgs(fs, []string{"./src", "--ttl"}); err == nil {
		t.Fatal("parseArgs should propagate the dangling-flag error")
	}
}

// End-to-end through the real subcommand parsers: the documented trailing-flag
// form must produce the same flags and operands as the flags-first form.
func TestSubcommandParsersAcceptTrailingFlags(t *testing.T) {
	t.Run("push/pull ssh flags", func(t *testing.T) {
		f, rest, err := parseFlagsStd([]string{"./photos", "user@host:backups/", "-i", "key", "-p", "2222", "--no-resume"})
		if err != nil {
			t.Fatal(err)
		}
		if f.identity != "key" || f.port != 2222 || !f.noResume {
			t.Fatalf("flags not parsed: %+v", f)
		}
		if !reflect.DeepEqual(rest, []string{"./photos", "user@host:backups/"}) {
			t.Fatalf("operands = %q", rest)
		}
	})
	t.Run("text flags", func(t *testing.T) {
		f, rest, err := parseTextFlags([]string{"K7M4XR", "--yes", "--server", "wss://example.invalid"})
		if err != nil {
			t.Fatal(err)
		}
		if !f.yes {
			t.Fatal("--yes not parsed after the operand")
		}
		if f.server != "wss://example.invalid" {
			t.Fatalf("server = %q", f.server)
		}
		if !reflect.DeepEqual(rest, []string{"K7M4XR"}) {
			t.Fatalf("operands = %q", rest)
		}
	})
	t.Run("send/receive cross flags", func(t *testing.T) {
		f, rest, err := parseCrossFlags([]string{"./release.zip", "428571", "--verify"})
		if err != nil {
			t.Fatal(err)
		}
		if !f.verify {
			t.Fatal("--verify not parsed")
		}
		if !reflect.DeepEqual(rest, []string{"./release.zip", "428571"}) {
			t.Fatalf("operands = %q", rest)
		}
	})
	t.Run("flags-first form still works", func(t *testing.T) {
		f, rest, err := parseFlagsStd([]string{"-i", "key", "./photos", "user@host:backups/"})
		if err != nil {
			t.Fatal(err)
		}
		if f.identity != "key" {
			t.Fatalf("flags not parsed: %+v", f)
		}
		if !reflect.DeepEqual(rest, []string{"./photos", "user@host:backups/"}) {
			t.Fatalf("operands = %q", rest)
		}
	})
}
