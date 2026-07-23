package signal

import "time"

// Per-connection abuse limits for the signaling channel (C2). A single
// rendezvous exchanges only a few KB of SDP/ICE, so these caps are generous for
// real use yet cut off anyone trying to use /ws as a free bulk relay. All values
// are tunable.
const (
	// maxFrameBytes is the single-frame read limit set on the websocket. Real
	// SDP/ICE is a few KB (the data channel carries no audio/video codecs).
	maxFrameBytes = 32 << 10 // 32 KiB
	// maxSignalBytes is the cumulative TypeSignal payload budget per connection.
	// One real rendezvous is well under 100 KB; 1 MiB gives ~10x headroom while a
	// bulk relay (MB/GB) trips it quickly.
	maxSignalBytes = 1 << 20 // 1 MiB
	// signalBurst / signalRefillPerSec form a token bucket bounding message rate
	// (CPU-flood protection): burst of 50, refilled at 10 tokens/sec.
	signalBurst        = 50
	signalRefillPerSec = 10.0
)

// connLimiter is per-connection local state (not shared/global). It counts only
// TypeSignal payload bytes and TypeSignal message rate; TypeJoin is never passed
// to admit. now is injected so the bucket refill is deterministically testable.
type connLimiter struct {
	bytesUsed  int64
	tokens     float64
	lastRefill time.Time
	now        func() time.Time
}

func newConnLimiter(now func() time.Time) *connLimiter {
	return &connLimiter{tokens: signalBurst, lastRefill: now(), now: now}
}

// admit accounts for one TypeSignal frame of frameLen raw bytes. It returns
// (false, reason) when the connection has exceeded its message rate or its
// cumulative byte budget; the caller then closes the socket with that reason.
func (l *connLimiter) admit(frameLen int) (bool, string) {
	t := l.now()
	if elapsed := t.Sub(l.lastRefill).Seconds(); elapsed > 0 {
		l.tokens += elapsed * signalRefillPerSec
		if l.tokens > signalBurst {
			l.tokens = signalBurst
		}
		l.lastRefill = t
	}
	if l.tokens < 1 {
		return false, "signal rate exceeded"
	}
	l.tokens--
	l.bytesUsed += int64(frameLen)
	if l.bytesUsed > maxSignalBytes {
		return false, "signal budget exceeded"
	}
	return true, ""
}

// maxMalformedFrames 是一条连接上允许**连续**出现多少个解不开的帧。
//
// 正常客户端每一帧都是自己 JSON 编码的，解不开只会来自 bug 或恶意；给一点余量是
// 为了容忍升级窗口里新增字段之类的擦碰，但连着几十帧都解不开就只有一种解释。
const maxMalformedFrames = 20
