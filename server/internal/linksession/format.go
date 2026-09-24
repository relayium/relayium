package linksession

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"

	"github.com/relayium/relayium/internal/linkcrypto"
	"github.com/relayium/relayium/internal/linkwire"
)

// Key-bearing types and their formatters.
//
// Go's fmt does not call a nested value's Format through an unexported field
// (it cannot Interface() it), so a struct holding redacting codecs in private
// fields STILL prints their bytes under %v/%+v/%#v. Product rule (A08-DESIGN
// §11.4): every type in this package that holds a key, a codec, a commitment
// nonce or the SAS — directly or through another such type — implements the
// full set Format, String, GoString, MarshalJSON and LogValue, on the VALUE
// receiver so that both T and *T carry it. TestKeyBearingTypesRedact walks the
// package's struct types by reflection to enforce this.

// Link is the key-bearing object of one link/1: the handshake identity, the
// peer's recorded commitment, the derived session keys, the six codecs (four
// in this build: no preupload/1) and the SAS. It is owned by the Session and
// never leaves it; nothing here is exported.
type Link struct {
	peer       string
	role       int
	epoch      Epoch
	self       *linkcrypto.KeyPair
	nonce      []byte // commitment nonce: secret until revealed
	commit     []byte
	peerCommit []byte
	keys       *linkcrypto.SessionKeys
	fileTx     *linkwire.FileSender
	fileRx     *linkwire.FileReceiver
	textTx     *linkwire.TextSender
	textRx     *linkwire.TextReceiver
	resumeAuth []byte
	sas        string
	destroyed  bool
}

// pendingKeys is a derivation computed while CLASSIFYING a reveal. It is
// installed only if the table row says ADerive, and wiped otherwise.
type pendingKeys struct {
	keys       *linkcrypto.SessionKeys
	fileTx     *linkwire.FileSender
	fileRx     *linkwire.FileReceiver
	textTx     *linkwire.TextSender
	textRx     *linkwire.TextReceiver
	resumeAuth []byte
	sas        string
}

func newLink(rnd io.Reader, peer string, role int, ep Epoch) (*Link, error) {
	secret := make([]byte, linkcrypto.SecretKeySize)
	defer clear(secret)
	if _, err := io.ReadFull(rnd, secret); err != nil {
		return nil, err
	}
	kp, err := linkcrypto.KeyPairFromSecret(secret)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, linkcrypto.CommitNonceSize)
	if _, err := io.ReadFull(rnd, nonce); err != nil {
		return nil, err
	}
	commit, err := linkcrypto.CommitKey(kp.PublicKey(), nonce)
	if err != nil {
		return nil, err
	}
	return &Link{peer: peer, role: role, epoch: ep, self: kp, nonce: nonce, commit: commit}, nil
}

func linkcryptoRole(role int) linkcrypto.Role {
	if role == LCInitiator {
		return linkcrypto.Initiator
	}
	return linkcrypto.Responder
}

// derive computes the session keys, SAS and codecs for a verified peer key.
func derive(l *Link, peerPub []byte) (*pendingKeys, error) {
	if l == nil || l.self == nil {
		return nil, linkcrypto.ErrInvalidKey
	}
	keys, err := linkcrypto.DeriveSession(linkcryptoRole(l.role), l.self, peerPub)
	if err != nil {
		return nil, err
	}
	sas, err := linkcrypto.SAS(l.self.PublicKey(), peerPub)
	if err != nil {
		return nil, err
	}
	p := &pendingKeys{keys: keys, sas: sas, resumeAuth: keys.ResumeAuth()}
	send, recv, ts, tr := keys.Send(), keys.Recv(), keys.TextSend(), keys.TextRecv()
	defer func() { clear(send); clear(recv); clear(ts); clear(tr) }()
	if p.fileTx, err = linkwire.NewFileSender(send); err != nil {
		return nil, err
	}
	if p.fileRx, err = linkwire.NewFileReceiver(recv); err != nil {
		return nil, err
	}
	if p.textTx, err = linkwire.NewTextSender(ts); err != nil {
		return nil, err
	}
	if p.textRx, err = linkwire.NewTextReceiver(tr); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *pendingKeys) wipe() {
	if p == nil {
		return
	}
	clear(p.resumeAuth)
	*p = pendingKeys{}
}

// install moves a derivation into the link: exactly one codec of each kind
// for the link's life (link §5.5). A second install is refused.
func (l *Link) install(p *pendingKeys) {
	if l == nil || p == nil || l.keys != nil || l.destroyed {
		p.wipe()
		return
	}
	l.keys, l.fileTx, l.fileRx, l.textTx, l.textRx = p.keys, p.fileTx, p.fileRx, p.textTx, p.textRx
	l.resumeAuth, l.sas = p.resumeAuth, p.sas
	*p = pendingKeys{}
}

// destroy zeroes what this package owns and drops every reference to keys and
// codecs. linkcrypto/linkwire offer no in-place wipe of their own copies; with
// the references gone nothing can use them again (P9), and a later link has
// new keys anyway.
func (l *Link) destroy() {
	if l == nil {
		return
	}
	clear(l.nonce)
	clear(l.resumeAuth)
	l.self, l.nonce, l.keys, l.resumeAuth = nil, nil, nil, nil
	l.fileTx, l.fileRx, l.textTx, l.textRx = nil, nil, nil, nil
	l.sas = ""
	l.destroyed = true
}

// alive reports whether the link still holds codecs.
func (l *Link) alive() bool { return l != nil && !l.destroyed && l.keys != nil }

// ---------------------------------------------------------------- Link formatters

func (l Link) summary() string {
	state := "handshake"
	switch {
	case l.destroyed:
		state = "destroyed"
	case l.keys != nil:
		state = "keyed"
	}
	return fmt.Sprintf("linksession.Link{peer:%q role:%s epoch:%d/%d/%d %s secrets:redacted}",
		l.peer, LinkTable.Classes[l.role], l.epoch.Room, l.epoch.Link, l.epoch.Transport, state)
}

// Format prints the peer, role, epoch and key state only, for every verb.
func (l Link) Format(f fmt.State, _ rune) { io.WriteString(f, l.summary()) }
func (l Link) String() string             { return l.summary() }
func (l Link) GoString() string           { return l.summary() }

// MarshalJSON never serialises a key, codec, nonce or SAS.
func (l Link) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"link": l.summary()})
}

// LogValue keeps slog from walking the struct.
func (l Link) LogValue() slog.Value { return slog.StringValue(l.summary()) }

// ---------------------------------------------------------------- pendingKeys formatters

const pendingSummary = "linksession.pendingKeys{redacted}"

func (pendingKeys) Format(f fmt.State, _ rune) { io.WriteString(f, pendingSummary) }
func (pendingKeys) String() string             { return pendingSummary }
func (pendingKeys) GoString() string           { return pendingSummary }
func (pendingKeys) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"pendingKeys": "redacted"})
}
func (pendingKeys) LogValue() slog.Value { return slog.StringValue(pendingSummary) }

// ---------------------------------------------------------------- Session formatters

func (s Session) summary() string {
	name := func(m *Machine) string {
		if m == nil {
			return "-"
		}
		return m.StateName()
	}
	return fmt.Sprintf("linksession.Session{cmd:%d disc:%s link:%s file:%s text:%s adm:%d epoch:%d/%d/%d ended:%t secrets:redacted}",
		s.cfg.Cmd, name(s.disc), name(s.linkM), name(s.fileM), name(s.textM), s.adm,
		s.epoch.Room, s.epoch.Link, s.epoch.Transport, s.ended)
}

// Format prints machine states and the epoch only, for every verb: a Session
// holds its Link in an unexported field, which fmt would otherwise walk.
func (s Session) Format(f fmt.State, _ rune) { io.WriteString(f, s.summary()) }
func (s Session) String() string             { return s.summary() }
func (s Session) GoString() string           { return s.summary() }

// MarshalJSON never serialises a key, codec, nonce, SAS or captured frame.
func (s Session) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"session": s.summary()})
}

// LogValue keeps slog from walking the struct.
func (s Session) LogValue() slog.Value { return slog.StringValue(s.summary()) }
