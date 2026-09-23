package linkwire

// The values below are the shared contract's numbers, pinned against the
// fixture so a later layer inherits them rather than re-typing them. NOTHING in
// this package enforces any of them: the timers, the hello cadence, the leave
// attempt budget, the text-session limits, the flow-control window, the
// pre-attachment capture cap and the held-offer cap are all behaviour of the
// connection and lane state machines (W-N18 Phase 2a3). Matching these
// constants is not evidence that any of that behaviour exists.
const (
	// Establishment and recovery deadlines, milliseconds (link §5.2, §8.1).
	NoProgressMs        = 30_000
	SetupHardCapMs      = 90_000
	KeyRevealMs         = 30_000
	HandshakeDeadlineMs = 90_000
	LinkAuthMs          = 30_000
	LinkRequestMs       = 30_000
	LinkRequestRetryMs  = 3_000
	RecoveryWindowMs    = 90_000
	RecoveryRetryMs     = 1_500

	// Roster-hello cadence (link §1.3).
	CapsAnnounceAttempts = 3
	CapsRetryIntervalMs  = 1_500
	CapsSettleSeconds    = 5

	// Bounded resources (link §10).
	CaptureMaxBytes      = 256 * 1024
	HeldSignalMax        = 64
	MaxCandidateProgress = 6
	LeaveMaxAttempts     = 8

	// Flow control (relayium-realtime-flow-v1.md, link §6.5).
	FlowWindowBytes      = 8 << 20
	FlowAckIntervalBytes = 512 * 1024

	// Text session bounds (link §7.4).
	TextSessionMaxMessages = 500
	TextSessionMaxBytes    = 4 << 20
	TextRateBurst          = 20
	TextRatePerSecond      = 5
	TextSendBufferMax      = 1 << 20
	TextIdleMs             = 600_000
	TextHistoryMax         = 200
)
