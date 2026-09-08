package com.relayium.android.scan

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.relayium.android.R
import com.relayium.protocol.PairCode
import kotlin.math.floor

/**
 * The pairing code as a square the other device can point a camera at.
 *
 * ## Black and white, not theme colours
 *
 * A QR code is read by a machine that is looking for contrast, and a "dark"
 * module drawn in a dark theme's surface colour against that theme's background
 * is a code that photographs as grey on grey. So the card paints its own white
 * field and black modules in both themes; it is a picture of a code, not a
 * surface that follows the palette.
 *
 * ## It shows nothing rather than something misleading
 *
 * There is no placeholder square, no blurred code and no "expired" watermark
 * over a still-scannable image. [PairingQr] answers null when there is no
 * usable code, and null renders as the honest sentence instead — a photograph
 * of a stale square would be scanned somewhere else, minutes later, and fail on
 * the device that did nothing wrong.
 */
@Composable
fun PairingQrCard(
    origin: String,
    code: PairCode?,
    expiresAtEpochSeconds: Long,
    nowEpochSeconds: Long,
    modifier: Modifier = Modifier,
) {
    // Keyed on everything that can change the answer, so the encode does not
    // run on every recomposition — a countdown ticking beside this one
    // recomposes it once a second.
    val matrix = remember(origin, code?.digits, expiresAtEpochSeconds, nowEpochSeconds) {
        PairingQr.matrix(origin, code, expiresAtEpochSeconds, nowEpochSeconds)
    }
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (matrix == null) {
            Text(
                text = stringResource(R.string.qr_expired),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }
        Text(
            text = stringResource(R.string.qr_title),
            style = MaterialTheme.typography.titleSmall,
        )
        val description = stringResource(R.string.qr_description)
        Canvas(
            modifier = Modifier
                // Bounded so it stays scannable on a 320dp screen and does not
                // become a wall on a tablet.
                .sizeIn(minWidth = 160.dp, maxWidth = 280.dp)
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(RoundedCornerShape(8.dp))
                .background(Color.White)
                .padding(4.dp)
                .semantics { contentDescription = description },
        ) {
            // Modules are drawn at a WHOLE number of pixels and the grid is
            // centred in what is left over. A fractional module size makes
            // neighbouring squares round to different widths, and a decoder
            // reading the timing pattern sees a code that drifts.
            val module = floor(size.minDimension / matrix.size)
            if (module < 1f) return@Canvas
            val drawn = module * matrix.size
            val offsetX = (size.width - drawn) / 2f
            val offsetY = (size.height - drawn) / 2f
            for (y in 0 until matrix.size) {
                for (x in 0 until matrix.size) {
                    if (!matrix.isDark(x, y)) continue
                    drawRect(
                        color = Color.Black,
                        topLeft = androidx.compose.ui.geometry.Offset(
                            offsetX + x * module,
                            offsetY + y * module,
                        ),
                        size = androidx.compose.ui.geometry.Size(module, module),
                    )
                }
            }
        }
    }
}
