# Native large-share upload packing

Source implementation introduced 2026-10-20. This document records the source
and client contract; it is not an app release or a production deployment
record. The published macOS 1.5.0 client offers the capability; macOS 1.4.10
binaries predate it and keep the 8 MiB default. The larger target applies only
when both the client and the server support it. Server source with this
capability is in
[fbe308b](https://github.com/relayium/relayium/commit/fbe308bede975a22a16e339e954791215e7960d9).

## Negotiation and compatibility

The native INIT request for a Share with declared ciphertext size at least
64 MiB offers `X-Relayium-Upload-Chunk: large-v1`. The server returns its normal
`chunkSize` field. For this exact offer and purpose, the target is
`min(16 MiB, maxAppendBytes) - (MaxFrameCT + 4)` = 16,580,332 bytes with the
current limits. This leaves one maximum encrypted frame of headroom: native
packing includes whole frames and can exceed its target. A full current data
batch contains 85 frames, 16,713,380 bytes, below the unchanged 16,777,216-byte
append cap. Simply advertising 16 MiB would cross that cap.

The response remains authoritative; the client retains its existing validation.
The header is a packing preference, never authorization to append extra bytes.
The `ordered-v1` capability remains the separate prerequisite for the existing
two-request pipeline. No frame, offset, recovery, durable acknowledgement,
deadline, quota, storage or metering contract changes. The 64 MiB global server
pipeline staging bound remains unchanged. Client batch buffering can grow from
about 16.13 MiB to 31.88 MiB; this is not a process RSS measurement.

| Client / server | Share packing target |
| --- | --- |
| New / new, Share >=64 MiB | 16,580,332 bytes |
| New / old, or capability withdrawn | Old server's 8 MiB default |
| Old / new; missing or unknown offer | 8 MiB |
| Small or size-unknown Share | 8 MiB |
| Device Inbox / pair-room | Existing 8 MiB / 1 MiB |

The threshold is a conservative scope choice, not an established optimum. No
app-version comparison, minimum-version increase or persisted session flag is
needed. Resuming still follows the server's stored offset and accepted bounds.
The generated realtime peer capability vectors are unaffected: this offer is
on account upload INIT, covered by HTTP/native compatibility tests instead.

## Controlled measurement

Each profile compared six balanced-order 70,000,000-byte uploads per setting,
plus one excluded warmup per setting. Both used the actual release-compiled
native uploader, loopback HTTP, SQLite and DiskStore with fsync. Every sample
downloaded, decrypted and checked the complete plaintext SHA-256, exact byte
meter, zero retry, bounded requests and reclaimed pipeline state.

| Profile | 8 MiB median | Negotiated median |
| --- | ---: | ---: |
| Local fast | 98.00 ms | 82.91 ms |
| Aggregate 1 ms / 64 KiB read pacing; 500 ms post-durable confirmation delay | 4,957.80 ms | 3,108.08 ms |
| Aggregate 8 ms / 64 KiB pacing; 100 ms confirmation delay | 10,552.98 ms | 10,600.54 ms |

PATCH count fell from nine to five. Confirmation-delay upload time fell about
37%; the bandwidth-bound profile was essentially unchanged (0.45% slower).
These are controlled local measurements with a warm file cache, not Internet
or physical-device results. Diagnostic stages overlap and do not isolate
encryption CPU. An earlier exploratory 8/16/32 MiB comparison used test-only
larger append limits; 32 MiB increased client buffering about fourfold and
did not improve the bandwidth-bound profile. It is not the proposed setting.

Separate actual-HTTP fault controls drop a durable PATCH answer, corrupt
ciphertext and cancel an active upload. Recovery must preserve the full SHA and
single byte settlement; corruption must fail authentication; cancellation must
release active requests, staged bytes and waiters without finalizing.

## Repeat locally

On macOS with the repository's Go/Swift toolchains, run from the checkout:

```sh
python3 scripts/test/upload-chunk-tuning.py --output /tmp/relayium-chunk-matrix
python3 scripts/test/upload-chunk-tuning.py --mode faults --output /tmp/relayium-chunk-faults
```

Output paths must not exist. The runner builds a private release package with
unchanged shipping sources and dependency pins, selects owning tests, starts
only a loopback fixture, and stops its owned processes. Dependency downloads
can be required on a cold cache. Logs, raw JSONL and fault JSON stay private in
the output directory; remove that directory when its evidence is no longer
needed. `--mode smoke` runs only the fast-profile warmups. `--experimental`
selects the exploratory 8/16/32 comparison with test-only append caps; it must
never be interpreted as production configuration. No environment opt-in means
the benchmark tests skip during ordinary CI.

The Go fixture must be run alone: it temporarily changes an existing package
global append limit for comparisons, restores it on teardown and is not safe
to run concurrently with other account tests in the same process. The runner
uses the exact fixture test filter. It does not edit or deploy server defaults.
