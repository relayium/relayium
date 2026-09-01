package main

import (
	"fmt"
	"io"
)

// Help is a contract, not decoration. Every public command and every `inbox`
// subcommand answers `-h`, `--help` and `relayium help <command>` the same way:
// its own usage on STDOUT, exit 0, and nothing else — no credential read, no
// identity file created, no request to a server. A person asking what a command
// does has not asked it to run, and someone who is logged out, offline, or
// reading over someone's shoulder must still be able to find out.
//
// The texts below belong to the commands that had no usage of their own. push,
// sync, serve and inbox keep theirs next to their implementations
// (pushUsage/pullUsage in run.go, syncUsage, serveUsage, inboxUsage); the maps
// at the bottom of this file are what make every one of them reachable through
// all three forms.

const sendUsage = `relayium send — send files to a peer over a pairing code

usage:
  relayium send <src...> [code]

Cross-network and direct: a short rendezvous handshake on Relayium's server
introduces the two ends, then the files travel straight between them. If no
direct connection can be made (both ends behind strict NAT), the transfer fails
— the CLI never relays file bytes.

Both machines must be online at the same time; this is not a mailbox. For a
recipient who is not there right now, use "relayium up" (a stored link) or the
Device Inbox from the Web or a native app.

positional arguments:
  <src...>   files or directories to send
  [code]     an existing 6-digit pairing code. Leave it out to mint one, which
             requires "relayium login"; joining with a code someone gave you
             needs no account.

flags:
  --verify           stop and compare the verification code (SAS) before sending
  --server URL       Relayium rendezvous server (self-hosting)
  --advertise H:P    advertise this host:port as a direct endpoint (advanced; the
                     address must really be reachable from the peer, e.g. a
                     forwarded port)
`

const receiveUsage = `relayium receive — receive files sent to a pairing code

usage:
  relayium receive <code> [destdir]

The other side runs "relayium send" and reads out the 6-digit code. No Relayium
account is needed to receive: the code is the introduction. Both machines must
be online at the same time, and the bytes travel directly between them — if no
direct connection can be made, the transfer fails rather than being relayed.

positional arguments:
  <code>      the 6-digit pairing code the sender printed
  [destdir]   directory to write into (default ".")

flags:
  --verify           stop and compare the verification code (SAS) before opening
  --server URL       Relayium rendezvous server (self-hosting)
  --advertise H:P    advertise this host:port as a direct endpoint (advanced; the
                     address must really be reachable from the peer)
`

const textUsage = `relayium text — ephemeral encrypted messages with a peer

usage:
  relayium text [code]

Both ends run this command. The session is end-to-end encrypted over a direct
pinned-TLS connection of its own; Relayium keeps no message body and no
server-side history. Both machines must be online at the same time.

positional arguments:
  [code]   an existing 6-digit pairing code. Leave it out to mint one, which
           requires "relayium login"; joining with a code needs no account.

One line per message when typing interactively. Pipe stdin to send exact
multiline content: pbpaste | relayium text 483920. At most 65,536 UTF-8 bytes
per message — anything larger is a file, so use "relayium send".

flags:
  --verify           stop and compare the verification code (SAS) before the
                     session opens. It needs a terminal to answer, so a piped
                     --verify run refuses rather than silently skipping it.
  --yes              never prompt for the SAS comparison (this is the default;
                     kept for scripts, and it overrides --verify)
  --server URL       Relayium rendezvous server (self-hosting)
  --advertise H:P    advertise this host:port as a direct endpoint (advanced; the
                     address must really be reachable from the peer)
`

const idUsage = `relayium id — print this host's direct-transfer fingerprint

usage:
  relayium id [--config-dir D]

Prints the SHA-256 fingerprint of this host's direct-transfer identity: the
value a peer's "relayium authorize <fingerprint>" needs before this host may
push to it. On first run the identity keypair is created in --config-dir; after
that the fingerprint is stable.

Local only — no Relayium account and no network access are involved.

flags:
  --config-dir D   identity/trust directory (default ~/.config/relayium)
`

const authorizeUsage = `relayium authorize — allow a pusher to send to this host

usage:
  relayium authorize <fingerprint> [--config-dir D]

Adds a fingerprint to THIS host's authorized_fingerprints file, which is the
whole trust decision for "relayium serve": a listener accepts a pusher only when
its fingerprint is in that file. Being logged into a Relayium account authorizes
nobody, and this command needs no account and no network.

positional arguments:
  <fingerprint>   the 64 hex characters the pusher prints with "relayium id"

Use the SAME --config-dir the listener runs with. A serve that is already
running picks the new fingerprint up on the next connection — no restart.

flags:
  --config-dir D   identity/trust directory (default ~/.config/relayium)
`

const loginUsage = `relayium login — log this machine in to a Relayium account

usage:
  relayium login [--server URL] [--config-dir D] [--device-name LABEL]

Runs the device-code flow: it prints a short code and a URL, you approve it in a
browser, and the credential is stored in --config-dir. Needs network access to
the server.

An account is required only for the hosted and account-bound features: minting a
pairing code for "send"/"text", "relayium up", and the Device Inbox. It grants
NO filesystem access to anyone — "serve"/"push relayium://" trust is the
authorized_fingerprints file and nothing else.

flags:
  --server URL          cloud server base URL (default ` + defaultCloudServer + `)
  --config-dir D        credential directory (default ~/.config/relayium)
  --device-name LABEL   how this machine appears in My Devices
                        (default: this host's own name)
`

const logoutUsage = `relayium logout — revoke and clear this machine's credential

usage:
  relayium logout [--local-only] [--config-dir D]

By default it revokes the token on the server first and only then clears it
locally, so a failed revocation keeps the credential for a retry instead of
leaving a live token behind. That needs network access.

flags:
  --local-only     clear the local credential WITHOUT revoking it on the server.
                   The offline escape hatch: the token stays valid until it
                   expires or you revoke it elsewhere.
  --config-dir D   credential directory (default ~/.config/relayium)
`

const whoamiUsage = `relayium whoami — show the logged-in cloud account

usage:
  relayium whoami

Reads the credential stored in ~/.config/relayium and prints the account and
server it is for. Local only: it makes no request, so it reports what this
machine has, not whether the server still accepts it. Exits non-zero when this
machine is not logged in.
`

const upUsage = `relayium up — encrypt locally and upload to a shareable link

usage:
  relayium up <path...> [--burn] [--ttl D] [--max-downloads N]

Files are encrypted on this machine and only the ciphertext is uploaded; the
printed link carries the key in its "#k=" fragment, which a browser never sends
to the server. Anyone with the link can open it in a browser or fetch it with
"relayium down" — no account needed on their side.

This is a hosted, asynchronous stored-link mode: the ciphertext sits in
Relayium's storage until someone fetches it, so the two ends never have to be
online together. That is what makes it unlike the pairing-code modes
("send"/"receive"/"text") and the direct server modes ("push"/"pull"/"sync"
with "serve"), which move bytes straight between two machines. It is not the
only CLI mode that involves the server, though — the Device Inbox is hosted and
asynchronous too; the CLI is only its receive side.

Because a copy is stored, "up" requires "relayium login" and counts against the
account's storage cap, traffic allowance, daily quota and retention window,
exactly like a stored link created in the browser.

positional arguments:
  <path...>   files or directories to upload

flags:
  --burn                 delete after the first download
  --ttl D                retention: 7d, 2w, 2h, 90m, or a number of seconds. The
                         plan's cap still applies and a longer request is
                         shortened (you are told when that happens).
  --max-downloads N      stop serving the link after N downloads
  --server URL           override the cloud server. It must be the server you
                         are logged in to; the token is never sent elsewhere.

The link goes to stdout, so "relayium up f | pbcopy" copies only the link.
`

const downUsage = `relayium down — fetch and decrypt a stored link

usage:
  relayium down <link-or-code> [destDir]

No account is needed: the id and the key in the link are the only credential,
and the key never reaches the server. Needs network access to the server the
link points at.

positional arguments:
  <link-or-code>   a full "relayium up" link, or a bare <id>#k=<key> code
  [destDir]        directory to write into (default ".")

Quote the argument — the "#" would otherwise start a shell comment.

flags:
  --server URL   override the cloud server (default: the one in the link, else
                 ` + defaultCloudServer + `)
`

const updateUsage = `relayium update — upgrade this binary in place

usage:
  relayium update [--check] [--force]

Downloads the latest release from https://github.com/` + updateRepo + `/releases
and replaces the running binary. Needs network access and write permission on
the installed binary; no Relayium account is involved. On Windows a running .exe
cannot be replaced, so it prints where to download the zip instead.

flags:
  --check    only report whether an update is available; install nothing
  --force    reinstall even when already on the latest version
`

const versionUsage = `relayium version — print the CLI version

usage:
  relayium version

Prints this binary's version to stdout. Local only: no account, no network.
Use "relayium update --check" to ask whether a newer release exists.
`

const inboxRunUsage = `relayium inbox run — run the Device Inbox receiver

usage:
  relayium inbox run [--once] [--config-dir D]

The resident foreground worker: it dials out to the server, claims tasks your
account sent to THIS device, decrypts them, verifies them, and writes them into
the enabled receive directory. Nothing is received unless this is running, which
is what "relayium inbox service <kind>" installs.

Requires "relayium login" and "relayium inbox enable --dir <folder>" first, and
network access. One worker per state directory; a second exits rather than
racing the first. SIGINT/SIGTERM stop it cleanly.

RECEIVE SIDE ONLY. There is no CLI command that sends into an inbox — you send
to one from the Web or a native app. To move files between two of your own
servers, use "relayium serve" with "relayium push"/"relayium sync".

flags:
  --once           drain the queue once and exit instead of staying resident
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxEnableUsage = `relayium inbox enable — turn on Device Inbox receiving here

usage:
  relayium inbox enable --dir <folder> [--config-dir D]

The explicit opt-in: automatic receive is off until you name a directory. It
enrols this device with the server and publishes a public key, so files sent to
it can be sealed to this machine alone; the private half never leaves here.

Requires "relayium login" and network access. The directory is created (mode
0700) if it does not exist, and must be writable — that is checked before the
enrolment is announced. Enabling does not start receiving on its own: run
"relayium inbox run", or install a service.

flags:
  --dir <folder>   directory to receive files into (required)
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxDisableUsage = `relayium inbox disable — stop receiving and clear the enrolment

usage:
  relayium inbox disable [--local-only] [--config-dir D]

Turns automatic receive off locally first, then clears the inbox on the server
(which also terminates tasks already queued for this device), and only then
deletes the local private keys — in that order, because destroying the keys
earlier would make anything still queued permanently undecryptable.

Requires network access for the server half. If a worker is still running, or
the server cannot be reached, the enrolment and the keys are KEPT and it says so
rather than half-completing silently.

flags:
  --local-only     stop receiving here without clearing the server inbox and
                   without deleting the private keys. This device may still
                   appear as a send target until you clear it elsewhere.
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxStatusUsage = `relayium inbox status — show local, credential and server state

usage:
  relayium inbox status [--config-dir D]

Reports what is actually true: whether receive is on or paused, the receive
directory and whether it is usable, whether a worker holds the lock, which
account this machine holds a credential for, how many private keys it has, and
what the server says about this device's enrolment, presence and active key.

No secret is ever printed. The local section works offline; the server section
needs "relayium login" and network access, and its absence is reported rather
than guessed. Exits non-zero when there is no credential or the server cannot
be reached.

flags:
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxPauseUsage = `relayium inbox pause — stop receiving, keeping the enrolment

usage:
  relayium inbox pause [--config-dir D]

Pause is not disable. Nothing is revoked and no key is deleted: senders see this
device as offline and their files queue until you resume. A local state change,
so it needs no network.

flags:
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxResumeUsage = `relayium inbox resume — start receiving again after a pause

usage:
  relayium inbox resume [--config-dir D]

The inverse of "relayium inbox pause", and also the explicit retry gesture: it
re-queues tasks that stopped on a local blocker you have since fixed (a full
disk, a permission, an unavailable directory, a name conflict). Resuming is
local and durable; the re-queue needs network access and is reported separately
if it cannot be done yet.

flags:
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxServiceUsage = `relayium inbox service — print a service definition for this machine

usage:
  relayium inbox service <kind> [--dir <folder>] [--service-user U] [--config-dir D]

Prints a ready-to-install unit to stdout, filled in with this binary's real path
and this machine's paths; the install instructions go to stderr so the unit can
be redirected on its own. Local only: it writes and installs nothing, needs no
network, and needs no account.

positional arguments:
  <kind>   systemd-user, systemd-system, launchd, or container

flags:
  --dir <folder>     receive directory to write into the unit
                     (default: the one "relayium inbox enable" recorded)
  --service-user U   account a system-wide unit runs as (default: relayium)
  --config-dir D     credential/state directory (default ~/.config/relayium)
`

// commandUsage maps every public command to the text all three help forms
// print. It is also the list `relayium help <command>` accepts, so a command
// added without an entry here is a test failure, not a silent gap.
var commandUsage = map[string]string{
	"push":      pushUsage,
	"pull":      pullUsage,
	"sync":      syncUsage,
	"send":      sendUsage,
	"receive":   receiveUsage,
	"text":      textUsage,
	"serve":     serveUsage,
	"id":        idUsage,
	"authorize": authorizeUsage,
	"login":     loginUsage,
	"logout":    logoutUsage,
	"whoami":    whoamiUsage,
	"up":        upUsage,
	"down":      downUsage,
	"inbox":     inboxUsage,
	"update":    updateUsage,
	"version":   versionUsage,
}

// inboxCommandUsage is the same contract one level down: `relayium inbox run
// -h`, `relayium inbox help run` and `relayium help inbox run` are one answer.
var inboxCommandUsage = map[string]string{
	"run":     inboxRunUsage,
	"enable":  inboxEnableUsage,
	"disable": inboxDisableUsage,
	"status":  inboxStatusUsage,
	"pause":   inboxPauseUsage,
	"resume":  inboxResumeUsage,
	"service": inboxServiceUsage,
}

// runHelp implements `relayium help [command [subcommand]]`.
//
// It only ever prints. Dispatching to the command with "-h" appended would be
// shorter and wrong: it would run a command the person did not ask to run if any
// one of them ever missed its help check.
func runHelp(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, usage)
		return 0
	}
	name := args[0]
	if name == "inbox" && len(args) > 1 {
		return helpForInbox(args[1:], stdout, stderr)
	}
	text, ok := commandUsage[name]
	if !ok {
		// The same shape as an unknown command, because that is what it is.
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", name, usage)
		return 2
	}
	fmt.Fprint(stdout, text)
	return 0
}

// helpForInbox answers `help inbox <subcommand>` (and `inbox help <sub>`).
func helpForInbox(args []string, stdout, stderr io.Writer) int {
	text, ok := inboxCommandUsage[args[0]]
	if !ok {
		fmt.Fprintf(stderr, "unknown inbox command %q\n\n%s", args[0], inboxUsage)
		return 2
	}
	fmt.Fprint(stdout, text)
	return 0
}
