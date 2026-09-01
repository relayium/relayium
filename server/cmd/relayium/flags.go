package main

import "flag"

// stdFlagSet declares the shared ssh/daemon flags of push and pull, binding them
// into f. It is separate from parseFlagsStd so the help pre-scan can read the
// declared flag names off the same FlagSet the parse uses (see wantsHelpFS).
func stdFlagSet(f *sshFlags) *flag.FlagSet {
	fs := flag.NewFlagSet("relayium", flag.ContinueOnError)
	fs.StringVar(&f.identity, "i", "", "ssh identity file")
	fs.IntVar(&f.port, "p", 0, "ssh port")
	fs.BoolVar(&f.noResume, "no-resume", false, "disable resume")
	fs.StringVar(&f.configDir, "config-dir", "", "identity/trust directory (daemon direct)")
	return fs
}

// parseFlagsStd parses the shared ssh flags from a subcommand's args and
// returns the remaining positional arguments.
func parseFlagsStd(args []string) (sshFlags, []string, error) {
	var f sshFlags
	fs := stdFlagSet(&f)
	if err := parseArgs(fs, args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}
