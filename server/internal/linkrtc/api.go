// Package linkrtc is the `link/1` transport for one link: a data-only Pion
// WebRTC PeerConnection carrying exactly the two lanes of
// docs/protocol/relayium-link-v1.md §2 ("relayium", "relayium-text").
//
// It is the "transport" collaborator of the link state machine (A08). It owns
// the PeerConnection, the lane tuple, pre-attachment capture, the per-frame
// budget, the setup timers and the one-shot ICE restart, and it reports what
// happened as ordered Events. It never looks at frame contents and never
// decides consent, relay policy, or how a path is worded to the user.
//
// # Scope (A09a)
//
// No command imports this package yet. ICE server selection and relay policy
// (the `/api/ice` client, `chooseRtcConfig`, `ice-direct/1`), the relay
// credential deadline and path wording belong to later slices; the caller
// passes a ready webrtc.Configuration.
//
// # Data-only
//
// NewAPI registers no codecs and no interceptors, detaches every DataChannel
// (one reader goroutine per lane, real read backpressure), disables mDNS, and
// advertises a bounded SCTP max-message-size. See budget.go for why the
// negotiated value is never trusted as a frame size on its own.
package linkrtc

import (
	"errors"
	"net"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"

	"github.com/relayium/relayium/internal/linkwire"
)

// Lane indexes the exact tuple linkwire.ChannelLabels.
type Lane int

const (
	// LaneFile is "relayium", the primary lane.
	LaneFile Lane = 0
	// LaneText is "relayium-text".
	LaneText Lane = 1
)

func (l Lane) String() string {
	if l == LaneFile || l == LaneText {
		return linkwire.ChannelLabels[l]
	}
	return "lane(?)"
}

func laneOf(label string) (Lane, bool) {
	for i, l := range linkwire.ChannelLabels {
		if label == l {
			return Lane(i), true
		}
	}
	return 0, false
}

const (
	// LocalMaxMessageSize is the a=max-message-size this side advertises
	// (the Chrome value). It is >= linkwire.ChunkSize + linkwire.ChunkOverhead
	// (196 629) so one whole chunk fits one message, and it bounds what a
	// conforming peer may send us, so lane reassembly is bounded too.
	LocalMaxMessageSize = 262144

	// SendLowWaterBytes is the SCTP buffered-amount mark below which a lane
	// write proceeds (link §2.1). A write above it waits for the buffer to
	// drain, so a writer that outruns the path blocks instead of queueing
	// without bound.
	SendLowWaterBytes = 8 << 20

	// MaxHeldCandidates bounds remote candidates held while no remote
	// description is applied (the Web's MAX_HELD_CANDIDATES). Overflow fails
	// the transport; it never truncates.
	MaxHeldCandidates = linkwire.HeldSignalMax
)

// Role is fixed for a link's life (link §3).
type Role int

const (
	Initiator Role = iota
	Responder
)

func (r Role) String() string {
	if r == Initiator {
		return "initiator"
	}
	return "responder"
}

// Options configures NewAPI. The zero value is the production configuration.
type Options struct {
	// AdvertiseIPs replaces this host's candidate addresses with the given
	// public addresses (the CLI's --advertise, for a 1:1-NAT server). Empty
	// leaves candidates as gathered.
	AdvertiseIPs []string

	// Unexported test hooks. Production code cannot set them.
	includeLoopback bool
	maxMessageSize  uint32
	ipFilter        func(net.IP) bool
	portRange       [2]uint16
}

// NewAPI builds the data-only Pion API (A09-DESIGN §2.1).
func NewAPI(o Options) (*webrtc.API, error) {
	se := webrtc.SettingEngine{}
	se.DetachDataChannels()
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetIncludeLoopbackCandidate(o.includeLoopback)
	se.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6,
		webrtc.NetworkTypeTCP4, webrtc.NetworkTypeTCP6,
	})
	mms := uint32(LocalMaxMessageSize)
	if o.maxMessageSize != 0 {
		mms = o.maxMessageSize
	}
	se.SetSCTPMaxMessageSize(mms)
	if len(o.AdvertiseIPs) > 0 {
		for _, ip := range o.AdvertiseIPs {
			if net.ParseIP(ip) == nil {
				return nil, errors.New("linkrtc: advertise address is not an IP")
			}
		}
		// The legacy NAT1To1 host behaviour: host candidates are replaced by
		// the advertised public address.
		if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        append([]string(nil), o.AdvertiseIPs...),
			AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode:            webrtc.ICEAddressRewriteReplace,
		}); err != nil {
			return nil, err
		}
	}
	if o.ipFilter != nil {
		se.SetIPFilter(o.ipFilter)
	}
	if o.portRange[0] != 0 {
		if err := se.SetEphemeralUDPPortRange(o.portRange[0], o.portRange[1]); err != nil {
			return nil, err
		}
	}
	// No MediaEngine codecs and no interceptor registry: data-only.
	return webrtc.NewAPI(webrtc.WithSettingEngine(se)), nil
}

// Setup timing (link §5.2), overridable per Conn for tests only.
var (
	noProgressTimeout = time.Duration(linkwire.NoProgressMs) * time.Millisecond
	setupHardCap      = time.Duration(linkwire.SetupHardCapMs) * time.Millisecond
)

// Errors.
var (
	ErrClosed           = errors.New("linkrtc: link closed")
	ErrWrongRole        = errors.New("linkrtc: not allowed in this role")
	ErrRestartUsed      = errors.New("linkrtc: the one ICE restart was already used")
	ErrNotOpen          = errors.New("linkrtc: lanes are not open")
	ErrNotAttached      = errors.New("linkrtc: lanes are not attached")
	ErrAttached         = errors.New("linkrtc: lanes are already attached")
	ErrCaptureOverflow  = errors.New("linkrtc: pre-attachment capture exceeded 256 KiB")
	ErrFrameTooLarge    = errors.New("linkrtc: frame exceeds this link's frame budget")
	ErrHeldCandidates   = errors.New("linkrtc: too many candidates held before the remote description")
	ErrLaneProtocol     = errors.New("linkrtc: lane protocol violation")
	ErrSDPType          = errors.New("linkrtc: unexpected description type for this role")
	ErrOversizedMessage = errors.New("linkrtc: peer sent a message larger than the advertised maximum")
)

// EventKind names what the transport observed (A09-DESIGN §1).
type EventKind int

const (
	// EventLocalDescription carries an SDP offer or answer to signal. Local
	// candidates for it are always emitted after it.
	EventLocalDescription EventKind = iota + 1
	// EventLocalCandidate carries a trickled local candidate to signal.
	EventLocalCandidate
	// EventProgress reports a first-time progress key (sdp:<type>,
	// state:<s>, ice:<n>) that re-armed the no-progress timer.
	EventProgress
	// EventLanesOpen: both lanes are open, detached and in capture; Budget is
	// valid from here on.
	EventLanesOpen
	// EventLaneBad: a channel outside the tuple, a duplicate, or one that is
	// not ordered+reliable was closed on its own. The link is unaffected.
	EventLaneBad
	// EventCaptureOverflow: pre-attachment bytes exceeded 256 KiB combined.
	// Fail-closed: Attach now refuses.
	EventCaptureOverflow
	// EventSetupNoProgress / EventSetupHardCap: setup timers fired before the
	// lanes opened.
	EventSetupNoProgress
	EventSetupHardCap
	// EventDisconnected / EventReconnected: ICE connection state went to
	// disconnected / came back to connected.
	EventDisconnected
	EventReconnected
	// EventTransportLost: the PeerConnection failed or closed, or a lane
	// failed (read error, oversized or non-binary message). Emitted once.
	EventTransportLost
	// EventPathChanged: the ICE agent selected a (new) candidate pair.
	EventPathChanged
)

var eventNames = map[EventKind]string{
	EventLocalDescription: "LocalDescription", EventLocalCandidate: "LocalCandidate",
	EventProgress: "Progress", EventLanesOpen: "LanesOpen", EventLaneBad: "LaneBad",
	EventCaptureOverflow: "CaptureOverflow", EventSetupNoProgress: "SetupNoProgress",
	EventSetupHardCap: "SetupHardCap", EventDisconnected: "Disconnected",
	EventReconnected: "Reconnected", EventTransportLost: "TransportLost",
	EventPathChanged: "PathChanged",
}

func (k EventKind) String() string {
	if s, ok := eventNames[k]; ok {
		return s
	}
	return "Event(?)"
}

// Event is one ordered observation. Only the fields for its Kind are set.
type Event struct {
	Kind        EventKind
	Description *webrtc.SessionDescription // LocalDescription
	Candidate   *webrtc.ICECandidateInit   // LocalCandidate
	Key         string                     // Progress
	Label       string                     // LaneBad
	Budget      Budget                     // LanesOpen
	Path        PathInfo                   // PathChanged
	Err         error                      // TransportLost (cause), LaneBad (reason)
}
