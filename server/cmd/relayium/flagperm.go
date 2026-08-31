package main

import (
	"flag"
	"fmt"
	"strings"
)

// boolFlag is the (unexported) interface the flag package uses to recognise a
// flag that may be written bare, without a value: --delete rather than
// --delete=true. We need the same test to know whether a trailing flag eats the
// token after it.
type boolFlag interface {
	IsBoolFlag() bool
}

// permuteFlags reorders args so every flag precedes every operand, then marks
// the boundary with an explicit "--".
//
// Why this exists: flag.FlagSet.Parse stops at the first argument that does not
// look like a flag, so `relayium sync ./src host:/dst --delete` would parse zero
// flags and take "--delete" as the destination — silently doing the wrong thing.
// Trailing flags are what every example (and every user's muscle memory from
// scp/rsync) writes, so accept them: this is the same "permute" behaviour GNU
// getopt gives C programs, done in one pass before Parse ever sees the slice.
//
// The rules mirror the flag package exactly, so nothing that parsed before
// parses differently now:
//   - "--" ends the flags; everything after it is an operand, however dashy.
//   - "-" alone is an operand (stdin by convention), not a flag.
//   - "--name=value" is self-contained, one token.
//   - a bool flag is one token; any other known flag also claims the token after
//     it, which is what keeps `-p 2222` together.
//   - an unknown flag is moved as a single token, so Parse still reports it
//     rather than us guessing and swallowing an operand.
//
// The trailing "--" we emit is what makes an operand that starts with a dash
// (a file literally named "-weird") survive the reorder unharmed. It is dropped
// by Parse, so fs.Args() is unchanged.
//
// A value flag with nothing after it is the one case we must report ourselves:
// once reordered it would swallow our own "--" (or the first operand) as its
// value, so the error the user deserves would turn into a silent mis-parse.
func permuteFlags(fs *flag.FlagSet, args []string) ([]string, error) {
	if len(args) == 0 {
		return args, nil
	}
	flags := make([]string, 0, len(args))
	operands := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			operands = append(operands, args[i+1:]...)
			break
		}
		if len(a) < 2 || a[0] != '-' {
			operands = append(operands, a)
			continue
		}
		flags = append(flags, a)
		name := a[1:]
		if len(name) > 0 && name[0] == '-' {
			name = name[1:]
		}
		for j := 0; j < len(name); j++ {
			if name[j] == '=' { // --name=value carries its own value
				name = ""
				break
			}
		}
		if name == "" {
			continue
		}
		f := fs.Lookup(name)
		if f == nil {
			continue // unknown: let Parse produce the error
		}
		if bf, ok := f.Value.(boolFlag); ok && bf.IsBoolFlag() {
			continue // bare bool, no value token
		}
		if i+1 >= len(args) {
			return nil, fmt.Errorf("flag needs an argument: %s", a)
		}
		i++
		flags = append(flags, args[i])
	}
	return append(append(flags, "--"), operands...), nil
}

// wantsHelp reports whether args ask for help, so a subcommand can print its own
// usage on stdout and exit 0.
//
// Left to the flag package, `relayium push -h` prints "flag: help requested" to
// stderr and exits 2 — a diagnostic for a program, not an answer for a person
// who asked a question. This runs BEFORE permuteFlags, so it changes nothing
// about how a real flag list is reordered.
//
// valueFlags names the subcommand's flags that take a SEPARATE value token, so
// the scan can skip that token. Without it `--config-dir -h` prints help for a
// person who was actually (if oddly) naming a directory "-h", and the parse that
// would have told them so never runs. The caller passes its own flag names
// because this scan happens before the FlagSet is built; bool flags are left out
// deliberately — they claim no token, so `--delete -h` is still help.
//
// "--" ends the scan: after it, "-h" is an operand (a file may be named that).
// "--flag=value" carries its own value, so it never skips the next token. An
// unknown flag skips nothing either — the same choice permuteFlags makes, so a
// wrong flag reaches Parse and gets named instead of quietly eating an operand.
// Only the dashed spellings count; a bare "help" could be a filename.
func wantsHelp(args []string, valueFlags ...string) bool {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return false
		}
		if a == "-h" || a == "-help" || a == "--help" {
			return true
		}
		if takesValue(a, valueFlags) && i+1 < len(args) {
			i++ // the next token is this flag's value, not a request for help
		}
	}
	return false
}

// takesValue reports whether arg is one of names written in a form that puts its
// value in the FOLLOWING token ("--config-dir dir", "-p 2222") rather than in
// the same one ("--config-dir=dir").
func takesValue(arg string, names []string) bool {
	if len(arg) < 2 || arg[0] != '-' {
		return false
	}
	name := arg[1:]
	if name[0] == '-' {
		name = name[1:]
	}
	if name == "" || strings.ContainsRune(name, '=') {
		return false
	}
	for _, n := range names {
		if name == n {
			return true
		}
	}
	return false
}

// parseArgs is permuteFlags + Parse: the one entry point every subcommand uses
// so trailing flags work everywhere, not just wherever someone remembered.
func parseArgs(fs *flag.FlagSet, args []string) error {
	permuted, err := permuteFlags(fs, args)
	if err != nil {
		fmt.Fprintln(fs.Output(), err)
		return err
	}
	return fs.Parse(permuted)
}
