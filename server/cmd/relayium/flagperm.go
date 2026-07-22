package main

import (
	"flag"
	"fmt"
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
