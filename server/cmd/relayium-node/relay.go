package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pion/turn/v4"
	"github.com/relayium/relayium/internal/cfdns"
	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/storage"
)

// urlHost extracts the host (no port) from an https base URL like
// https://node7.relayium.com, for the Cloudflare A-record name.
func urlHost(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// version is stamped by goreleaser via -ldflags; a dev build reports "dev".
var version = "dev"

// shutdownGrace bounds how long we let in-flight downloads and relay sessions
// finish on SIGTERM. systemd's TimeoutStopSec must exceed this.
const shutdownGrace = 60 * time.Second

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

// blobGates returns the two independent conditions under which a blob write is
// refused. They are grouped here because the pairing is the point: they answer
// different questions, and every past bug in this area came from conflating
// them.
//
// diskUsed is relayium's own footprint — the blob directory's real size, read
// from the cached gauge — and is what the admin disk cap is measured against.
// It must never become the whole volume's occupancy: that counts the OS and
// every unrelated program on the host as relayium storage, which inflates the
// admin dashboard and makes central's placement filter treat a nearly empty
// node as out of quota.
//
// diskFull is the opposite question: is the *host* about to run out of room?
// It stays on whole-volume statfs on purpose, because it is the absolute floor
// protecting the machine from everything running on it, not just relayium. It
// re-stats on every call rather than caching, since it is the last line of
// defense against wedging the host and must not act on a stale reading. It
// fails open on a stat error — a failed statfs must not block writes.
//
// Do not "unify" the two.
func blobGates(gauge *blobUsage, storageDir string) (diskUsed func() int64, diskFull func() bool) {
	return gauge.get, func() bool {
		// Refuse writes once the volume is past 80% used (free < 20%),
		// independent of any admin cap.
		t, f, err := storageReport(storageDir)
		return err == nil && t > 0 && f*5 < t
	}
}

// newTURNServer builds the node's pion TURN server: a counting relay generator
// wired to reg, plus an auth handler that rejects expired credentials and — the
// local cost cap (workstream B) — refuses new allocations once lim is over the
// monthly relay cap.
//
// This is also where BOTH of allocRegistry.closeAlloc's unstated invariants are
// actually true, not merely assumed: OnAllocationCreated below is wired
// unconditionally into EventHandler (pion calls it right after every successful
// AllocatePacketConn, no path skips it), and PacketConnConfigs carries exactly
// ONE entry, so every allocation this node ever serves comes from this single
// generator and srcAddr can't collide across two configs. Adding a second
// PacketConnConfig, or moving to a pion version that can abandon an allocation
// after AllocatePacketConn without firing OnAllocationDeleted, breaks
// closeAlloc's bookkeeping silently (see its doc comment) — change either
// deliberately, not as a side effect of something else here.
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

	var storageURL, storageSecret, storageFP string
	var storTotal, storFree int64
	var blobGauge *blobUsage
	// HTTP servers (blob + public download listeners) that must drain rather
	// than be cut off when we shut down. The TURN server above is NOT drained:
	// its `defer server.Close()` cuts live relay sessions immediately, and
	// nothing stops it accepting new allocations while the HTTP side drains.
	var httpSrvs []*http.Server
	// Backstop: close whatever's left in httpSrvs on every return path out of
	// run(). The ctx.Done() path below already calls gracefulShutdown, which
	// Shutdown()s these servers properly (draining in-flight requests) before
	// run() returns nil — a subsequent Close() here is then just a harmless
	// no-op on an already-closed server. This defer exists for the *other*
	// returns: if something after the servers start listening fails (e.g.
	// register with central), nothing else would ever close these listeners.
	defer func() {
		for _, s := range httpSrvs {
			if s != nil {
				s.Close()
			}
		}
	}()
	// Set only when a usable download certificate is installed; see downloadFace.
	var advertisedDownloadURL string
	if c.StorageDir != "" {
		ds, derr := storage.NewDiskStore(c.StorageDir)
		if derr != nil {
			return fmt.Errorf("open storage dir %s: %w", c.StorageDir, derr)
		}
		storageSecret = st.StorageSecret
		// Serve the blob endpoint over TLS with a persistent self-signed cert;
		// central pins its fingerprint, so the bearer secret and blob traffic are
		// encrypted + tamper-evident on the wire (they used to be plain HTTP). The
		// cert lives alongside state.json and its fingerprint is stable across
		// restarts, so a re-register reports the same pin.
		id, iderr := secure.LoadOrCreateIdentity(c.StateDir)
		if iderr != nil {
			return fmt.Errorf("load node TLS identity: %w", iderr)
		}
		storageFP = id.Fingerprint
		// Seed the gauge before anything can read it, so the first PUT and the
		// first heartbeat see a real number rather than 0.
		blobGauge = &blobUsage{}
		blobGauge.refresh(ds)
		go func() {
			tk := time.NewTicker(blobUsageRefresh)
			defer tk.Stop()
			for range tk.C {
				blobGauge.refresh(ds)
			}
		}()
		diskUsed, diskFull := blobGates(blobGauge, c.StorageDir)
		// One guard for the whole process: the /dl routes are served on BOTH the
		// blob listener and the public download listener, and a token spent on one
		// must not still be spendable on the other.
		dlGuard := newReplayGuard()
		blobSrv := &http.Server{
			Addr:    fmt.Sprintf(":%d", c.StoragePort),
			Handler: newBlobHandler(ds, storageSecret, lim, diskUsed, diskFull, dlGuard),
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{id.TLSCert},
				MinVersion:   tls.VersionTLS13,
			},
		}
		go func() {
			// Certs come from TLSConfig, so the cert/key path args are empty.
			if err := blobSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
				log.Printf("relayium-node: blob server exited: %v", err)
			}
		}()
		httpSrvs = append(httpSrvs, blobSrv)
		storageURL = fmt.Sprintf("https://%s:%d", publicIP, c.StoragePort)
		if t, f, uerr := storageReport(c.StorageDir); uerr == nil {
			storTotal, storFree = t, f
		}
		log.Printf("relayium-node: storage enabled, serving blobs on %s (TLS pinned %s)", storageURL, storageFP[:min(16, len(storageFP))])

		// Public direct-download face: a separate listener serving ONLY the
		// token-authed /dl routes (never the bearer /blob API), which Cloudflare
		// proxies to. CF terminates the browser-facing TLS and hides the node IP.
		// The origin certificate is a Cloudflare Origin CA certificate installed at
		// dl.crt — the zone runs Full (strict), which validates it. It is NOT the
		// node identity: CF cannot handshake with an Ed25519 origin certificate,
		// and the identity certificate is fingerprint-pinned by central besides.
		face, why := resolveDownloadFace(c.StateDir, c.DownloadURL, c.DownloadAddr, time.Now())
		if why != "" {
			log.Printf("relayium-node: direct download DISABLED, central will proxy for this node: %s", why)
		}
		if face != nil {
			// After serving a download, report the bytes actually sent so central
			// can refund any over-metering (async + best-effort — never block or
			// fail the download on a receipt hiccup).
			sendReceipt := func(blobKey, nonce string, served int64) {
				go func() {
					if err := rp.post("/api/nodes/download-receipt",
						receiptBody{BlobKey: blobKey, Nonce: nonce, ServedBytes: served}, nil); err != nil {
						log.Printf("relayium-node: download receipt for %s failed: %v", blobKey, err)
					}
				}()
			}
			dlSrv, dlLn, dlURL, berr := startDownloadFace(face,
				newDownloadHandler(ds, storageSecret, dlGuard, sendReceipt))
			if berr != nil {
				// The port is taken (or otherwise unbindable). Say nothing to
				// central: an advertised URL nobody is listening on is worse
				// than proxying, because nothing ever takes it back.
				log.Printf("relayium-node: direct download DISABLED, central will proxy for this node: %v", berr)
			} else {
				advertisedDownloadURL = dlURL
				go func() {
					// Certs come from TLSConfig, so the cert/key path args are empty.
					if err := dlSrv.ServeTLS(dlLn, "", ""); err != nil && err != http.ErrServerClosed {
						log.Printf("relayium-node: public download server exited: %v", err)
					}
				}()
				httpSrvs = append(httpSrvs, dlSrv)
				log.Printf("relayium-node: public direct-download listener on %s → %s", face.Addr, face.URL)

				// Auto-manage this node's Cloudflare A record (subdomain -> public IP,
				// proxied) so bringing up a node needs no manual dashboard step. Only
				// once the listener is actually bound — pointing the record at a host
				// that is not serving is the same failure in DNS form.
				if c.CFToken != "" && c.CFZoneID != "" {
					cf := &cfdns.Client{Token: c.CFToken, ZoneID: c.CFZoneID}
					if err := cf.UpsertA(face.Host, publicIP, true); err != nil {
						log.Printf("relayium-node: cloudflare A-record upsert for %s failed: %v (set it manually)", face.Host, err)
					} else {
						log.Printf("relayium-node: cloudflare A-record %s -> %s (proxied) ensured", face.Host, publicIP)
					}
				}
			}
		}
	}

	capabilities := []string{"relay"}
	if storageURL != "" {
		capabilities = append(capabilities, "storage")
	}
	// Only advertise a direct-download URL when this node actually serves storage;
	// it's meaningless without a blob store to serve from. advertisedDownloadURL is
	// set only inside the storage branch, and only after startDownloadFace has
	// BOUND the listener, so it is non-empty exactly when the listener is up.
	downloadURL := advertisedDownloadURL
	rr, err := rp.register(registerBody{
		NodeID: st.NodeID, TURNSecret: st.TURNSecret, URLs: urls,
		Region: c.Region, Version: version, Capabilities: capabilities,
		StorageURL: storageURL, StorageSecret: storageSecret, StorageFP: storageFP,
		StorageTotal: storTotal, StorageFree: storFree,
		DownloadURL: downloadURL,
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
			log.Printf("relayium-node: draining in-flight requests (up to %s)", shutdownGrace)
			if err := gracefulShutdown(httpSrvs, shutdownGrace); err != nil {
				log.Printf("relayium-node: shutdown deadline hit: %v", err)
			}
			log.Printf("relayium-node: shutting down")
			return nil
		case <-ticker.C:
			sendHeartbeat(rp, nodeID, reg, c.StorageDir, c.StateDir, blobGauge, lim)
		}
	}
}

func sendHeartbeat(rp *reporter, nodeID string, reg *allocRegistry, storageDir, stateDir string, blobGauge *blobUsage, lim *limits) {
	// Read the live count BEFORE snapshot(), which evicts closed allocations:
	// either order gives the same answer (activeAllocs ignores closed entries),
	// but taking it first keeps the two reads from being confused for one.
	active := reg.activeAllocs()
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
		}
		// relayium's own footprint, NOT total-free. total-free is the whole
		// volume's occupancy and would count every unrelated byte on the host.
		if blobGauge != nil {
			storedBytes = blobGauge.get()
		}
	}
	body := heartbeatBody{
		NodeID: nodeID, Status: "ok", Usage: usage, RelayedTotal: total,
		StoredBytes: storedBytes, StorageTotal: storTotal, StorageFree: storFree,
		ActiveTransfers: active,
	}
	hr, err := rp.heartbeat(body)
	if err != nil {
		log.Printf("relayium-node: heartbeat failed (will retry): %v", err)
		return
	}
	if lim != nil {
		lim.sync(hr.RelayedThisMonth, hr.TrafficLimitBytes, hr.DiskLimitBytes)
	}
	// Record the success so the updater can tell a working new version from one
	// that starts but can't reach central.
	if err := markHealthy(stateDir, version); err != nil {
		log.Printf("relayium-node: record heartbeat health: %v", err)
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

// gracefulShutdown stops the given HTTP servers, letting in-flight requests
// finish within d. An update restarts the node, so without this every rollout
// would cut live blob uploads and downloads on every node it touches. Returns
// the deadline error if a request outlives d — the caller exits regardless,
// since the updater is waiting on this process.
//
// Scope: HTTP only. TURN relay sessions are still cut abruptly when run()
// returns and closes the TURN server, and no new-allocation cutoff exists, so a
// rollout still interrupts in-progress WebRTC relaying. Clients re-ICE, which
// is why draining TURN has not been worth its complexity so far.
func gracefulShutdown(srvs []*http.Server, d time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var firstErr error
	for _, s := range srvs {
		if s == nil {
			continue
		}
		if err := s.Shutdown(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
