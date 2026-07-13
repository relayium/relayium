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
	"github.com/relayium/relayium/internal/storage"
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

// storageReport wraps storage.DiskUsage to report the node's blob-dir capacity
// for register/heartbeat.
func storageReport(dir string) (total, free int64, err error) {
	used, tot, err := storage.DiskUsage(dir) // used, total, err
	if err != nil {
		return 0, 0, err
	}
	return int64(tot), int64(tot - used), nil
}

// newTURNServer builds the node's pion TURN server: a counting relay generator
// wired to reg, plus an auth handler that rejects expired credentials and — the
// local cost cap (workstream B) — refuses new allocations once lim is over the
// monthly relay cap.
func newTURNServer(udpConn net.PacketConn, publicIP string, minPort, maxPort int, realm, turnSecret string, reg *allocRegistry, lim *limits) (*turn.Server, error) {
	gen := &countingGenerator{
		reg: reg,
		inner: &turn.RelayAddressGeneratorPortRange{
			RelayAddress: net.ParseIP(publicIP),
			Address:      "0.0.0.0",
			MinPort:      uint16(minPort),
			MaxPort:      uint16(maxPort),
		},
	}
	return turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			if credentialExpired(username, time.Now().Unix()) {
				return nil, false
			}
			// Refuse new allocations once the node is over its monthly relay cap,
			// so the cap holds locally between heartbeats instead of only when
			// central next withholds this node at ICE time.
			if lim.overTraffic() {
				return nil, false
			}
			password := longTermPassword(turnSecret, username)
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

	lim := &limits{}
	reg := newAllocRegistry(lim)
	server, err := newTURNServer(udpConn, publicIP, c.MinPort, c.MaxPort, c.Realm, st.TURNSecret, reg, lim)
	if err != nil {
		return fmt.Errorf("start turn server: %w", err)
	}
	defer server.Close()

	rp := newReporter(c.CentralURL, c.NodeToken)
	urls := []string{fmt.Sprintf("turn:%s:%d", publicIP, c.TURNPort)}

	var storageURL, storageSecret string
	var storTotal, storFree int64
	if c.StorageDir != "" {
		ds, derr := storage.NewDiskStore(c.StorageDir)
		if derr != nil {
			return fmt.Errorf("open storage dir %s: %w", c.StorageDir, derr)
		}
		storageSecret = st.StorageSecret
		diskUsed := func() int64 {
			if t, f, err := storageReport(c.StorageDir); err == nil {
				return t - f
			}
			return 0
		}
		// Built-in safety reserve: refuse writes once the volume is past 80% used
		// (free < 20%), independent of any admin cap, so relayium can never fill
		// the disk and wedge the host. Fails open on a stat error (don't block).
		diskFull := func() bool {
			t, f, err := storageReport(c.StorageDir)
			return err == nil && t > 0 && f*5 < t
		}
		blobSrv := &http.Server{Addr: fmt.Sprintf(":%d", c.StoragePort), Handler: newBlobHandler(ds, storageSecret, lim, diskUsed, diskFull)}
		go func() {
			if err := blobSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("relayium-node: blob server exited: %v", err)
			}
		}()
		defer blobSrv.Close()
		storageURL = fmt.Sprintf("http://%s:%d", publicIP, c.StoragePort)
		if t, f, uerr := storageReport(c.StorageDir); uerr == nil {
			storTotal, storFree = t, f
		}
		log.Printf("relayium-node: storage enabled, serving blobs on %s", storageURL)
	}

	capabilities := []string{"relay"}
	if storageURL != "" {
		capabilities = append(capabilities, "storage")
	}
	rr, err := rp.register(registerBody{
		NodeID: st.NodeID, TURNSecret: st.TURNSecret, URLs: urls,
		Region: c.Region, Version: version, Capabilities: capabilities,
		StorageURL: storageURL, StorageSecret: storageSecret,
		StorageTotal: storTotal, StorageFree: storFree,
	})
	if err != nil {
		return fmt.Errorf("register with central: %w", err)
	}
	nodeID, interval := rr.NodeID, rr.HeartbeatInterval
	lim.sync(rr.RelayedThisMonth, rr.TrafficLimitBytes, rr.DiskLimitBytes)
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
			sendHeartbeat(rp, nodeID, reg, c.StorageDir, lim)
		}
	}
}

func sendHeartbeat(rp *reporter, nodeID string, reg *allocRegistry, storageDir string, lim *limits) {
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
	var storedBytes, storTotal, storFree int64
	if storageDir != "" {
		if t, f, err := storageReport(storageDir); err == nil {
			storTotal, storFree = t, f
			storedBytes = t - f // blob-dir (filesystem) used bytes
		}
	}
	body := heartbeatBody{
		NodeID: nodeID, Status: "ok", Usage: usage, RelayedTotal: total,
		StoredBytes: storedBytes, StorageTotal: storTotal, StorageFree: storFree,
	}
	hr, err := rp.heartbeat(body)
	if err != nil {
		log.Printf("relayium-node: heartbeat failed (will retry): %v", err)
		return
	}
	if lim != nil {
		lim.sync(hr.RelayedThisMonth, hr.TrafficLimitBytes, hr.DiskLimitBytes)
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
