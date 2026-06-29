# Self-hosted coturn (TURN relay for cross-network transfers)

Relayium uses TURN only as a fallback when direct P2P (STUN hole-punching)
fails. The Go server mints ephemeral credentials with the coturn TURN REST
mechanism; coturn validates them against a shared secret with no per-credential
state.

## Minimal coturn config (`/etc/turnserver.conf`)

```
use-auth-secret
static-auth-secret=<SAME VALUE AS the server's -turn-secret>
realm=relayium.app
listening-port=3478
tls-listening-port=5349
# TLS for clients behind restrictive egress (turns:):
cert=/etc/letsencrypt/live/turn.relayium.app/fullchain.pem
pkey=/etc/letsencrypt/live/turn.relayium.app/privkey.pem
# Relay port range — open these in the firewall:
min-port=49152
max-port=65535
fingerprint
no-multicast-peers
# Publish per-allocation relay accounting to Redis for metering (②b-2):
redis-statsdb="ip=127.0.0.1 dbname=0 port=6379"
```

## Run the Go server pointing at it

```
relayium \
  -turn-secret '<SAME VALUE AS static-auth-secret>' \
  -turn-urls 'turn:turn.relayium.app:3478,turns:turn.relayium.app:5349' \
  -stun-urls 'stun:turn.relayium.app:3478'
```

If `-turn-secret` is empty, TURN is disabled and the app uses STUN only
(cross-network still works for easy NATs).

## Relay-byte metering (②b-2)

With `redis-statsdb` set, coturn publishes per-allocation `total_traffic`
(rcvb/sentb) to Redis on the channel
`turn/realm/<realm>/user/<username>/allocation/<id>/total_traffic`. Run the Go
server with `-redis-addr <host:port>` (the same Redis) to ingest those bytes and
attribute them to the transfer's owning user. If `-redis-addr` is empty, metering
is off and transfers/TURN are unaffected.

## Firewall

Open UDP/TCP 3478, TCP 5349 (TLS), and the UDP relay range (min-port..max-port).

## Security notes

- Credentials are short-lived (1h) and HMAC-signed; coturn reads the expiry from
  the username and rejects expired ones.
- coturn relays only the DTLS-encrypted WebRTC stream — it never sees plaintext.
