// Command relayium-node is a self-reporting relay node: it runs a pion/turn
// relay, counts the bytes it relays per allocation, and heartbeats those counts
// to the central relayium server, which hands the node out in /api/ice.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type config struct {
	CentralURL  string
	NodeToken   string
	Region      string
	PublicIP    string
	Realm       string
	StateDir    string
	TURNPort    int
	MinPort     int
	MaxPort     int
	StorageDir  string
	StoragePort int
	DownloadURL string
	// DownloadAddr is the PUBLIC listener (Cloudflare proxies to it) serving only
	// the token-authed /dl routes. Empty disables the public listener.
	//
	// Only Cloudflare's proxied HTTPS ports work here — 443, 2053, 2083, 2087,
	// 2096, 8443; anything else the orange cloud simply won't forward. We default
	// to 2053 rather than 443 for two reasons: 443 is usually already taken on a
	// host that runs anything else web-facing, and staying above 1024 means the
	// sandbox needs no CAP_NET_BIND_SERVICE at all. Downloaders are unaffected —
	// they always talk to CF on 443; this is only the CF→origin hop.
	DownloadAddr string
	// Cloudflare auto-DNS: with both set, the node upserts its own A record
	// (subdomain of DownloadURL -> PublicIP, proxied) at startup.
	CFToken  string
	CFZoneID string
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// envInt is env for the port knobs. A node often shares a host with other
// services (a web server, coturn, another panel), so every listening port must
// be movable from the installer — which only writes env vars, never flags.
// An unparseable value falls back to the default rather than failing the node.
func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("relayium-node: %s=%q is not a number, using %d", k, v, def)
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
	flag.IntVar(&c.TURNPort, "turn-port", envInt("RELAYIUM_NODE_TURN_PORT", 3478), "TURN listening UDP port")
	flag.IntVar(&c.MinPort, "min-port", envInt("RELAYIUM_NODE_MIN_PORT", 49152), "relay UDP range low")
	flag.IntVar(&c.MaxPort, "max-port", envInt("RELAYIUM_NODE_MAX_PORT", 65535), "relay UDP range high")
	flag.StringVar(&c.StorageDir, "storage-dir", env("RELAYIUM_NODE_STORAGE_DIR", ""), "blob storage dir; empty disables node storage")
	flag.StringVar(&c.DownloadURL, "download-url", env("RELAYIUM_NODE_DOWNLOAD_URL", ""), "public https base URL for direct client downloads (e.g. https://node7.relayium.com); empty = central proxies")
	flag.StringVar(&c.DownloadAddr, "download-addr", env("RELAYIUM_NODE_DOWNLOAD_ADDR", ":2053"), "public listener for /dl (Cloudflare proxies here; must be one of CF's HTTPS ports 443/2053/2083/2087/2096/8443); empty disables it")
	flag.StringVar(&c.CFToken, "cloudflare-token", env("RELAYIUM_NODE_CF_TOKEN", ""), "Cloudflare API token (Zone:DNS:Edit) to auto-manage this node's A record; empty skips auto-DNS")
	flag.StringVar(&c.CFZoneID, "cloudflare-zone", env("RELAYIUM_NODE_CF_ZONE", ""), "Cloudflare zone id for the download domain (used with -cloudflare-token)")
	flag.IntVar(&c.StoragePort, "storage-port", envInt("RELAYIUM_NODE_STORAGE_PORT", 8081), "TCP port for the node blob HTTP server")
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
	if err := requireSecureCentral(c.CentralURL); err != nil {
		return c, err
	}
	return c, nil
}

// requireSecureCentral 拒绝非 https 的中心地址（loopback 除外）。
//
// 节点每 30 秒就把 fleet bearer token 发给中心，心跳响应里回的是 TURNSecret；配成
// http:// 的话这两样每次都以明文过网。这不是假想：`-central-url` 是安装脚本里手填的
// 一行，少个 s 不会有任何症状——节点照常工作，凭据照常泄漏。所以宁可启动失败。
//
// loopback 放行是为了本地开发和同机部署，那条路径上没有网络可窃听。
func requireSecureCentral(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid -central-url %q: %w", raw, err)
	}
	if u.Scheme == "https" {
		return nil
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return nil
	}
	return fmt.Errorf("-central-url must be https (got %q): the node sends its bearer token there every heartbeat "+
		"and receives the TURN secret back; over http both travel in the clear", raw)
}

func main() {
	// Subcommand dispatch. The node proper runs sandboxed and unprivileged and
	// can never modify binaries; `update` is a separate, root-run entry point.
	if len(os.Args) > 1 && os.Args[1] == "update" {
		uc, err := parseUpdateFlags(os.Args[2:], os.Stderr)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(exitUsage)
		}
		os.Exit(runUpdate(uc, os.Stdout, os.Stderr))
	}

	// dl-csr is root-run for the same reason update is: it writes into StateDir,
	// which the sandboxed service user owns.
	if len(os.Args) > 1 && os.Args[1] == "dl-csr" {
		cc, err := parseCSRFlags(os.Args[2:], os.Stderr)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(exitUsage)
		}
		os.Exit(runCSR(cc, os.Stdout, os.Stderr))
	}

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
