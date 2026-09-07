package com.relayium.android

import android.content.Context
import android.content.ContextWrapper
import com.relayium.android.transport.LinkTransport
import com.relayium.protocol.Crypto
import java.nio.ByteBuffer
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.DataChannel
import org.webrtc.PeerConnection

/**
 * The R8.2 admission/ordering contract against the ACTUAL production adapter,
 * adapted from the independent native-ingress probe: a recording [DataChannel]
 * subclass drives the real `onMessage`/`onDataChannel` code paths, and a
 * controlled executor makes the racing schedules deterministic. No JNI and no
 * emulator — which is exactly why these boundaries need JVM tests at all.
 */
class NativeIngressRegressionTest {

    /** Queues by default; `immediate = true` legally runs a posted task on the
     *  submitting thread — the schedule that used to dispose before register. */
    private class ControlledExecutor(val immediate: Boolean = false) : ScheduledThreadPoolExecutor(1) {
        val pending = ArrayList<Runnable>()
        override fun execute(command: Runnable) {
            if (immediate) command.run() else pending.add(command)
        }
    }

    private class FakeChannel(private val channelLabel: String = "relayium") : DataChannel(1L) {
        var observed: Observer? = null
        var disposed = false
        var unregistered = false
        var registeredAfterDispose = false
        override fun registerObserver(observer: Observer) {
            registeredAfterDispose = registeredAfterDispose || disposed
            observed = observer
        }
        override fun unregisterObserver() { unregistered = true }
        override fun label() = channelLabel
        override fun close() = Unit
        override fun dispose() { disposed = true }
        override fun state() = State.OPEN
    }

    private fun link(executor: ControlledExecutor): LinkTransport {
        val context = object : ContextWrapper(null) {
            override fun getApplicationContext(): Context = this
        }
        return LinkTransport(
            context, "0000000000000001", "0000000000000002", emptyList(), executor, {},
            object : LinkTransport.Events {
                override fun onReady(keys: Crypto.SessionKeys, sas: String, maxFrameBytes: Int) = Unit
                override fun onFileFrame(frame: ByteArray) = Unit
                override fun onTextFrame(frame: ByteArray) = Unit
                override fun onClosed(reason: String) = Unit
            },
        )
    }

    private fun field(link: LinkTransport, name: String): Any =
        LinkTransport::class.java.getDeclaredField(name).apply { isAccessible = true }.get(link)!!

    private fun register(link: LinkTransport, channel: DataChannel) {
        LinkTransport::class.java.getDeclaredMethod("register", DataChannel::class.java)
            .apply { isAccessible = true }.invoke(link, channel)
    }

    @Test
    fun `a count-capped refusal releases exactly what it reserved`() {
        val executor = ControlledExecutor()
        val transport = link(executor)
        val channel = FakeChannel()
        register(transport, channel)
        // The cap is reached through ACTUAL callbacks, one reserved byte each.
        repeat(LinkTransport.PENDING_FRAME_MAX_COUNT) {
            channel.observed!!.onMessage(DataChannel.Buffer(ByteBuffer.wrap(byteArrayOf(1)), true))
        }
        val reserved = (field(transport, "pendingBytes") as AtomicLong).get()
        assertEquals(LinkTransport.PENDING_FRAME_MAX_COUNT.toLong(), reserved)
        // One more: refused on COUNT, before its byte was ever added.
        channel.observed!!.onMessage(DataChannel.Buffer(ByteBuffer.wrap(byteArrayOf(1)), true))
        assertEquals(
            "a count refusal must not release bytes it never reserved",
            reserved, (field(transport, "pendingBytes") as AtomicLong).get(),
        )
        assertEquals(
            LinkTransport.PENDING_FRAME_MAX_COUNT,
            (field(transport, "pendingFrames") as AtomicInteger).get(),
        )
        executor.shutdownNow()
    }

    @Test
    fun `an immediately-run duplicate rejection cannot dispose before registration`() {
        val executor = ControlledExecutor(immediate = true)
        val transport = link(executor)
        LinkTransport::class.java.getDeclaredField("fileChannel")
            .apply { isAccessible = true }.set(transport, FakeChannel())
        val observerClass = LinkTransport::class.java.declaredClasses.first { it.simpleName == "Observer" }
        val observer = observerClass.getDeclaredConstructor(LinkTransport::class.java)
            .apply { isAccessible = true }.newInstance(transport) as PeerConnection.Observer
        val duplicate = FakeChannel()
        observer.onDataChannel(duplicate)
        assertFalse(
            "a scheduled rejection may legally win the race; registration must already be done",
            duplicate.registeredAfterDispose,
        )
        assertTrue("the rejected duplicate is disposed", duplicate.disposed)
        assertTrue("and its observer came off before dispose", duplicate.unregistered)
        executor.shutdownNow()
    }
}
