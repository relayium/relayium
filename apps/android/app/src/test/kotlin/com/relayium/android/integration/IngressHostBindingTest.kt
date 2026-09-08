package com.relayium.android.integration

import com.relayium.android.ingress.ContentAccess
import com.relayium.android.ingress.IncomingUri
import com.relayium.android.ingress.IngressOutcome
import com.relayium.android.ingress.IngressRequest
import com.relayium.android.ingress.ProviderDescription
import com.relayium.android.ingress.ShareAdmission
import java.io.ByteArrayInputStream
import java.io.InputStream
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A staged share stays bound to the provider access that admitted it, for as
 * long as anything can read it.
 *
 * ## The defect this exists to keep out
 *
 * Every intent arrives with its OWN handle map — the URIs it named, resolved
 * against that intent's grants — and the ingress module keeps those handles
 * private on purpose: the map IS the capability. A host that kept one
 * long-lived staging and swapped the access underneath it as each intent
 * arrived would break that binding for a share that had already been TAKEN by
 * a dispatch: the dispatch is still live and still reading, and its reads would
 * start resolving through the newer intent's map.
 *
 * The consequence is not an abstract layering complaint. For a URI the new map
 * does not hold it is a grant lost mid-send; for one it does hold — the same
 * document shared twice — it is the WRONG provider entry answering for the
 * user's earlier file. An independent probe reproduced exactly that: a dispatch
 * of A read byte `2` from access B after a second intent arrived.
 */
class IngressHostBindingTest {

    /** A provider that serves one fixed byte, so which access answered is
     *  visible in the content itself rather than inferred. */
    private class Access(private val marker: Byte, private val known: Set<String>) : ContentAccess {
        override fun describe(uri: IncomingUri): ProviderDescription? =
            if (uri.key in known) ProviderDescription("file-$marker.bin", 1L) else null

        override fun open(uri: IncomingUri): InputStream {
            if (uri.key !in known) throw java.io.IOException("not this intent's item")
            return ByteArrayInputStream(byteArrayOf(marker))
        }
    }

    private fun contentUri(key: String) = IncomingUri(
        key = key,
        scheme = "content",
        authority = "com.example.provider",
        encodedAuthority = "com.example.provider",
    )

    /** An admitted share, through the real admission rules. */
    private fun admitted(vararg keys: String): IngressRequest.StageFiles {
        val outcome = ShareAdmission.admit(
            keys.map(::contentUri),
            readGranted = true,
            ownAuthorities = setOf("com.relayium.android"),
        )
        val accepted = outcome as? IngressOutcome.Accepted
            ?: error("the fixture share was refused: $outcome")
        return accepted.request as IngressRequest.StageFiles
    }

    @Test
    fun `a dispatched share keeps reading through the access that admitted it`() = runTest {
        val io = StandardTestDispatcher(testScheduler)
        val host = IngressHost(io = io)

        // Intent A, staged and then DISPATCHED — the share leaves the slot and
        // its owner is now reading from it.
        host.stage(admitted("item-a"), Access(marker = 1, known = setOf("item-a")), epoch = 0, scope = this)
        advanceUntilIdle()
        val first = requireNotNull(host.staged.value)
        val dispatched = requireNotNull(host.take(first.id, epoch = 0))

        // Intent B arrives while A is still in flight, naming a DIFFERENT
        // document through a different provider access.
        host.stage(admitted("item-b"), Access(marker = 2, known = setOf("item-b")), epoch = 0, scope = this)
        advanceUntilIdle()

        // A's read must still be A's. Byte 1, from the access that admitted it.
        val byte = dispatched.open(contentUri("item-a")).use { it.read() }
        assertEquals("the dispatched share read through a newer intent's access", 1, byte)
    }

    @Test
    fun `a dispatched share is unaffected by a later intent naming the same document`() = runTest {
        val io = StandardTestDispatcher(testScheduler)
        val host = IngressHost(io = io)

        // The same document shared twice. This is the case a membership check
        // cannot catch: the newer access HOLDS this key, so a swapped delegate
        // answers happily — with the wrong provider entry.
        host.stage(admitted("same"), Access(marker = 1, known = setOf("same")), epoch = 0, scope = this)
        advanceUntilIdle()
        val first = requireNotNull(host.staged.value)
        val dispatched = requireNotNull(host.take(first.id, epoch = 0))

        host.stage(admitted("same"), Access(marker = 2, known = setOf("same")), epoch = 0, scope = this)
        advanceUntilIdle()

        assertEquals(
            "a later intent's access answered for the earlier dispatch",
            1,
            dispatched.open(contentUri("same")).use { it.read() },
        )
    }

    @Test
    fun `a newer intent replaces what is merely staged`() = runTest {
        val io = StandardTestDispatcher(testScheduler)
        val host = IngressHost(io = io)

        host.stage(admitted("item-a"), Access(marker = 1, known = setOf("item-a")), epoch = 0, scope = this)
        advanceUntilIdle()
        val first = requireNotNull(host.staged.value)

        host.stage(admitted("item-b"), Access(marker = 2, known = setOf("item-b")), epoch = 0, scope = this)
        advanceUntilIdle()
        val second = requireNotNull(host.staged.value)

        // Latest wins for the SLOT: two shares are two things the user asked
        // for, and the older one is the one they have moved on from.
        assertTrue(second.id != first.id)
        assertNull("the superseded share should no longer be takeable", host.take(first.id, epoch = 0))
        assertNotNull(host.take(second.id, epoch = 0))
    }

    @Test
    fun `describing reads the access that admitted the share`() = runTest {
        val io = StandardTestDispatcher(testScheduler)
        val host = IngressHost(io = io)

        host.stage(admitted("item-a"), Access(marker = 1, known = setOf("item-a")), epoch = 0, scope = this)
        advanceUntilIdle()

        val described = requireNotNull(host.staged.value?.items)
        assertEquals(1, described.size)
        assertEquals("file-1.bin", described[0].displayName)
        assertEquals(1L, described[0].size)
    }

    @Test
    fun `a share staged under a superseded identity is released`() = runTest {
        val io = StandardTestDispatcher(testScheduler)
        val host = IngressHost(io = io)

        host.stage(admitted("item-a"), Access(marker = 1, known = setOf("item-a")), epoch = 0, scope = this)
        advanceUntilIdle()
        assertNotNull(host.staged.value)

        // The identity moved. A share nobody can dispatch is a grant nobody
        // should keep.
        host.releaseStale(epoch = 1)
        assertNull(host.staged.value)
    }
}
