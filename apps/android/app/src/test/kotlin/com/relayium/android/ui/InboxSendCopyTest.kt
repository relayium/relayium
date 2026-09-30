package com.relayium.android.ui

import com.relayium.android.R
import com.relayium.android.inbox.InboxSendStatus
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxTaskErrorCode
import com.relayium.protocol.inbox.InboxTaskState
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.w3c.dom.Element
import org.junit.Test

/**
 * Which uncertainty the Outgoing row and its discard confirmation describe.
 *
 * An unsettled UPLOAD (publish attempted, no object id) never sent a create, so
 * it must not borrow the "may have reached the other device" copy that is true
 * only of an unresolved create.
 */
class InboxSendCopyTest {

    private fun send(
        phase: InboxSendStatus.Phase = InboxSendStatus.Phase.STOPPED,
        ambiguous: Boolean = false,
        uploadUnknown: Boolean = false,
        uploadUnsettled: Boolean = false,
    ) = InboxSendStatus(
        jobId = "job-1",
        targetDeviceId = "device-1",
        kind = InboxManifestKind.FILE,
        names = listOf("f.bin"),
        totalBytes = 100,
        phase = phase,
        ambiguous = ambiguous,
        uploadUnknown = uploadUnknown,
        uploadUnsettled = uploadUnsettled,
    )

    @Test
    fun `an unsettled finalize says nothing was delivered`() {
        val s = send(ambiguous = true, uploadUnsettled = true)
        assertEquals(R.string.inbox_sending_upload_unsettled, sendUncertaintyNoteRes(s))
        assertEquals(R.string.inbox_sending_discard_unsettled_body, sendDiscardBodyRes(s))
    }

    @Test
    fun `an unresolved create keeps the may-still-arrive copy`() {
        val s = send(ambiguous = true)
        assertEquals(R.string.inbox_sending_ambiguous, sendUncertaintyNoteRes(s))
        assertEquals(R.string.inbox_sending_discard_unknown_body, sendDiscardBodyRes(s))
    }

    @Test
    fun `an unresolved single-shot publish keeps its row note but not the may-arrive discard`() {
        val s = send(ambiguous = true, uploadUnknown = true, uploadUnsettled = true)
        assertEquals(R.string.inbox_sending_upload_unknown, sendUncertaintyNoteRes(s))
        assertEquals(R.string.inbox_sending_discard_unsettled_body, sendDiscardBodyRes(s))
    }

    @Test
    fun `settled rows keep their existing copy`() {
        assertNull(sendUncertaintyNoteRes(send()))
        assertEquals(R.string.inbox_sending_discard_body, sendDiscardBodyRes(send()))
        assertEquals(
            R.string.inbox_sending_cancel_delivery_body,
            sendDiscardBodyRes(send(phase = InboxSendStatus.Phase.DELIVERED)),
        )
    }

    @Test
    fun `server states use the closed native delivery vocabulary`() {
        assertEquals(R.string.inbox_sending_unknown, deliveryStateText(null))
        assertEquals(R.string.inbox_sending_queued, deliveryStateText(InboxTaskState.QUEUED))
        assertEquals(R.string.inbox_sending_notified, deliveryStateText(InboxTaskState.NOTIFIED))
        assertEquals(
            R.string.inbox_sending_awaiting_approval,
            deliveryStateText(InboxTaskState.ATTENTION_REQUIRED),
        )
        assertEquals(R.string.inbox_sending_receiving, deliveryStateText(InboxTaskState.DOWNLOADING))
        assertEquals(R.string.inbox_sending_verifying, deliveryStateText(InboxTaskState.VERIFYING))
        assertEquals(R.string.inbox_sending_saved, deliveryStateText(InboxTaskState.SAVED))
        assertEquals(R.string.inbox_sending_declined, deliveryStateText(InboxTaskState.REVOKED))
        assertEquals(
            R.string.inbox_sending_failed_retryable,
            deliveryStateText(InboxTaskState.FAILED_RETRYABLE),
        )
        assertEquals(
            R.string.inbox_sending_failed_terminal,
            deliveryStateText(InboxTaskState.FAILED_TERMINAL),
        )
        assertEquals(
            R.string.inbox_sending_declined,
            deliveryStateText(
                InboxTaskState.FAILED_TERMINAL,
                InboxTaskErrorCode.Device(InboxDeviceErrorCode.USER_DECLINED),
            ),
        )
    }

    @Test
    fun `cancel disappears once the receiver owns a claim`() {
        fun delivered(state: InboxTaskState?) = send(phase = InboxSendStatus.Phase.DELIVERED)
            .copy(taskId = "task-1", taskState = state)

        assertEquals(false, delivered(null).offersCancelDelivery)
        assertEquals(true, delivered(InboxTaskState.QUEUED).offersCancelDelivery)
        assertEquals(true, delivered(InboxTaskState.ATTENTION_REQUIRED).offersCancelDelivery)
        assertEquals(false, delivered(InboxTaskState.DOWNLOADING).offersCancelDelivery)
        assertEquals(false, delivered(InboxTaskState.VERIFYING).offersCancelDelivery)
        assertEquals(false, delivered(InboxTaskState.SAVED).offersCancelDelivery)
    }

    // ── the row's controls ──────────────────────────────────────────────────

    @Test
    fun `a staged job offers Send and a stopped one offers Try again`() {
        assertEquals(
            listOf(SendControl.SEND, SendControl.REMOVE),
            sendControls(send(phase = InboxSendStatus.Phase.STAGED)),
        )
        assertEquals(
            listOf(SendControl.RETRY, SendControl.REMOVE),
            sendControls(send(phase = InboxSendStatus.Phase.STOPPED, ambiguous = true)),
        )
        assertEquals(R.string.inbox_sending_send, SendControl.SEND.labelRes)
        assertEquals(R.string.inbox_sending_retry, SendControl.RETRY.labelRes)
    }

    @Test
    fun `controls keep their existing availability`() {
        assertEquals(
            listOf(SendControl.STOP, SendControl.REMOVE),
            sendControls(send(phase = InboxSendStatus.Phase.SENDING)),
        )
        // A repeat cannot answer an unresolved single-shot upload: only the way out.
        assertEquals(
            listOf(SendControl.REMOVE),
            sendControls(send(ambiguous = true, uploadUnknown = true)),
        )
        val delivered = send(phase = InboxSendStatus.Phase.DELIVERED).copy(taskId = "task-1")
        assertEquals(
            listOf(SendControl.CANCEL_DELIVERY),
            sendControls(delivered.copy(taskState = InboxTaskState.QUEUED)),
        )
        assertEquals(emptyList<SendControl>(), sendControls(delivered.copy(taskState = InboxTaskState.SAVED)))
    }

    @Test
    fun `every control on every row has its own tag`() {
        val tags = listOf("job-1", "job-2").flatMap { job ->
            listOf(SendControl.STOP, SendControl.SEND, SendControl.RETRY, SendControl.REMOVE)
                .map { sendControlTag(it, job) }
        }
        assertEquals(tags.size, tags.toSet().size)
        // The discard tag the acceptance suite already drives is unchanged.
        assertEquals("inbox-send-discard-job-1", sendControlTag(SendControl.REMOVE, "job-1"))
        assertEquals("inbox-send-discard-job-1", sendControlTag(SendControl.CANCEL_DELIVERY, "job-1"))
    }

    // ── the words, in both maintained languages ─────────────────────────────

    private fun strings(path: String): Map<String, String> {
        val nodes = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File(path)).getElementsByTagName("string")
        return (0 until nodes.length).associate {
            val e = nodes.item(it) as Element
            e.getAttribute("name") to e.textContent
        }
    }

    private val en by lazy { strings("src/main/res/values/inbox.xml") }
    private val zh by lazy { strings("src/main/res/values-zh-rCN/inbox.xml") }

    /** RelayiumKit's `InboxSendPresentation.label(.retry)` is `common.tryAgain`. */
    @Test
    fun `the retry control says Try again, not Send`() {
        assertEquals("Try again", en.getValue("inbox_sending_retry"))
        assertEquals("重试", zh.getValue("inbox_sending_retry"))
        assertEquals("Send", en.getValue("inbox_sending_send"))
        assertEquals("发送", zh.getValue("inbox_sending_send"))
    }

    /**
     * An unresolved create is unknown at relayium.com, not at the other device:
     * the copy must not say it may have "reached the other device".
     */
    @Test
    fun `the ambiguous note does not claim to know about the other device`() {
        val english = en.getValue("inbox_sending_ambiguous")
        assertFalse(english, english.contains("other device"))
        assertTrue(english, english.contains("handed over"))
        val chinese = zh.getValue("inbox_sending_ambiguous")
        assertFalse(chinese, chinese.contains("另一台设备"))
        assertTrue(chinese, chinese.contains("移交"))
    }

    /** Each control is spoken with the control, the device and the contents. */
    @Test
    fun `the spoken control name carries three parts in both languages`() {
        for (table in listOf(en, zh)) {
            val format = table.getValue("inbox_sending_control_spoken")
            for (n in 1..3) assertTrue(format, format.contains("%$n\$s"))
        }
    }
}
