package com.relayium.protocol

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The discriminator that tells a relayium CLI peer apart from an app peer in a
 * pairing room.
 *
 * Its whole safety argument is that no app or web peer emits a top-level
 * `kind`, so every shape one of them DOES emit is pinned here: a future signal
 * that adds the field fails this test rather than silently refusing real
 * pairings in production.
 */
class CliPeerSignalTest {

    /** Verbatim from `hsMsg` in `server/internal/rzvous/handshake.go`. `mode` is
     *  omitted for the file mode, which a plain `relayium send` emits. */
    private val cliCommit = Json.obj(
        "kind" to Json.Str("commit"),
        "commit" to Json.Str("Y29tbWl0"),
        "mode" to Json.Str("text"),
    )
    private val cliCommitFile = Json.obj(
        "kind" to Json.Str("commit"),
        "commit" to Json.Str("Y29tbWl0"),
    )
    private val cliReveal = Json.obj(
        "kind" to Json.Str("reveal"),
        "fp" to Json.Str("ab".repeat(32)),
        "nonce" to Json.Str("bm9uY2U="),
        "candidates" to Json.Arr(listOf(Json.Str("192.0.2.1:5000"))),
    )

    @Test
    fun `recognises the CLI handshake frames`() {
        assertTrue(CliPeerSignal.isHandshake(cliCommit))
        assertTrue(CliPeerSignal.isHandshake(cliCommitFile))
        assertTrue(CliPeerSignal.isHandshake(cliReveal))
    }

    @Test
    fun `does not recognise any shape an app peer sends`() {
        val appSignals = listOf(
            "capability hello" to Json.obj(
                "caps" to Json.Arr(listOf(Json.Str("link/1"), Json.Str("preupload/1"))),
            ),
            "relay-RTT map" to Json.obj("relayRtt" to Json.obj("r1" to Json.Num(42.0))),
            "rename" to Json.obj("rename" to Json.Str("Lily's phone")),
            "link request" to Json.obj("linkRequest" to Json.Bool(true), "link" to Json.Bool(true)),
            "busy" to Json.obj("busy" to Json.Bool(true), "link" to Json.Bool(true)),
            "link leave" to Json.obj(
                "link" to Json.Bool(true), "leave" to Json.Bool(true), "auth" to Json.Str("c2ln"),
            ),
            "renew" to Json.obj(
                "link" to Json.Bool(true),
                "renew" to Json.obj("round" to Json.Num(1.0)),
                "auth" to Json.Str("c2ln"),
            ),
            "offer" to Json.obj(
                "sdp" to Json.obj("type" to Json.Str("offer"), "sdp" to Json.Str("v=0")),
                "commit" to Json.Str("Y29tbWl0"),
                "caps" to Json.Arr(listOf(Json.Str("link/1"))),
            ),
            "answer" to Json.obj(
                "sdp" to Json.obj("type" to Json.Str("answer"), "sdp" to Json.Str("v=0")),
            ),
            "ice" to Json.obj(
                "ice" to Json.obj("candidate" to Json.Str("candidate:1 1 udp")),
            ),
        )
        for ((name, signal) in appSignals) {
            assertFalse(CliPeerSignal.isHandshake(signal), "$name must not read as a CLI peer")
        }
    }

    /**
     * `commit` is a legitimate field on an app's offer AND is carried by the
     * CLI's commit frame, which is why the controller's check has to run before
     * `Signal.fromJson` is acted on — and why the discriminator cannot be this.
     */
    @Test
    fun `does not key on commit`() {
        assertFalse(CliPeerSignal.isHandshake(Json.obj("commit" to Json.Str("Y29tbWl0"))))
    }

    @Test
    fun `rejects non-objects and a non-string kind`() {
        val bad = listOf(
            null,
            Json.Null,
            Json.Str("kind"),
            Json.Num(7.0),
            Json.Bool(true),
            Json.Arr(listOf(Json.obj("kind" to Json.Str("commit")))),
            Json.obj("kind" to Json.Num(1.0)),
            Json.obj("kind" to Json.Null),
            Json.obj(),
        )
        for (value in bad) {
            assertFalse(CliPeerSignal.isHandshake(value), "$value must not read as a CLI peer")
        }
    }
}
