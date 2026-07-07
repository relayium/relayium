package main

import "flag"

// parseFlagsStd parses the shared ssh flags from a subcommand's args and
// returns the remaining positional arguments.
func parseFlagsStd(args []string) (sshFlags, []string, error) {
	fs := flag.NewFlagSet("relayium", flag.ContinueOnError)
	var f sshFlags
	fs.StringVar(&f.identity, "i", "", "ssh identity file")
	fs.IntVar(&f.port, "p", 0, "ssh port")
	fs.BoolVar(&f.noResume, "no-resume", false, "disable resume")
	if err := fs.Parse(args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}
