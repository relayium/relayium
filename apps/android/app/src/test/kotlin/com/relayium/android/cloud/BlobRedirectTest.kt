package com.relayium.android.cloud

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The redirect rule for anonymous ciphertext reads.
 *
 * Kept as a pure decision so the cases a loopback server cannot stage — a
 * production `https` origin refusing a plaintext target — are still executable.
 */
class BlobRedirectTest {

    private val production = "https://relayium.com".toHttpUrl()
    private val local = "http://127.0.0.1:8080".toHttpUrl()
    private val from = "https://relayium.com/api/files/abc/blob".toHttpUrl()

    private fun verdict(location: String?, origin: okhttp3.HttpUrl = production, hop: Int = 0) =
        BlobRedirect.next(from, location, origin, hop)

    @Test
    fun `a fleet node over TLS is followed`() {
        val v = verdict("https://node7.relayium.com/dl/blobkey?t=signed")
        assertEquals(
            BlobRedirect.Verdict.Follow("https://node7.relayium.com/dl/blobkey?t=signed".toHttpUrl()),
            v,
        )
    }

    @Test
    fun `a BYO node on any TLS host is followed`() {
        // The whole point of BYO: the user advertised their own host, and a
        // native client opts into reaching it. The request is anonymous, so
        // there is no credential to leak there.
        assertEquals(
            BlobRedirect.Verdict.Follow("https://my-nas.example:8443/dl/k".toHttpUrl()),
            verdict("https://my-nas.example:8443/dl/k"),
        )
    }

    @Test
    fun `a plaintext target is refused whenever the origin is secure`() {
        assertEquals(
            BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.INSECURE_SCHEME),
            verdict("http://node7.relayium.com/dl/blobkey"),
        )
    }

    @Test
    fun `a plaintext target is allowed only on the same host as a plaintext origin`() {
        val localFrom = "http://127.0.0.1:8080/api/files/abc/blob".toHttpUrl()
        assertEquals(
            BlobRedirect.Verdict.Follow("http://127.0.0.1:9090/dl/k".toHttpUrl()),
            BlobRedirect.next(localFrom, "http://127.0.0.1:9090/dl/k", local, 0),
        )
        // A different host, even from a plaintext dev origin, is not the dev
        // server and gets no exemption.
        assertEquals(
            BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.INSECURE_SCHEME),
            BlobRedirect.next(localFrom, "http://evil.example/dl/k", local, 0),
        )
    }

    @Test
    fun `a credential-bearing target is refused`() {
        assertEquals(
            BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.USERINFO),
            verdict("https://user:pass@node7.relayium.com/dl/k"),
        )
    }

    @Test
    fun `a target carrying a fragment is refused, never stripped`() {
        // The fragment is where a KEY lives in this product. A client that
        // quietly drops one is a client that could one day forward it.
        assertEquals(
            BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.FRAGMENT),
            verdict("https://node7.relayium.com/dl/k#k=stolen"),
        )
    }

    @Test
    fun `a scheme this client does not speak is refused`() {
        for (target in listOf("intent://x#Intent;scheme=http;end", "file:///etc/passwd", "ftp://h/x")) {
            assertEquals(
                target,
                BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.UNPARSEABLE),
                verdict(target),
            )
        }
    }

    @Test
    fun `a missing Location is refused`() {
        assertEquals(BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.NO_LOCATION), verdict(null))
        assertEquals(BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.NO_LOCATION), verdict("   "))
    }

    @Test
    fun `hops are bounded`() {
        assertEquals(
            BlobRedirect.Verdict.Refuse(BlobRedirect.Reason.TOO_MANY_HOPS),
            verdict("https://node7.relayium.com/dl/k", hop = BlobRedirect.MAX_HOPS),
        )
    }

    @Test
    fun `a relative Location resolves against the URL that sent it`() {
        assertEquals(
            BlobRedirect.Verdict.Follow("https://relayium.com/api/files/abc/elsewhere".toHttpUrl()),
            verdict("elsewhere"),
        )
    }
}
