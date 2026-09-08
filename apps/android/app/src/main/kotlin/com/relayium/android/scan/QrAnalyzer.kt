package com.relayium.android.scan

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.relayium.android.ingress.IngressRequest

/**
 * One analysis frame: read it, close it, and — rarely — report a pairing code.
 *
 * ## Closing is the invariant, not a step
 *
 * `ImageAnalysis` hands out a fixed number of buffers and will not deliver
 * another frame until this one is closed. A path that returns without closing
 * does not throw and does not log; the viewfinder simply freezes, which reads
 * as "the scanner is broken" and is among the easiest bugs to ship. So the
 * close is in a `finally` around everything, and every branch below — refused
 * geometry, no code, a decoded code, a thrown decoder, a closed session —
 * leaves through it.
 *
 * ## What it does not do
 *
 * It does not touch UI state, does not keep the frame, and does not remember
 * what it decoded. The bytes are a copy of a camera buffer that is about to be
 * recycled, and the payload goes straight to [ScanSession], which answers with
 * a code or with nothing. Nothing here logs: the only thing worth logging would
 * be the payload, and the payload is the pairing code.
 */
class QrAnalyzer(
    private val session: ScanSession,
    /** The generation this analyzer was created for. A rebind builds a new
     *  analyzer rather than mutating this one, so a frame already in flight
     *  cannot be re-labelled as belonging to the run that replaced it. */
    private val generation: Long,
    private val trustedOrigin: String,
    /**
     * Called on the CAMERA executor with a result the session accepted.
     *
     * Moving it to the main thread and re-checking the fence there is
     * [ScannerController]'s job, not this class's: "is the user still looking
     * at this" is a main-thread fact, and asking it here would answer it in the
     * wrong place and at the wrong time.
     */
    private val onAccepted: (generation: Long, IngressRequest.PrefillCode) -> Unit,
) : ImageAnalysis.Analyzer {

    override fun analyze(image: ImageProxy) {
        try {
            // Cheap, and first: a run that is already spent or closed should
            // not pay for a decode per frame while the pipeline winds down.
            if (!session.isOpen) return
            val frame = frameOf(image) ?: return
            val payload = QrCodec.decode(frame) ?: return
            val accepted = session.offer(generation, payload, trustedOrigin) ?: return
            onAccepted(generation, accepted)
        } catch (_: RuntimeException) {
            // A frame is not worth an app. `ImageProxy` accessors throw when
            // the image is closed underneath the analyzer during teardown, and
            // the decoder is being handed pixels chosen by whoever printed the
            // poster.
        } finally {
            image.close()
        }
    }

    /**
     * The Y plane, packed and upright.
     *
     * `YUV_420_888` is the analysis format and its plane 0 IS the luminance,
     * which is all a QR decoder wants — so nothing here converts colour. The
     * crop rectangle and the rotation are read from the frame rather than from
     * remembered display state, because both change while the pipeline runs.
     */
    private fun frameOf(image: ImageProxy): LuminanceFrame? {
        val plane = image.planes.firstOrNull() ?: return null
        val crop = image.cropRect
        // **Bounds BEFORE the copy.** The allocation is the expensive part and
        // it was being made from a number in the frame's own header — so a
        // buffer claiming to be enormous would be copied in full and only then
        // refused by the packer. Asking about the geometry first costs
        // comparisons, and the packer re-checks everything anyway; this is the
        // bound on the WORK, not the bound on correctness.
        if (crop.width() <= 0 || crop.height() <= 0) return null
        if (crop.width() > LuminanceFrame.MAX_SIDE || crop.height() > LuminanceFrame.MAX_SIDE) return null
        if (crop.width().toLong() * crop.height().toLong() > LuminanceFrame.MAX_PIXELS) return null

        // `duplicate`, so this read does not consume the position of a buffer
        // the pipeline owns. `ImageProxy` buffers are reused, and a partially
        // drained one hands the NEXT reader a shorter image than it asked for
        // — a frame that decodes to nothing, intermittently.
        val buffer = plane.buffer.duplicate()
        val available = buffer.remaining()
        if (available <= 0 || available > MAX_PLANE_BYTES) return null

        val bytes = ByteArray(available)
        buffer.get(bytes)
        return LuminanceFrame.of(
            plane = bytes,
            rowStride = plane.rowStride,
            pixelStride = plane.pixelStride,
            cropLeft = crop.left,
            cropTop = crop.top,
            cropWidth = crop.width(),
            cropHeight = crop.height(),
            rotationDegrees = image.imageInfo.rotationDegrees,
        )
    }

    private companion object {
        /**
         * The largest Y plane worth copying.
         *
         * A plane is `rowStride * height`, and a stride is padding above the
         * width — so the ceiling is the pixel bound with generous room for
         * alignment, rather than the pixel bound exactly.
         */
        const val MAX_PLANE_BYTES = LuminanceFrame.MAX_PIXELS * 2
    }
}
