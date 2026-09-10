package main

import (
	"fmt"
	"os"
)

func main() {
	reporter := NewReporter(os.Stdout)
	if len(os.Args) != 2 {
		fmt.Fprintf(os.Stderr, "usage: %s <config.json>\n", os.Args[0])
		_ = reporter.Emit(Record{Kind: "closed", Outcome: OutcomeUnproven,
			Findings: []string{"exactly one argument, the path of a config file, is required"}})
		os.Exit(2)
	}
	cfg, err := LoadConfig(os.Args[1])
	if err != nil {
		_ = reporter.Emit(Record{Kind: "closed", Outcome: OutcomeUnproven,
			Findings: []string{err.Error()}})
		os.Exit(2)
	}
	os.Exit(Run(cfg, Launch, os.Stdin, reporter, realClock{}))
}
