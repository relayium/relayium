package main

import (
	"flag"
	"os"
)

// crossFlagSet declares the pairing-code flags shared by send and receive,
// binding them into f. Separate from parseCrossFlags so the help pre-scan reads
// its value-flag names off the same declaration (see wantsHelpFS).
func crossFlagSet(f *crossFlags) *flag.FlagSet {
	fs := flag.NewFlagSet("cross", flag.ContinueOnError)
	fs.StringVar(&f.server, "server", defaultServer, "Relayium server base URL (self-host)")
	fs.StringVar(&f.advertise, "advertise", "", "host:port to advertise as a direct endpoint")
	fs.BoolVar(&f.verify, "verify", false, "require SAS confirmation before transfer")
	return fs
}

// sendFlagSet is crossFlagSet plus --config-dir: send mints a code with the
// stored login when no code is given, so it must read the credential from the
// same directory `relayium login --config-dir` wrote it to. receive never reads
// a credential and so does not take the flag.
func sendFlagSet(f *crossFlags) *flag.FlagSet {
	fs := crossFlagSet(f)
	fs.StringVar(&f.configDir, "config-dir", "", "credential directory (default ~/.config/relayium)")
	return fs
}

func parseSendFlags(args []string) (crossFlags, []string, error) {
	var f crossFlags
	fs := sendFlagSet(&f)
	if err := parseArgs(fs, args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}

func parseCrossFlags(args []string) (crossFlags, []string, error) {
	var f crossFlags
	fs := crossFlagSet(&f)
	if err := parseArgs(fs, args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}

func osStdin() *os.File { return os.Stdin }
