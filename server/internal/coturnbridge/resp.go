package coturnbridge

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// A minimal RESP2 subscriber. go-redis is deliberately not used here: its
// PubSub reconnects and resubscribes transparently, which would hide exactly
// the gaps the bridge must see (pub/sub is at-most-once). This client fails
// loudly on any error and the bridge records a gap before reconnecting.

const (
	maxBulk  = 64 << 10 // largest bulk string accepted
	maxArray = 8        // largest array accepted (pmessage has 4)
	maxLine  = 1024
)

// ErrProtocol is a malformed or oversized RESP frame.
var ErrProtocol = errors.New("coturnbridge: redis protocol error")

// Frame is one decoded RESP2 value: string (simple/bulk), int64, nil, error, or []any.
type Frame = any

type respErr string

func (e respErr) Error() string { return "redis: " + string(e) }

// RedisConn is one subscriber connection.
type RedisConn struct {
	c net.Conn
	r *bufio.Reader
}

// DialRedis connects and authenticates (password may be empty; user is the
// ACL user, optional).
func DialRedis(addr, user, password string, timeout time.Duration) (*RedisConn, error) {
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	rc := &RedisConn{c: c, r: bufio.NewReaderSize(c, 64<<10)}
	if password != "" {
		args := []string{"AUTH", password}
		if user != "" {
			args = []string{"AUTH", user, password}
		}
		c.SetDeadline(time.Now().Add(timeout))
		if err := rc.Send(args...); err != nil {
			c.Close()
			return nil, err
		}
		f, err := rc.Read()
		if err != nil {
			c.Close()
			return nil, err
		}
		if s, ok := f.(string); !ok || s != "OK" {
			c.Close()
			return nil, fmt.Errorf("redis AUTH refused: %v", f)
		}
		c.SetDeadline(time.Time{})
	}
	return rc, nil
}

// Close closes the connection.
func (rc *RedisConn) Close() error { return rc.c.Close() }

// SetReadDeadline bounds the next reads.
func (rc *RedisConn) SetReadDeadline(t time.Time) error { return rc.c.SetReadDeadline(t) }

// Send writes one command.
func (rc *RedisConn) Send(args ...string) error {
	b := []byte("*" + strconv.Itoa(len(args)) + "\r\n")
	for _, a := range args {
		b = append(b, '$')
		b = strconv.AppendInt(b, int64(len(a)), 10)
		b = append(b, "\r\n"...)
		b = append(b, a...)
		b = append(b, "\r\n"...)
	}
	rc.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := rc.c.Write(b)
	return err
}

func (rc *RedisConn) line() (string, error) {
	b, err := rc.r.ReadSlice('\n')
	if err != nil {
		if errors.Is(err, bufio.ErrBufferFull) {
			return "", ErrProtocol
		}
		return "", err
	}
	if len(b) < 2 || b[len(b)-2] != '\r' || len(b) > maxLine {
		return "", ErrProtocol
	}
	return string(b[:len(b)-2]), nil
}

// Read decodes one frame.
func (rc *RedisConn) Read() (Frame, error) { return rc.read(0) }

func (rc *RedisConn) read(depth int) (Frame, error) {
	l, err := rc.line()
	if err != nil {
		return nil, err
	}
	if l == "" {
		return nil, ErrProtocol
	}
	switch l[0] {
	case '+':
		return l[1:], nil
	case '-':
		return respErr(l[1:]), nil
	case ':':
		n, err := strconv.ParseInt(l[1:], 10, 64)
		if err != nil {
			return nil, ErrProtocol
		}
		return n, nil
	case '$':
		n, err := strconv.Atoi(l[1:])
		if err != nil || n < -1 || n > maxBulk {
			return nil, ErrProtocol
		}
		if n == -1 {
			return nil, nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(rc.r, buf); err != nil {
			return nil, err
		}
		if buf[n] != '\r' || buf[n+1] != '\n' {
			return nil, ErrProtocol
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(l[1:])
		if err != nil || n < -1 || n > maxArray || depth > 1 {
			return nil, ErrProtocol
		}
		if n == -1 {
			return nil, nil
		}
		out := make([]any, n)
		for i := range out {
			if out[i], err = rc.read(depth + 1); err != nil {
				return nil, err
			}
		}
		return out, nil
	}
	return nil, ErrProtocol
}

// PubSubFrame classifies a frame read in subscribed mode.
type PubSubFrame struct {
	Kind    string // "pmessage", "pong", "psubscribe", "other"
	Channel string
	Payload string // pmessage payload, or the PING token for "pong"
}

// Classify decodes a subscribed-mode frame. RESP2 answers PING in subscribed
// mode with ["pong", token].
func Classify(f Frame) (PubSubFrame, error) {
	if e, ok := f.(respErr); ok {
		return PubSubFrame{}, e
	}
	arr, ok := f.([]any)
	if !ok || len(arr) == 0 {
		return PubSubFrame{}, ErrProtocol
	}
	kind, _ := arr[0].(string)
	switch kind {
	case "pmessage":
		if len(arr) != 4 {
			return PubSubFrame{}, ErrProtocol
		}
		ch, ok1 := arr[2].(string)
		pl, ok2 := arr[3].(string)
		if !ok1 || !ok2 {
			return PubSubFrame{}, ErrProtocol
		}
		return PubSubFrame{Kind: "pmessage", Channel: ch, Payload: pl}, nil
	case "pong":
		if len(arr) != 2 {
			return PubSubFrame{}, ErrProtocol
		}
		tok, _ := arr[1].(string)
		return PubSubFrame{Kind: "pong", Payload: tok}, nil
	case "psubscribe":
		return PubSubFrame{Kind: "psubscribe"}, nil
	}
	return PubSubFrame{Kind: "other"}, nil
}
