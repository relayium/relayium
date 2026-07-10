// Command relayium-node is a self-reporting relay node: it runs a pion/turn
// relay, counts the bytes it relays per allocation, and heartbeats those counts
// to the central relayium server, which hands the node out in /api/ice.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
)

type config struct {
	CentralURL string
	NodeToken  string
	Region     string
	PublicIP   string
	Realm      string
	StateDir   string
	TURNPort   int
	MinPort    int
	MaxPort    int
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parseConfig() (config, error) {
	var c config
	flag.StringVar(&c.CentralURL, "central-url", env("RELAYIUM_CENTRAL_URL", ""), "central relayium server base URL, e.g. https://relayium.com")
	flag.StringVar(&c.NodeToken, "node-token", env("RELAYIUM_NODE_TOKEN", ""), "fleet bootstrap bearer token")
	flag.StringVar(&c.Region, "region", env("RELAYIUM_NODE_REGION", ""), "region label (diagnostics only)")
	flag.StringVar(&c.PublicIP, "public-ip", env("RELAYIUM_NODE_PUBLIC_IP", ""), "public IP for the TURN URL; auto-detected if empty")
	flag.StringVar(&c.Realm, "realm", env("RELAYIUM_NODE_REALM", "relayium.app"), "TURN realm advertised to clients")
	flag.StringVar(&c.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", "/var/lib/relayium-node"), "directory for state.json")
	flag.IntVar(&c.TURNPort, "turn-port", 3478, "TURN listening UDP port")
	flag.IntVar(&c.MinPort, "min-port", 49152, "relay UDP range low")
	flag.IntVar(&c.MaxPort, "max-port", 65535, "relay UDP range high")
	flag.Parse()

	var missing []string
	if c.CentralURL == "" {
		missing = append(missing, "-central-url / RELAYIUM_CENTRAL_URL")
	}
	if c.NodeToken == "" {
		missing = append(missing, "-node-token / RELAYIUM_NODE_TOKEN")
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("missing required config: %s", strings.Join(missing, ", "))
	}
	c.CentralURL = strings.TrimRight(c.CentralURL, "/")
	return c, nil
}

func main() {
	c, err := parseConfig()
	if err != nil {
		log.Fatalf("relayium-node: %v", err)
	}
	st, err := loadState(c.StateDir)
	if err != nil {
		log.Fatalf("relayium-node: load state: %v", err)
	}
	if err := run(c, st); err != nil { // run is implemented in relay.go (Task 9)
		log.Fatalf("relayium-node: %v", err)
	}
}

// run is a TEMPORARY stub so the package builds. Task 9 replaces this with
// the real pion/turn relay wiring (moved to relay.go).
func run(c config, st nodeState) error {
	log.Printf("relayium-node: config ok (central=%s region=%s state=%s) — relay wiring pending (Task 9)", c.CentralURL, c.Region, c.StateDir)
	return nil
}
