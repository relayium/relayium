package main

import (
	"flag"
	"os"
)

func parseCrossFlags(args []string) (crossFlags, []string, error) {
	fs := flag.NewFlagSet("cross", flag.ContinueOnError)
	var f crossFlags
	fs.StringVar(&f.server, "server", defaultServer, "Relayium server base URL (self-host)")
	fs.StringVar(&f.advertise, "advertise", "", "host:port to advertise as a direct endpoint")
	fs.BoolVar(&f.verify, "verify", false, "require SAS confirmation before transfer")
	if err := fs.Parse(args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}

func osStdin() *os.File { return os.Stdin }
