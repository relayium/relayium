package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pion/turn/v4"
)

// version is stamped by goreleaser via -ldflags; a dev build reports "dev".
var version = "dev"

// longTermPassword computes the TURN-REST password for a username exactly as the
// central /api/ice does: base64(HMAC-SHA1(secret, username)).
func longTermPassword(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// credentialExpired reports whether the "<expiry>:token" username has expired at
// unix time now. A malformed username is treated as expired (reject).
func credentialExpired(username string, now int64) bool {
	i := strings.IndexByte(username, ':')
	if i <= 0 {
		return true
	}
	exp, err := strconv.ParseInt(username[:i], 10, 64)
	if err != nil {
		return true
	}
	return exp < now
}

// countingGenerator wraps RelayAddressGeneratorPortRange, registering each
// allocated relay conn with the registry so its bytes are counted and later
// attributed (by relay address) to the authenticating username.
type countingGenerator struct {
	inner *turn.RelayAddressGeneratorPortRange
	reg   *allocRegistry
}

func (g *countingGenerator) Validate() error { return g.inner.Validate() }

func (g *countingGenerator) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
	pc, addr, err := g.inner.AllocatePacketConn(network, requestedPort)
	if err != nil {
		return pc, addr, err
	}
	return g.reg.wrap(pc, addr), addr, nil
}

func (g *countingGenerator) AllocateConn(network string, requestedPort int) (net.Conn, net.Addr, error) {
	return g.inner.AllocateConn(network, requestedPort) // TCP relay unused; not counted in SP1
}

func run(c config, st nodeState) error {
	publicIP := c.PublicIP
	if publicIP == "" {
		ip, err := detectPublicIP()
		if err != nil {
			return fmt.Errorf("detect public IP (pass -public-ip): %w", err)
		}
		publicIP = ip
	}

	udpAddr := fmt.Sprintf("0.0.0.0:%d", c.TURNPort)
	udpConn, err := net.ListenPacket("udp4", udpAddr)
	if err != nil {
		return fmt.Errorf("listen udp %s: %w", udpAddr, err)
	}

	reg := newAllocRegistry()
	gen := &countingGenerator{
		reg: reg,
		inner: &turn.RelayAddressGeneratorPortRange{
			RelayAddress: net.ParseIP(publicIP),
			Address:      "0.0.0.0",
			MinPort:      uint16(c.MinPort),
			MaxPort:      uint16(c.MaxPort),
		},
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: c.Realm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			if credentialExpired(username, time.Now().Unix()) {
				return nil, false
			}
			password := longTermPassword(st.TURNSecret, username)
			return turn.GenerateAuthKey(username, realm, password), true
		},
		EventHandler: turn.EventHandler{
			OnAllocationCreated: func(srcAddr, dstAddr net.Addr, protocol, username, realm string, relayAddr net.Addr, requestedPort int) {
				reg.created(srcAddr, relayAddr, username) // join counter (by relayAddr) to username; index by srcAddr
			},
			OnAllocationDeleted: func(srcAddr, dstAddr net.Addr, protocol, username, realm string) {
				reg.closeAlloc(srcAddr) // stop re-reporting; evicted after one final flush
			},
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpConn,
			RelayAddressGenerator: gen,
		}},
	})
	if err != nil {
		return fmt.Errorf("start turn server: %w", err)
	}
	defer server.Close()

	rp := newReporter(c.CentralURL, c.NodeToken)
	urls := []string{fmt.Sprintf("turn:%s:%d", publicIP, c.TURNPort)}

	nodeID, interval, err := rp.register(registerBody{
		NodeID: st.NodeID, TURNSecret: st.TURNSecret, URLs: urls,
		Region: c.Region, Version: version, Capabilities: []string{"relay"},
	})
	if err != nil {
		return fmt.Errorf("register with central: %w", err)
	}
	if nodeID != st.NodeID {
		st.NodeID = nodeID
		if serr := saveState(c.StateDir, st); serr != nil {
			log.Printf("relayium-node: persist nodeID: %v", serr)
		}
	}
	if interval <= 0 {
		interval = 30
	}
	log.Printf("relayium-node: registered as %s, relaying on %s, heartbeat %ds", nodeID, urls[0], interval)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("relayium-node: shutting down")
			return nil
		case <-ticker.C:
			sendHeartbeat(rp, nodeID, reg)
		}
	}
}

func sendHeartbeat(rp *reporter, nodeID string, reg *allocRegistry) {
	samples := reg.snapshot()
	usage := make([]usageItem, 0, len(samples))
	var total int64
	for _, s := range samples {
		if s.Username == "" {
			continue // not yet joined to a username; skip until OnAllocationCreated fires
		}
		usage = append(usage, usageItem{AllocID: s.AllocID, Username: s.Username, RelayedBytes: s.RelayedBytes})
		total += s.RelayedBytes
	}
	if err := rp.heartbeat(heartbeatBody{NodeID: nodeID, Status: "ok", Usage: usage, RelayedTotal: total, StoredBytes: 0}); err != nil {
		log.Printf("relayium-node: heartbeat failed (will retry): %v", err)
	}
}

// detectPublicIP asks a couple of public echo services, mirroring coturn-setup.sh.
func detectPublicIP() (string, error) {
	for _, u := range []string{"https://api.ipify.org", "https://ifconfig.me/ip"} {
		if ip := httpGetTrim(u); ip != "" && net.ParseIP(ip) != nil {
			return ip, nil
		}
	}
	return "", fmt.Errorf("could not auto-detect public IP")
}

func httpGetTrim(u string) string {
	hc := &http.Client{Timeout: 10 * time.Second}
	resp, err := hc.Get(u)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	return strings.TrimSpace(string(b))
}
