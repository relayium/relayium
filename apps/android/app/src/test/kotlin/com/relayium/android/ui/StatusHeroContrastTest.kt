package com.relayium.android.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import kotlin.math.pow
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The status head's wash is a new surface for prose, so every role drawn on it is
 * measured on both ends of it in both schemes — against the theme's real values
 * and the hero's real tint function, so darkening the tint or lightening a role
 * fails here rather than in a screenshot.
 */
class StatusHeroContrastTest {

    private fun channel(v: Float): Double {
        val c = v.toDouble()
        return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
    }

    private fun luminance(c: Color) =
        0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue)

    private fun ratio(a: Color, b: Color): Double {
        val (x, y) = luminance(a) to luminance(b)
        return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
    }

    private fun check(name: String, scheme: ColorScheme) {
        val base = scheme.surfaceContainerLow
        val tint = heroTint(scheme.primary, base)
        assertTrue("$name hero tint must be opaque", tint.alpha == 1f)
        for ((surface, background) in listOf("tint" to tint, "card" to base)) {
            for ((role, text, minimum) in listOf(
                Triple("onSurface", scheme.onSurface, 4.5),
                Triple("onSurfaceVariant", scheme.onSurfaceVariant, 4.5),
                // Check now's label and the radar ring are the accent TEXT role.
                Triple("secondary", scheme.secondary, 4.5),
            )) {
                val measured = ratio(text, background)
                assertTrue(
                    "$name $role measures ${"%.2f".format(measured)}:1 on the hero $surface",
                    measured >= minimum,
                )
            }
        }
        // The lit radar's glyph: white on the action fill.
        assertTrue("$name radar glyph", ratio(scheme.onPrimary, scheme.primary) >= 4.5)
        // The wash must actually be a wash, or the hero is just another card.
        assertTrue("$name tint is indistinguishable from the card", ratio(tint, base) > 1.05)
    }

    @Test
    fun `prose on the status head clears the line in light`() = check("Light", LightColors)

    @Test
    fun `prose on the status head clears the line in dark`() = check("Dark", DarkColors)
}
