package com.relayium.android.cloud

import java.io.OutputStream
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The upload PURPOSE query, observed on the wire.
 *
 * A resumable session decides, once and irreversibly, who may ever read the
 * object it opens: a `share` is fetchable by anyone holding the capability
 * link, a `device_task` is fetchable only by the one target device under an
 * active claim. That difference is carried by a single query parameter, so it
 * is asserted here as a SERVER saw it rather than as the client meant it.
 *
 * Three properties, and the third is the one that has to happen before any
 * socket exists.
 */
class CloudUploadPurposeTest {

    private val header = byteArrayOf(0, 0, 0, 1, 0x7b)

    /**
     * Answers every init with one valid session, and records the request.
     *
     * Through the shared `respond` helper rather than a hand-written status
     * line: it sends `Connection: close`, and this server serves ONE request per
     * connection — so a pooled second request would be answered by a socket
     * closing under it.
     */
    private fun server() = RecordingHttpServer { _, out: OutputStream ->
        RecordingHttpServer.respond(
            out,
            body = """{"uploadId":"0123456789abcdef0123456789abcdef","chunkSize":262144}"""
                .toByteArray(),
        )
    }

    private fun query(server: RecordingHttpServer): Map<String, String> =
        server.received.last().query.split('&').filter { it.isNotEmpty() }
            .associate { it.substringBefore('=') to it.substringAfter('=', "") }

    /**
     * The DEFAULT is unchanged, parameter for parameter. Existing callers pass
     * no purpose at all, and this is what stops the new argument from quietly
     * altering what a share has always been.
     */
    @Test
    fun `an unspecified purpose is still exactly a share`() = runBlocking {
        server().use { server ->
            CloudClient(server.origin, "relayium-test/1")
                .initUpload(header, burnAfterRead = false, ttlSeconds = 3600,
                    payloadTotal = 99, token = "rlm_cli_test")
            val q = query(server)
            assertEquals("share", q["purpose"])
            assertEquals("0", q["burnAfterRead"])
            assertEquals("3600", q["ttl"])
            assertEquals("99", q["size"])
        }
    }

    /** An explicit share is byte-identical to the default. */
    @Test
    fun `an explicit share sends the same query as the default`() = runBlocking {
        server().use { server ->
            val client = CloudClient(server.origin, "relayium-test/1")
            client.initUpload(header, false, 3600, 99, "rlm_cli_test")
            client.initUpload(header, false, 3600, 99, "rlm_cli_test",
                StoredUploadPurpose.SHARE)
            val requests = server.received.toList()
            assertEquals(2, requests.size)
            assertEquals(requests[0].target, requests[1].target)
        }
    }

    /** A device delivery names itself, so the server never has to infer it. */
    @Test
    fun `a device task upload declares its purpose`() = runBlocking {
        server().use { server ->
            CloudClient(server.origin, "relayium-test/1")
                .initUpload(header, burnAfterRead = false, ttlSeconds = 3600,
                    payloadTotal = 99, token = "rlm_cli_test",
                    purpose = StoredUploadPurpose.DEVICE_TASK)
            assertEquals("device_task", query(server)["purpose"])
        }
    }

    /**
     * The refusal, and it happens BEFORE a request exists.
     *
     * The server refuses this combination too, but learning it remotely costs a
     * round trip and — more importantly — a caller that asked for both asked
     * for two different objects. Asserted by the server having received
     * NOTHING, which is the only way to tell "refused locally" apart from
     * "refused after we sent it".
     */
    @Test
    fun `a burn-after-read device task is refused before any request is sent`() = runBlocking {
        server().use { server ->
            val thrown = try {
                CloudClient(server.origin, "relayium-test/1")
                    .initUpload(header, burnAfterRead = true, ttlSeconds = 3600,
                        payloadTotal = 99, token = "rlm_cli_test",
                        purpose = StoredUploadPurpose.DEVICE_TASK)
                null
            } catch (e: CloudException) {
                e
            }
            assertEquals(CloudFailure.Kind.MALFORMED, thrown?.failure?.kind)
            assertTrue("nothing may reach the network", server.received.isEmpty())
        }
    }

    /** Burn is still an ordinary, permitted request for a share. */
    @Test
    fun `a burn-after-read share is unaffected`() = runBlocking {
        server().use { server ->
            CloudClient(server.origin, "relayium-test/1")
                .initUpload(header, burnAfterRead = true, ttlSeconds = 3600,
                    payloadTotal = 99, token = "rlm_cli_test")
            assertEquals("1", query(server)["burnAfterRead"])
            assertEquals("share", query(server)["purpose"])
        }
    }

    /** The wire spelling is the server's, not a Kotlin name. */
    @Test
    fun `wire values match the server vocabulary`() {
        assertEquals("share", StoredUploadPurpose.SHARE.wire)
        assertEquals("device_task", StoredUploadPurpose.DEVICE_TASK.wire)
        assertNull(StoredUploadPurpose.entries.firstOrNull { it.wire.isEmpty() })
    }
}
