package linkrtc

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/pion/datachannel"
	"github.com/pion/webrtc/v4"

	"github.com/relayium/relayium/internal/linkwire"
)

// Conn is the transport for exactly one link. Build it with NewConn, drive
// signalling through Offer (initiator), SetRemote, AddICE and RestartICE, and
// read what happened from the ordered Events passed to the handler.
//
// Handler contract: events arrive one at a time, in order, on a goroutine
// owned by the Conn; the handler may call any Conn method. Once Close has
// been called no further event is dispatched (a handler call already running
// may finish).
//
// Frame delivery contract (link §2.2–2.3): from the moment a lane is
// collected its inbound frames are captured (≤ 256 KiB combined across both
// lanes, fail-closed). Attach installs the lane owners, replays the capture in
// arrival order, and only then delivers live frames. Write refuses until
// Attach, so no consent byte can be sent before its lane's handler exists.
type Conn struct {
	role     Role
	pc       *webrtc.PeerConnection
	localMax uint32
	q        *eventQueue

	// sigMu serialises the signalling-facing calls (Offer, SetRemote, AddICE,
	// RestartICE) so remote-description state and held candidates are
	// consistent. It is never held while c.mu is wanted by a Pion callback
	// that a Pion call waits for.
	sigMu sync.Mutex

	mu   sync.Mutex
	done chan struct{}

	closed bool
	lost   bool

	// establishment
	opened       bool
	offered      bool
	restarted    bool
	progressSeen map[string]bool
	remoteICE    int
	noProgress   *time.Timer
	hardCap      *time.Timer
	// noProgressDur is the re-arm interval (link §5.2 30 s; shorter in tests).
	noProgressDur time.Duration

	// candidates
	descPending     bool
	heldLocal       []webrtc.ICECandidateInit
	remoteDescribed bool
	heldRemote      []webrtc.ICECandidateInit

	// ICE connection health
	disconnected bool

	// lanes
	dcs      [2]*webrtc.DataChannel
	rws      [2]datachannel.ReadWriteCloser
	lowWater [2]chan struct{}
	budget   Budget
	attached bool
	handlers [2]func([]byte)
	laneMu   [2]sync.Mutex // held while a lane's frames are delivered

	captured      []capturedFrame
	capturedBytes int
	overflow      bool
}

type capturedFrame struct {
	lane Lane
	data []byte
}

// NewConn creates the PeerConnection for one link. The initiator creates both
// lanes now, in tuple order; the responder collects them from the peer. The
// setup timers (30 s no-progress, 90 s hard cap) start now.
func NewConn(api *webrtc.API, cfg webrtc.Configuration, role Role, handler func(Event)) (*Conn, error) {
	return newConn(api, cfg, role, handler, 0, noProgressTimeout, setupHardCap)
}

func newConn(api *webrtc.API, cfg webrtc.Configuration, role Role, handler func(Event),
	localMax uint32, noProg, hard time.Duration,
) (*Conn, error) {
	if handler == nil {
		return nil, errors.New("linkrtc: nil event handler")
	}
	if localMax == 0 {
		localMax = LocalMaxMessageSize
	}
	pc, err := api.NewPeerConnection(cfg)
	if err != nil {
		return nil, err
	}
	c := &Conn{
		role:          role,
		pc:            pc,
		localMax:      localMax,
		done:          make(chan struct{}),
		progressSeen:  map[string]bool{},
		noProgressDur: noProg,
	}
	for i := range c.lowWater {
		c.lowWater[i] = make(chan struct{}, 1)
	}
	c.q = newEventQueue(c.done)
	go c.q.run(handler)

	pc.OnICECandidate(c.onLocalCandidate)
	pc.OnConnectionStateChange(c.onConnectionState)
	pc.OnDataChannel(func(dc *webrtc.DataChannel) { c.collect(dc, false) })
	if t := pc.SCTP(); t != nil && t.Transport() != nil && t.Transport().ICETransport() != nil {
		t.Transport().ICETransport().OnSelectedCandidatePairChange(func(p *webrtc.ICECandidatePair) {
			c.emit(Event{Kind: EventPathChanged, Path: Classify(p)})
		})
	}

	c.mu.Lock()
	c.noProgress = time.AfterFunc(noProg, func() { c.expire(EventSetupNoProgress) })
	c.hardCap = time.AfterFunc(hard, func() { c.expire(EventSetupHardCap) })
	c.mu.Unlock()

	if role == Initiator {
		for _, label := range linkwire.ChannelLabels {
			dc, err := pc.CreateDataChannel(label, nil) // ordered, reliable, DCEP
			if err != nil {
				c.Close()
				return nil, err
			}
			c.collect(dc, true)
		}
	}
	return c, nil
}

// Role is this side's fixed role.
func (c *Conn) Role() Role { return c.role }

// emit queues an event unless the Conn is closed.
func (c *Conn) emit(e Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.emitLocked(e)
}

func (c *Conn) emitLocked(e Event) {
	if c.closed {
		return
	}
	c.q.push(e)
}

// ---- setup timers and progress (link §5.2) ----

func (c *Conn) expire(kind EventKind) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.opened || c.lost {
		return
	}
	c.stopTimersLocked()
	c.emitLocked(Event{Kind: kind})
}

func (c *Conn) stopTimersLocked() {
	if c.noProgress != nil {
		c.noProgress.Stop()
	}
	if c.hardCap != nil {
		c.hardCap.Stop()
	}
}

// progressLocked re-arms the no-progress timer for a first-time key. Nothing
// re-arms after the lanes opened, after close, or twice for one key.
func (c *Conn) progressLocked(key string) {
	if c.closed || c.opened || c.lost || c.progressSeen[key] {
		return
	}
	c.progressSeen[key] = true
	if c.noProgress != nil && c.noProgress.Stop() {
		// Only a still-pending timer is re-armed; one that already fired has
		// ended the setup.
		c.noProgress.Reset(c.noProgressDur)
	}
	c.emitLocked(Event{Kind: EventProgress, Key: key})
}

// ---- signalling ----

// Offer creates and signals the initial offer. Initiator only, once.
func (c *Conn) Offer() error {
	c.sigMu.Lock()
	defer c.sigMu.Unlock()
	if c.role != Initiator {
		return ErrWrongRole
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	if c.offered {
		c.mu.Unlock()
		return errors.New("linkrtc: offer already made; use RestartICE")
	}
	c.offered = true
	c.mu.Unlock()
	return c.sendLocal(func() (webrtc.SessionDescription, error) { return c.pc.CreateOffer(nil) })
}

// RestartICE signals an ICE-restart offer. Initiator only, and only once per
// link, so a genuinely dead path fails fast instead of looping offers.
// Remote candidates are held again until the restart answer is applied: they
// belong to the peer's new ufrag.
func (c *Conn) RestartICE() error {
	c.sigMu.Lock()
	defer c.sigMu.Unlock()
	if c.role != Initiator {
		return ErrWrongRole
	}
	c.mu.Lock()
	switch {
	case c.closed:
		c.mu.Unlock()
		return ErrClosed
	case !c.offered:
		c.mu.Unlock()
		return errors.New("linkrtc: no offer to restart")
	case c.restarted:
		c.mu.Unlock()
		return ErrRestartUsed
	}
	c.restarted = true
	c.mu.Unlock()
	if err := c.sendLocal(func() (webrtc.SessionDescription, error) {
		return c.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	}); err != nil {
		return err
	}
	c.mu.Lock()
	c.remoteDescribed = false
	c.mu.Unlock()
	return nil
}

// sendLocal creates a description, applies it, and emits it before any local
// candidate gathered for it.
func (c *Conn) sendLocal(create func() (webrtc.SessionDescription, error)) error {
	sd, err := create()
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.descPending = true
	c.mu.Unlock()
	if err := c.pc.SetLocalDescription(sd); err != nil {
		c.mu.Lock()
		c.descPending = false
		c.heldLocal = nil
		c.mu.Unlock()
		return err
	}
	local := c.pc.LocalDescription()
	if local == nil {
		local = &sd
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.descPending = false
	d := *local
	c.emitLocked(Event{Kind: EventLocalDescription, Description: &d})
	for i := range c.heldLocal {
		cand := c.heldLocal[i]
		c.emitLocked(Event{Kind: EventLocalCandidate, Candidate: &cand})
	}
	c.heldLocal = nil
	return nil
}

func (c *Conn) onLocalCandidate(cand *webrtc.ICECandidate) {
	if cand == nil { // end of gathering; link/1 signals no end-of-candidates
		return
	}
	init := cand.ToJSON()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.descPending {
		c.heldLocal = append(c.heldLocal, init)
		return
	}
	c.emitLocked(Event{Kind: EventLocalCandidate, Candidate: &init})
}

// SetRemote applies the peer's description. A responder answers an offer
// (the initial one or an ICE restart) and signals the answer; an initiator
// accepts only answers. Candidates held while no remote description existed
// are added afterwards, in arrival order.
func (c *Conn) SetRemote(sd webrtc.SessionDescription) error {
	c.sigMu.Lock()
	defer c.sigMu.Unlock()
	switch {
	case sd.Type == webrtc.SDPTypeOffer && c.role == Responder:
	case sd.Type == webrtc.SDPTypeAnswer && c.role == Initiator:
	default:
		return ErrSDPType
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if err := c.pc.SetRemoteDescription(sd); err != nil {
		return err
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	c.remoteDescribed = true
	c.progressLocked("sdp:" + sd.Type.String())
	c.mu.Unlock()

	var answerErr error
	if sd.Type == webrtc.SDPTypeOffer {
		answerErr = c.sendLocal(func() (webrtc.SessionDescription, error) { return c.pc.CreateAnswer(nil) })
	}
	// Flush regardless: the remote description is in place, so the holding
	// window is over and held candidates get no second chance.
	c.flushRemoteLocked()
	return answerErr
}

// AddICE adds a remote candidate, or holds it (bounded) while no remote
// description is applied. A candidate the agent rejects is not fatal and does
// not take its siblings with it. The first six accepted candidates re-arm the
// no-progress timer (a count, not a de-duplication: link §5.2).
func (c *Conn) AddICE(cand webrtc.ICECandidateInit) error {
	c.sigMu.Lock()
	defer c.sigMu.Unlock()
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	if !c.remoteDescribed {
		if len(c.heldRemote) >= MaxHeldCandidates {
			c.heldRemote = nil
			c.loseLocked(ErrHeldCandidates)
			c.mu.Unlock()
			return ErrHeldCandidates
		}
		c.heldRemote = append(c.heldRemote, cand)
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()
	return c.addRemote(cand)
}

// flushRemoteLocked: caller holds sigMu (not mu).
func (c *Conn) flushRemoteLocked() {
	c.mu.Lock()
	held := c.heldRemote
	c.heldRemote = nil
	c.mu.Unlock()
	for _, cand := range held {
		_ = c.addRemote(cand)
	}
}

func (c *Conn) addRemote(cand webrtc.ICECandidateInit) error {
	if err := c.pc.AddICECandidate(cand); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.remoteICE < linkwire.MaxCandidateProgress {
		c.progressLocked(fmt.Sprintf("ice:%d", c.remoteICE))
		c.remoteICE++
	}
	return nil
}

// ---- connection state ----

func (c *Conn) onConnectionState(s webrtc.PeerConnectionState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.progressLocked("state:" + s.String())
	switch s {
	case webrtc.PeerConnectionStateDisconnected:
		if !c.disconnected {
			c.disconnected = true
			c.emitLocked(Event{Kind: EventDisconnected})
		}
	case webrtc.PeerConnectionStateConnected:
		if c.disconnected {
			c.disconnected = false
			c.emitLocked(Event{Kind: EventReconnected})
		}
	case webrtc.PeerConnectionStateFailed:
		c.loseLocked(errors.New("linkrtc: peer connection failed"))
	case webrtc.PeerConnectionStateClosed:
		c.loseLocked(errors.New("linkrtc: peer connection closed"))
	}
}

// loseLocked emits TransportLost once.
func (c *Conn) loseLocked(err error) {
	if c.closed || c.lost {
		return
	}
	c.lost = true
	c.stopTimersLocked()
	c.emitLocked(Event{Kind: EventTransportLost, Err: err})
}

func (c *Conn) lose(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loseLocked(err)
}

// ---- lanes ----

// collect takes a channel by exact label (link §2.1). Anything outside the
// tuple, a duplicate, a lane the responder opened towards the initiator, or a
// lane that is not ordered+reliable is closed on its own and reported as
// LaneBad; the required pair may still arrive normally.
func (c *Conn) collect(dc *webrtc.DataChannel, own bool) {
	label := dc.Label()
	lane, ok := laneOf(label)
	var reason string
	switch {
	case !ok:
		reason = "label outside the lane tuple"
	case !own && c.role == Initiator:
		reason = "the responder opened a lane"
	case !dc.Ordered() || dc.MaxRetransmits() != nil || dc.MaxPacketLifeTime() != nil:
		reason = "lane is not ordered and reliable"
	}
	c.mu.Lock()
	if reason == "" && c.dcs[lane] != nil {
		reason = "duplicate lane"
	}
	if reason != "" {
		c.emitLocked(Event{Kind: EventLaneBad, Label: label, Err: fmt.Errorf("%w: %s", ErrLaneProtocol, reason)})
		c.mu.Unlock()
		go func() { _ = dc.Close() }()
		return
	}
	c.dcs[lane] = dc
	c.mu.Unlock()

	dc.SetBufferedAmountLowThreshold(SendLowWaterBytes)
	low := c.lowWater[lane]
	dc.OnBufferedAmountLow(func() {
		select {
		case low <- struct{}{}:
		default:
		}
	})
	dc.OnOpen(func() {
		rw, err := dc.Detach()
		if err != nil {
			c.lose(fmt.Errorf("linkrtc: detach %s: %w", label, err))
			return
		}
		c.laneOpen(lane, rw)
	})
}

func (c *Conn) laneOpen(lane Lane, rw datachannel.ReadWriteCloser) {
	// Read the transport's outbound limit before taking c.mu: never hold our
	// lock across a call that takes Pion's locks. The association exists once
	// any lane is open, and the value is fixed for the association's life.
	var transportMax uint32
	if t := c.pc.SCTP(); t != nil {
		transportMax = t.GetCapabilities().MaxMessageSize
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = rw.Close()
		return
	}
	c.rws[lane] = rw
	go c.readLane(lane, rw)
	if c.rws[LaneFile] == nil || c.rws[LaneText] == nil || c.opened {
		c.mu.Unlock()
		return
	}
	b, err := NewBudget(transportMax, c.localMax)
	if err != nil {
		c.loseLocked(err)
		c.mu.Unlock()
		return
	}
	c.budget = b
	c.opened = true
	c.stopTimersLocked()
	c.emitLocked(Event{Kind: EventLanesOpen, Budget: b})
	c.mu.Unlock()
}

// readLane is the one reader of a lane. A read error, a message larger than
// this side advertised, or a text (string) message ends the transport: link/1
// lanes are binary, and a dropped frame would strand the peer's sequence.
func (c *Conn) readLane(lane Lane, rw datachannel.ReadWriteCloser) {
	buf := make([]byte, c.localMax)
	for {
		n, isString, err := rw.ReadDataChannel(buf)
		if err != nil {
			switch {
			case errors.Is(err, io.ErrShortBuffer):
				err = fmt.Errorf("%w on %s", ErrOversizedMessage, lane)
			default:
				err = fmt.Errorf("linkrtc: %s read: %w", lane, err)
			}
			c.lose(err)
			return
		}
		if isString {
			c.lose(fmt.Errorf("%w: text message on %s", ErrLaneProtocol, lane))
			return
		}
		frame := make([]byte, n)
		copy(frame, buf[:n])
		if !c.deliver(lane, frame) {
			return
		}
	}
}

// deliver captures before Attach and calls the lane owner after. It returns
// false when the reader should stop.
func (c *Conn) deliver(lane Lane, frame []byte) bool {
	c.laneMu[lane].Lock()
	defer c.laneMu[lane].Unlock()
	c.mu.Lock()
	if c.closed || c.overflow {
		c.mu.Unlock()
		return false
	}
	if !c.attached {
		if c.capturedBytes+len(frame) > linkwire.CaptureMaxBytes {
			c.overflow = true
			c.captured, c.capturedBytes = nil, 0
			c.emitLocked(Event{Kind: EventCaptureOverflow})
			c.mu.Unlock()
			return false
		}
		c.capturedBytes += len(frame)
		c.captured = append(c.captured, capturedFrame{lane: lane, data: frame})
		c.mu.Unlock()
		return true
	}
	h := c.handlers[lane]
	c.mu.Unlock()
	h(frame)
	return true
}

// Attach installs the lane owners and replays the capture into them in
// arrival order, before any live frame. Once only; refused after a capture
// overflow. The handlers are called from the lane reader goroutines, one
// frame at a time per lane; a handler that blocks back-pressures its lane.
func (c *Conn) Attach(file, text func(frame []byte)) error {
	if file == nil || text == nil {
		return errors.New("linkrtc: nil lane handler")
	}
	c.laneMu[LaneFile].Lock()
	defer c.laneMu[LaneFile].Unlock()
	c.laneMu[LaneText].Lock()
	defer c.laneMu[LaneText].Unlock()
	c.mu.Lock()
	switch {
	case c.closed:
		c.mu.Unlock()
		return ErrClosed
	case !c.opened:
		c.mu.Unlock()
		return ErrNotOpen
	case c.overflow:
		c.mu.Unlock()
		return ErrCaptureOverflow
	case c.attached:
		c.mu.Unlock()
		return ErrAttached
	}
	c.attached = true
	c.handlers = [2]func([]byte){file, text}
	replay := c.captured
	c.captured, c.capturedBytes = nil, 0
	c.mu.Unlock()
	for _, f := range replay {
		if f.lane == LaneFile {
			file(f.data)
		} else {
			text(f.data)
		}
	}
	return nil
}

// Budget is the frame budget; valid once EventLanesOpen was emitted.
func (c *Conn) Budget() (Budget, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.opened {
		return Budget{}, ErrNotOpen
	}
	return c.budget, nil
}

// Write sends one binary frame on a lane. It refuses before Attach and any
// frame over the link's MaxFrameBytes, and it waits (bounded by Close) while
// the lane's SCTP buffer is above SendLowWaterBytes.
func (c *Conn) Write(lane Lane, frame []byte) error {
	if lane != LaneFile && lane != LaneText {
		return ErrLaneProtocol
	}
	c.mu.Lock()
	switch {
	case c.closed:
		c.mu.Unlock()
		return ErrClosed
	case !c.attached:
		c.mu.Unlock()
		return ErrNotAttached
	case int64(len(frame)) > c.budget.MaxFrameBytes:
		c.mu.Unlock()
		return fmt.Errorf("%w: %d > %d", ErrFrameTooLarge, len(frame), c.budget.MaxFrameBytes)
	}
	rw, dc, low := c.rws[lane], c.dcs[lane], c.lowWater[lane]
	c.mu.Unlock()
	for dc.BufferedAmount() > SendLowWaterBytes {
		select {
		case <-low:
		case <-c.done:
			return ErrClosed
		}
	}
	if _, err := rw.WriteDataChannel(frame, false); err != nil {
		return fmt.Errorf("linkrtc: %s write: %w", lane, err)
	}
	return nil
}

// SelectedPath classifies the pair the ICE agent has selected right now.
func (c *Conn) SelectedPath() (PathInfo, error) {
	t := c.pc.SCTP()
	if t == nil || t.Transport() == nil || t.Transport().ICETransport() == nil {
		return PathInfo{Path: PathUnknown}, errors.New("linkrtc: no ICE transport")
	}
	p, err := t.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil {
		return PathInfo{Path: PathUnknown}, err
	}
	return Classify(p), nil
}

// Close ends the link: timers stop, no further event is delivered, lanes and
// the PeerConnection close. Idempotent.
func (c *Conn) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.stopTimersLocked()
	close(c.done)
	c.captured, c.capturedBytes = nil, 0
	c.heldLocal, c.heldRemote = nil, nil
	rws := c.rws
	c.mu.Unlock()
	for _, rw := range rws {
		if rw != nil {
			_ = rw.Close()
		}
	}
	_ = c.pc.Close()
}

// ---- ordered event delivery ----

type eventQueue struct {
	mu    sync.Mutex
	items []Event
	wake  chan struct{}
	done  <-chan struct{}
}

func newEventQueue(done <-chan struct{}) *eventQueue {
	return &eventQueue{wake: make(chan struct{}, 1), done: done}
}

func (q *eventQueue) push(e Event) {
	q.mu.Lock()
	q.items = append(q.items, e)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *eventQueue) run(handler func(Event)) {
	for {
		select {
		case <-q.wake:
		case <-q.done:
			return
		}
		for {
			select {
			case <-q.done:
				return
			default:
			}
			q.mu.Lock()
			if len(q.items) == 0 {
				q.mu.Unlock()
				break
			}
			e := q.items[0]
			q.items[0] = Event{}
			q.items = q.items[1:]
			q.mu.Unlock()
			handler(e)
		}
	}
}
