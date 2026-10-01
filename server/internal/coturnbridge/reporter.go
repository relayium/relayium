package coturnbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// Reporter POSTs snapshots to central's ingest.
type Reporter struct {
	BaseURL string // e.g. https://relayium.com
	Token   string
	RelayID string
	Client  *http.Client
}

// ErrBadAck is a response that does not acknowledge exactly the request: the
// whole batch is retained and retried.
var ErrBadAck = errors.New("coturnbridge: bad ACK response")

// Send delivers snaps and returns one validated ACK per snapshot, in order.
// Any HTTP failure or malformed response returns an error and no ACKs.
func (r *Reporter) Send(ctx context.Context, snaps []wire.Snapshot) ([]wire.Ack, error) {
	body, err := json.Marshal(wire.Request{RelayID: r.RelayID, Snapshots: snaps})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(r.BaseURL, "/")+wire.Path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.Token)
	resp, err := r.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, wire.MaxRequestBytes+1))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("central answered HTTP %d: %s", resp.StatusCode, truncate(strings.TrimSpace(string(raw)), 200))
	}
	if len(raw) > wire.MaxRequestBytes {
		return nil, fmt.Errorf("%w: response too large", ErrBadAck)
	}
	var out wire.Response
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := wire.DecodeStrict(dec, &out); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadAck, err)
	}
	if len(out.Acks) != len(snaps) {
		return nil, fmt.Errorf("%w: %d acks for %d snapshots", ErrBadAck, len(out.Acks), len(snaps))
	}
	for i, a := range out.Acks {
		s := &snaps[i]
		if a.Key != s.Key() || a.Seq != s.Seq || a.Hash != s.Hash {
			return nil, fmt.Errorf("%w: ack %d names %s seq %d, sent %s seq %d", ErrBadAck, i, a.Key, a.Seq, s.Key(), s.Seq)
		}
		switch a.Status {
		case wire.AckAccepted, wire.AckStale, wire.AckConflict, wire.AckRejected, wire.AckRetry, wire.AckGone:
		default:
			return nil, fmt.Errorf("%w: status %q", ErrBadAck, a.Status)
		}
		if a.Accepted > wire.MaxCumulative {
			return nil, fmt.Errorf("%w: accepted out of range", ErrBadAck)
		}
	}
	return out.Acks, nil
}
