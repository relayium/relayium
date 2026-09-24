package linkrtc

// The transport half of relay-renew/1 for the CLI (A11): what the renewal
// engine (internal/linksession, Renewal) needs from the live PeerConnection,
// and the one reviewed path by which a relayed link's deadline may move LATER.
//
// ## Pion restarts ICE break-before-make
//
// CreateOffer(ICERestart) and SetRemoteDescription(restart offer) both run
// pion/ice Agent.Restart at once, which clears the selected pair and closes
// every local candidate — the previous TURN allocation included — before the
// new generation has a single pair (probe: artifacts/goal34-20260923/
// a11-metering/probe-pion-restart). So RestartOffer and ApplyRemote(offer)
// RETIRE THE LIVE PATH. The engine calls them only once both peers are ready
// on the same validated grant, and ends the link if the attempt then fails.
//
// ## Generation labelling without a ufrag extension
//
// Pion's candidates carry no `ufrag` extension and ToJSON sets no
// usernameFragment, and its selected-pair stats name no generation. Because
// a restart deletes every candidate of the previous generation, a candidate
// that is present in the agent's CURRENT candidate set belongs to the agent's
// CURRENT ufrag, read from the agent itself. A candidate that is not (a late
// delivery from before a restart) cannot be attributed and is labelled "",
// which the engine drops.

import (
	"errors"
	"strconv"
	"strings"

	"github.com/pion/webrtc/v4"
)

// Renewer is the renewal surface of one Conn. All methods are called from the
// caller's single loop.
type Renewer struct {
	c        *Conn
	baseline string
	hasBase  bool
}

// NewRenewer binds to c, pinning the epoch-0 baseline from the remote
// description actually applied now (relay-renew-v1 §5.1).
func NewRenewer(c *Conn) *Renewer {
	r := &Renewer{c: c}
	if rd := c.pc.RemoteDescription(); rd != nil && rd.SDP != "" {
		r.baseline, r.hasBase = rd.SDP, true
	}
	return r
}

// ErrRenewConfig: SetConfiguration was handed something that is not a
// webrtc.Configuration.
var ErrRenewConfig = errors.New("linkrtc: renewal configuration is not a webrtc.Configuration")

func (r *Renewer) closed() bool {
	r.c.mu.Lock()
	defer r.c.mu.Unlock()
	return r.c.closed
}

// SetConfiguration installs the granted ICE servers. The transport policy is
// the one the link was BUILT with, whatever cfg says (§5.3).
func (r *Renewer) SetConfiguration(cfg any) error {
	wc, ok := cfg.(webrtc.Configuration)
	if !ok {
		return ErrRenewConfig
	}
	if r.closed() {
		return ErrClosed
	}
	cur := r.c.pc.GetConfiguration()
	return r.c.pc.SetConfiguration(webrtc.Configuration{
		ICEServers:         wc.ICEServers,
		ICETransportPolicy: cur.ICETransportPolicy,
	})
}

// BaselineSDP is the epoch-0 remote description.
func (r *Renewer) BaselineSDP() (string, bool) { return r.baseline, r.hasBase }

// RestartOffer creates and applies an ICE-restart offer. On Pion the current
// path is retired the moment the offer is created.
func (r *Renewer) RestartOffer() (string, error) {
	r.c.sigMu.Lock()
	defer r.c.sigMu.Unlock()
	if r.closed() {
		return "", ErrClosed
	}
	sd, err := r.c.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		return "", err
	}
	if err := r.c.pc.SetLocalDescription(sd); err != nil {
		return "", err
	}
	if ld := r.c.pc.LocalDescription(); ld != nil {
		return ld.SDP, nil
	}
	return sd.SDP, nil
}

// ApplyRemote applies a (pinned) remote description and returns the remote
// description as the agent now holds it.
func (r *Renewer) ApplyRemote(sdpType, sdp string) (string, error) {
	var typ webrtc.SDPType
	switch sdpType {
	case "offer":
		typ = webrtc.SDPTypeOffer
	case "answer":
		typ = webrtc.SDPTypeAnswer
	default:
		return "", ErrSDPType
	}
	r.c.sigMu.Lock()
	defer r.c.sigMu.Unlock()
	if r.closed() {
		return "", ErrClosed
	}
	if err := r.c.pc.SetRemoteDescription(webrtc.SessionDescription{Type: typ, SDP: sdp}); err != nil {
		return "", err
	}
	rd := r.c.pc.RemoteDescription() // remoteDescription, never currentRemoteDescription
	if rd == nil {
		return "", errors.New("linkrtc: no remote description after applying one")
	}
	return rd.SDP, nil
}

// Answer creates and applies the answer to an applied restart offer.
func (r *Renewer) Answer() (string, error) {
	r.c.sigMu.Lock()
	defer r.c.sigMu.Unlock()
	if r.closed() {
		return "", ErrClosed
	}
	sd, err := r.c.pc.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	if err := r.c.pc.SetLocalDescription(sd); err != nil {
		return "", err
	}
	if ld := r.c.pc.LocalDescription(); ld != nil {
		return ld.SDP, nil
	}
	return sd.SDP, nil
}

func sdpUfrag(sdp string) string {
	for _, line := range strings.Split(strings.ReplaceAll(sdp, "\r", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "a=ice-ufrag:") {
			return strings.TrimSpace(line[len("a=ice-ufrag:"):])
		}
	}
	return ""
}

func (r *Renewer) iceTransport() *webrtc.ICETransport {
	s := r.c.pc.SCTP()
	if s == nil || s.Transport() == nil {
		return nil
	}
	return s.Transport().ICETransport()
}

// LocalUfrag is the ICE agent's CURRENT local ufrag (falling back to the
// applied local description).
func (r *Renewer) LocalUfrag() string {
	if t := r.iceTransport(); t != nil {
		if p, err := t.GetLocalParameters(); err == nil && p.UsernameFragment != "" {
			return p.UsernameFragment
		}
	}
	if ld := r.c.pc.LocalDescription(); ld != nil {
		return sdpUfrag(ld.SDP)
	}
	return ""
}

// RemoteUfrag is the ufrag of the remote description now applied.
func (r *Renewer) RemoteUfrag() string {
	if rd := r.c.pc.RemoteDescription(); rd != nil {
		return sdpUfrag(rd.SDP)
	}
	return ""
}

// AddCandidate adds one remote candidate of the migration's generation.
func (r *Renewer) AddCandidate(candidate string, sdpMid *string, sdpMLineIndex *uint32, ufrag string) error {
	if r.closed() {
		return ErrClosed
	}
	init := webrtc.ICECandidateInit{Candidate: candidate, SDPMid: sdpMid}
	if sdpMLineIndex != nil {
		if *sdpMLineIndex > 0xffff {
			return errors.New("linkrtc: sdpMLineIndex out of range")
		}
		v := uint16(*sdpMLineIndex)
		init.SDPMLineIndex = &v
	}
	if ufrag != "" {
		u := ufrag
		init.UsernameFragment = &u
	}
	return r.c.pc.AddICECandidate(init)
}

func candidateKey(protocol, address string, port int, typ string) string {
	return strings.ToLower(protocol) + "|" + address + "|" + strconv.Itoa(port) + "|" + strings.ToLower(typ)
}

// candidateStringKey reads protocol|address|port|type from a candidate line.
func candidateStringKey(candidate string) string {
	f := strings.Fields(strings.TrimPrefix(strings.TrimSpace(candidate), "a="))
	if len(f) < 8 || !strings.HasPrefix(f[0], "candidate:") {
		return ""
	}
	typ := -1
	for i, v := range f {
		if v == "typ" {
			typ = i
			break
		}
	}
	if typ < 0 || typ+1 >= len(f) {
		return ""
	}
	port, err := strconv.Atoi(f[5])
	if err != nil {
		return ""
	}
	return candidateKey(f[2], f[4], port, f[typ+1])
}

// currentCandidates is the agent's CURRENT candidate set, local or remote.
func (r *Renewer) currentCandidates(local bool) map[string]bool {
	want := webrtc.StatsTypeRemoteCandidate
	if local {
		want = webrtc.StatsTypeLocalCandidate
	}
	out := map[string]bool{}
	for _, st := range r.c.pc.GetStats() {
		cs, ok := st.(webrtc.ICECandidateStats)
		if !ok || cs.Type != want {
			continue
		}
		out[candidateKey(cs.Protocol, cs.IP, int(cs.Port), cs.CandidateType.String())] = true
	}
	return out
}

// LocalGeneration labels a locally gathered candidate with the ICE generation
// it belongs to: the agent's current ufrag when the candidate is one of the
// agent's current candidates, "" otherwise (cannot tell: never sent).
func (r *Renewer) LocalGeneration(candidate string) string {
	k := candidateStringKey(candidate)
	if k == "" || !r.currentCandidates(true)[k] {
		return ""
	}
	return r.LocalUfrag()
}

// SelectedGeneration names the generation of the selected pair's two ends:
// the current local ufrag when the selected local candidate is one of the
// agent's current candidates, likewise the remote. "" = cannot tell.
func (r *Renewer) SelectedGeneration() (local, remote string) {
	t := r.iceTransport()
	if t == nil || r.closed() {
		return "", ""
	}
	p, err := t.GetSelectedCandidatePair()
	if err != nil || p == nil || p.Local == nil || p.Remote == nil {
		return "", ""
	}
	// A peer-reflexive local candidate's generation cannot be named (§6.3).
	if p.Local.Typ == webrtc.ICECandidateTypePrflx {
		return "", ""
	}
	lk := candidateKey(p.Local.Protocol.String(), p.Local.Address, int(p.Local.Port), p.Local.Typ.String())
	if r.currentCandidates(true)[lk] {
		local = r.LocalUfrag()
	}
	rk := candidateKey(p.Remote.Protocol.String(), p.Remote.Address, int(p.Remote.Port), p.Remote.Typ.String())
	if r.currentCandidates(false)[rk] {
		remote = r.RemoteUfrag()
	}
	return local, remote
}

// ---- the deadline

// Renew moves the latched bound to d after a PROVEN migration (relay-renew-v1
// §6.5 commit). It is the only way a bound ever moves later, and it refuses a
// bound that is not strictly later than the one in force, or a latch that was
// never set (nothing was bounded: nothing to renew).
func (l *DeadlineLatch) Renew(d RelayDeadline) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.set || !d.DeadlineAt.After(l.d.DeadlineAt) || !d.ExpiresAt.After(l.d.ExpiresAt) {
		return false
	}
	l.d = d
	return true
}
