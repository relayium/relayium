package coturnbridge

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// coturn's telnet CLI (turn_admin_server.c). The bridge only ever sends the
// password, "psd <file>" (dump every live session to a file — unlike "ps" it
// is not capped by cli-max-output-sessions) and, for a drain, "cs <id>".

const (
	cliPrompt      = "> "
	cliPasswordAsk = "Enter password: "
	maxCLIReply    = 64 << 10
)

// ErrCLI is a CLI conversation that did not go as the protocol requires.
var ErrCLI = errors.New("coturnbridge: coturn CLI error")

// CLI is one authenticated CLI session.
type CLI struct {
	c       net.Conn
	timeout time.Duration
}

// DialCLI connects and authenticates.
func DialCLI(addr, password string, timeout time.Duration) (*CLI, error) {
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	cli := &CLI{c: c, timeout: timeout}
	greeting, err := cli.readUntil(func(b []byte) bool {
		return bytes.Contains(b, []byte(cliPasswordAsk)) || bytes.HasSuffix(b, []byte(cliPrompt))
	})
	if err != nil {
		c.Close()
		return nil, err
	}
	if bytes.Contains(greeting, []byte(cliPasswordAsk)) {
		if password == "" {
			c.Close()
			return nil, fmt.Errorf("%w: CLI asks for a password and none is configured", ErrCLI)
		}
		reply, err := cli.command(password)
		if err != nil {
			c.Close()
			return nil, err
		}
		if bytes.Contains(reply, []byte(cliPasswordAsk)) {
			c.Close()
			return nil, fmt.Errorf("%w: password refused", ErrCLI)
		}
	}
	return cli, nil
}

// Close ends the session.
func (c *CLI) Close() error { return c.c.Close() }

// readUntil reads (bounded, telnet IAC stripped) until done(buf).
func (c *CLI) readUntil(done func([]byte) bool) ([]byte, error) {
	c.c.SetReadDeadline(time.Now().Add(c.timeout))
	var buf []byte
	tmp := make([]byte, 4096)
	for !done(buf) {
		n, err := c.c.Read(tmp)
		buf = append(buf, stripIAC(tmp[:n])...)
		if len(buf) > maxCLIReply {
			return nil, fmt.Errorf("%w: reply larger than %d bytes", ErrCLI, maxCLIReply)
		}
		if err != nil {
			if done(buf) {
				break
			}
			if errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("%w: connection closed", ErrCLI)
			}
			return nil, err
		}
	}
	return buf, nil
}

// stripIAC removes telnet IAC sequences (coturn's libtelnet may negotiate).
func stripIAC(b []byte) []byte {
	out := b[:0:0]
	for i := 0; i < len(b); i++ {
		if b[i] == 0xff && i+1 < len(b) {
			switch b[i+1] {
			case 0xfb, 0xfc, 0xfd, 0xfe: // WILL WONT DO DONT <opt>
				i += 2
				continue
			case 0xff:
				out = append(out, 0xff)
				i++
				continue
			default:
				i++
				continue
			}
		}
		out = append(out, b[i])
	}
	return out
}

// command sends one line and returns everything up to the next prompt.
func (c *CLI) command(line string) ([]byte, error) {
	if strings.ContainsAny(line, "\r\n") {
		return nil, fmt.Errorf("%w: command contains a line break", ErrCLI)
	}
	c.c.SetWriteDeadline(time.Now().Add(c.timeout))
	if _, err := c.c.Write([]byte(line + "\r\n")); err != nil {
		return nil, err
	}
	return c.readUntil(func(b []byte) bool {
		return bytes.HasSuffix(b, []byte(cliPrompt)) || bytes.Contains(b, []byte(cliPasswordAsk))
	})
}

// DumpSessions runs "psd <path>" and returns the parsed, complete listing.
// path must be in a directory only coturn and the bridge can write: coturn
// opens it with fopen("w"). The file is removed first, so a listing can never
// be a stale earlier dump, and read with a size bound.
func (c *CLI) DumpSessions(path string, maxBytes int64) ([]PSDSession, error) {
	if strings.ContainsAny(path, " \t\r\n") || !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("%w: psd path must be absolute without spaces", ErrCLI)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	reply, err := c.command("psd " + path)
	if err != nil {
		return nil, err
	}
	if bytes.Contains(reply, []byte("Cannot open file")) || bytes.Contains(reply, []byte("You have to provide")) {
		return nil, fmt.Errorf("%w: psd failed: %q", ErrCLI, strings.TrimSpace(string(reply)))
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: psd output is not a regular file", ErrCLI)
	}
	if fi.Size() > maxBytes {
		return nil, fmt.Errorf("%w: psd output %d bytes exceeds %d", ErrCLI, fi.Size(), maxBytes)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxBytes {
		return nil, fmt.Errorf("%w: psd output grew past %d bytes", ErrCLI, maxBytes)
	}
	return ParsePSD(b)
}

// CancelSession runs "cs <id>": coturn shuts the session down through
// shutdown_client_connection, which force-flushes and publishes the final
// total_traffic.
func (c *CLI) CancelSession(id string) error {
	if !wire.ValidSessionID(id) {
		return fmt.Errorf("%w: bad session id %q", ErrCLI, id)
	}
	_, err := c.command("cs " + id)
	return err
}

var (
	rePSDHeader = regexp.MustCompile(`^    ([0-9]{1,10})\) id=([0-9]{18}), user <([^<>\n]*)>:$`)
	rePSDUsage  = regexp.MustCompile(`^      usage: rp=([0-9]{1,20}), rb=([0-9]{1,20}), sp=([0-9]{1,20}), sb=([0-9]{1,20})$`)
	rePSDTotal  = regexp.MustCompile(`^  Total sessions(?: for [^:]*)?: ([0-9]{1,10})$`)
	rePSDStart  = regexp.MustCompile(`^      started ([0-9]{1,10}) secs ago$`)
)

// ErrPSDIncomplete is a listing that does not prove its own completeness.
var ErrPSDIncomplete = errors.New("coturnbridge: psd listing incomplete or malformed")

// ParsePSD parses a psd dump. It accepts only a complete listing: sessions
// numbered 1..N in order, each with exactly one usage line, and a final
// "Total sessions: N" that matches. Anything else is ErrPSDIncomplete and the
// listing is not used at all (no truncated snapshot is evidence).
//
// A session whose username is not Relayium-shaped is counted for
// completeness but not returned (it cannot be attributed).
func ParsePSD(b []byte) ([]PSDSession, error) {
	// print_sessions ends with the total line and then one empty line.
	if !bytes.HasSuffix(b, []byte("\n\n")) {
		return nil, fmt.Errorf("%w: does not end with the closing blank line", ErrPSDIncomplete)
	}
	lines := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
	var (
		out      []PSDSession
		counted  int
		cur      *PSDSession
		curUsage bool
		curValid bool
		total    = -1
	)
	closeSession := func() error {
		if cur == nil {
			return nil
		}
		if !curUsage {
			return fmt.Errorf("%w: session %s has no usage line", ErrPSDIncomplete, cur.SessionID)
		}
		if curValid {
			out = append(out, *cur)
		}
		cur = nil
		return nil
	}
	for _, l := range lines {
		if total >= 0 {
			if l != "" {
				return nil, fmt.Errorf("%w: text after the total line", ErrPSDIncomplete)
			}
			continue
		}
		switch {
		case l == "":
			continue
		case rePSDHeader.MatchString(l):
			if err := closeSession(); err != nil {
				return nil, err
			}
			m := rePSDHeader.FindStringSubmatch(l)
			idx, _ := strconv.Atoi(m[1])
			if idx != counted+1 {
				return nil, fmt.Errorf("%w: session %d out of order", ErrPSDIncomplete, idx)
			}
			counted++
			cur, curUsage, curValid = &PSDSession{SessionID: m[2], Username: m[3], StartedAgo: -1}, false, wire.ValidUsername(m[3])
		case rePSDUsage.MatchString(l):
			if cur == nil || curUsage {
				return nil, fmt.Errorf("%w: stray usage line", ErrPSDIncomplete)
			}
			m := rePSDUsage.FindStringSubmatch(l)
			rb, e1 := strconv.ParseUint(m[2], 10, 64)
			sb, e2 := strconv.ParseUint(m[4], 10, 64)
			if e1 != nil || e2 != nil || rb > wire.MaxCumulative || sb > wire.MaxCumulative {
				return nil, fmt.Errorf("%w: usage out of range", ErrPSDIncomplete)
			}
			cur.Bytes, curUsage = rb+sb, true
		case rePSDTotal.MatchString(l):
			if err := closeSession(); err != nil {
				return nil, err
			}
			n, _ := strconv.Atoi(rePSDTotal.FindStringSubmatch(l)[1])
			if n != counted {
				return nil, fmt.Errorf("%w: total %d but %d sessions listed", ErrPSDIncomplete, n, counted)
			}
			total = n
		case cur != nil && rePSDStart.MatchString(l):
			n, _ := strconv.ParseInt(rePSDStart.FindStringSubmatch(l)[1], 10, 64)
			cur.StartedAgo = n
		case cur != nil && strings.HasPrefix(l, "      "):
			// Other per-session detail (realm, times, addresses, rate, peers).
		default:
			return nil, fmt.Errorf("%w: unexpected line %q", ErrPSDIncomplete, truncate(l, 80))
		}
	}
	if total < 0 {
		return nil, fmt.Errorf("%w: no total line", ErrPSDIncomplete)
	}
	return out, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
