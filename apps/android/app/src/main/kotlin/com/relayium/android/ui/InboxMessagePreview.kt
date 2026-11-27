package com.relayium.android.ui

/** A display-only prefix. A null result means the message needs no disclosure. */
internal fun collapsedMessagePreview(text: String): String? {
    var index = 0
    var count = 0
    var lines = 1
    var previousWasCR = false
    while (index < text.length) {
        val point = text.codePointAt(index)
        val startsLine = (point in 0x0A..0x0D || point == 0x85 || point == 0x2028 || point == 0x2029) &&
            !(previousWasCR && point == 0x0A)
        if (count == 160 || (startsLine && lines == 4)) return text.substring(0, index) + "…"
        if (startsLine) lines++
        previousWasCR = point == 0x0D
        count++
        index += Character.charCount(point)
    }
    return null
}
