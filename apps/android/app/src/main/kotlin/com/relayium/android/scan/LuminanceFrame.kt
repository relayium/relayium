package com.relayium.android.scan

/**
 * One camera frame's brightness, packed tightly and the right way up.
 *
 * A decoder wants `width * height` bytes where pixel `(x, y)` is at
 * `y * width + x`. A camera hands over something else: a Y plane with a row
 * stride that is usually larger than the width (hardware aligns rows), a pixel
 * stride that is not always 1 (some devices interleave), an analysis crop
 * rectangle that is not always the whole buffer, and a rotation that says which
 * way up the sensor was. Handing that buffer to a decoder unchanged reads
 * padding as image data, and the QR code that a person is holding perfectly
 * still simply never decodes.
 *
 * This type is the packed result, and [of] is the only way to get one — so a
 * frame that reached a decoder has already had its geometry checked against the
 * bytes that actually arrived.
 */
class LuminanceFrame private constructor(
    val bytes: ByteArray,
    val width: Int,
    val height: Int,
) {
    override fun toString(): String = "LuminanceFrame(${width}x$height)"

    companion object {

        /**
         * The largest frame this will normalise, per side and in total.
         *
         * An analysis stream is typically 640x480 or 1280x720. The per-side
         * bound refuses absurd geometry outright, and the total bounds the
         * WORK: normalising is a per-pixel copy on a frame-rate path, and a
         * buffer's own header is not a reason to spend an arbitrary amount of
         * time on one frame. 4K is far above any analysis resolution and far
         * below anything that would stall the pipeline.
         */
        const val MAX_SIDE = 4096
        const val MAX_PIXELS = 3840 * 2160

        /**
         * Pack a Y plane, cropping and rotating it, or null when the numbers do
         * not describe an image that is really there.
         *
         * Null rather than an exception, and null rather than a best effort:
         * this runs on every frame, the values come from another process, and
         * the honest answer to a buffer that is shorter than its own geometry
         * claims is "there is nothing here to read".
         *
         * @param rotationDegrees clockwise rotation to apply so the result is
         *   upright, as `ImageInfo.rotationDegrees` reports it. QR detection
         *   tolerates rotation on its own, so this is not what makes decoding
         *   work — it is what makes the crop mean the same thing on a device
         *   held sideways.
         */
        fun of(
            plane: ByteArray,
            rowStride: Int,
            pixelStride: Int,
            cropLeft: Int,
            cropTop: Int,
            cropWidth: Int,
            cropHeight: Int,
            rotationDegrees: Int,
        ): LuminanceFrame? {
            if (rotationDegrees !in ROTATIONS) return null
            if (rowStride <= 0 || pixelStride <= 0) return null
            if (cropLeft < 0 || cropTop < 0 || cropWidth <= 0 || cropHeight <= 0) return null
            if (cropWidth > MAX_SIDE || cropHeight > MAX_SIDE) return null
            if (cropWidth.toLong() * cropHeight.toLong() > MAX_PIXELS) return null

            // **Widened BEFORE the arithmetic, not after it.** Every operand
            // here is a number from another process. Adding two `Int`s and
            // widening the SUM is the bug this shape exists to avoid: a
            // `cropLeft` near `Int.MAX_VALUE` with a two-pixel crop wraps to a
            // large negative, which sails under the length check below and then
            // indexes the array negatively — an exception on the camera thread,
            // reachable by a producer that simply lies in its header.
            val left = cropLeft.toLong()
            val top = cropTop.toLong()
            val lastCol = left + cropWidth.toLong() - 1
            val lastRow = top + cropHeight.toLong() - 1

            // The selected columns must lie inside ONE row. A row occupies
            // `rowStride` bytes, so a crop whose last column reaches past it is
            // not reading the right-hand edge of the image — it is reading the
            // padding, or the first pixels of the next row, and the image it
            // produces is sheared. Refusing says so; clamping would hand the
            // decoder a plausible-looking picture of the wrong thing.
            if (lastCol * pixelStride.toLong() >= rowStride.toLong()) return null

            // The last byte this would read, checked BEFORE reading the first.
            // A plane shorter than its declared geometry is the shape a broken
            // or hostile producer sends, and finding out per pixel would be an
            // exception on the camera thread.
            val lastIndex = lastRow * rowStride.toLong() + lastCol * pixelStride.toLong()
            if (lastIndex >= plane.size) return null
            // Every index the loop computes is non-negative and no larger than
            // `lastIndex`, which is now known to fit an array length — so the
            // `Int` arithmetic below cannot overflow either.

            val rotated = rotationDegrees == 90 || rotationDegrees == 270
            val outWidth = if (rotated) cropHeight else cropWidth
            val outHeight = if (rotated) cropWidth else cropHeight
            val out = ByteArray(outWidth * outHeight)

            // Walked by DESTINATION, so every output byte is written exactly
            // once and no rotation case can leave a hole.
            for (dy in 0 until outHeight) {
                for (dx in 0 until outWidth) {
                    val sx: Int
                    val sy: Int
                    when (rotationDegrees) {
                        0 -> { sx = dx; sy = dy }
                        90 -> { sx = dy; sy = cropHeight - 1 - dx }
                        180 -> { sx = cropWidth - 1 - dx; sy = cropHeight - 1 - dy }
                        else -> { sx = cropWidth - 1 - dy; sy = dx }
                    }
                    out[dy * outWidth + dx] =
                        plane[(cropTop + sy) * rowStride + (cropLeft + sx) * pixelStride]
                }
            }
            return LuminanceFrame(out, outWidth, outHeight)
        }

        private val ROTATIONS = setOf(0, 90, 180, 270)
    }
}
