package linkrtc

import (
	"net/netip"

	"github.com/pion/webrtc/v4"
)

// Path is the path the ICE agent actually SELECTED (A09-DESIGN §7). It is
// computed only from the selected candidate pair — never from the ICE servers
// a link was configured with or from issued relay credentials, so a link that
// merely had TURN available is never reported as relayed, and nothing is
// reported as direct before a pair is selected.
type Path string

const (
	// PathRelay: either end of the selected pair is a relay (TURN) candidate.
	PathRelay Path = "relay"
	// PathLAN: both ends are host or peer-reflexive candidates on private,
	// loopback or link-local addresses. A prflx candidate is only the peer's
	// own address learned from a connectivity check before its host
	// candidate was signalled, so on a local-scope address it is the same
	// on-link path.
	PathLAN Path = "lan"
	// PathDirect: any other selected pair (srflx, or a public host/prflx).
	PathDirect Path = "direct"
	// PathUnknown: no pair is selected (yet).
	PathUnknown Path = "unknown"
)

// PathInfo is the classification plus the candidate facts it came from.
type PathInfo struct {
	Path       Path
	LocalType  string // host, srflx, prflx, relay
	RemoteType string
	Protocol   string // udp or tcp (local candidate)
}

// Classify maps a selected candidate pair to a Path. A nil pair or a pair
// with a missing end is PathUnknown.
func Classify(p *webrtc.ICECandidatePair) PathInfo {
	if p == nil || p.Local == nil || p.Remote == nil {
		return PathInfo{Path: PathUnknown}
	}
	info := PathInfo{
		LocalType:  p.Local.Typ.String(),
		RemoteType: p.Remote.Typ.String(),
		Protocol:   p.Local.Protocol.String(),
	}
	switch {
	case p.Local.Typ == webrtc.ICECandidateTypeRelay || p.Remote.Typ == webrtc.ICECandidateTypeRelay:
		info.Path = PathRelay
	case onLink(p.Local.Typ) && onLink(p.Remote.Typ) &&
		localScope(p.Local.Address) && localScope(p.Remote.Address):
		info.Path = PathLAN
	default:
		info.Path = PathDirect
	}
	return info
}

// onLink: a candidate type that names the endpoint's own address.
func onLink(t webrtc.ICECandidateType) bool {
	return t == webrtc.ICECandidateTypeHost || t == webrtc.ICECandidateTypePrflx
}

// localScope: RFC 1918 / ULA, loopback, or link-local. An unparseable address
// (e.g. an mDNS .local name) is not assumed local.
func localScope(s string) bool {
	a, err := netip.ParseAddr(s)
	if err != nil {
		return false
	}
	a = a.Unmap()
	return a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast()
}
