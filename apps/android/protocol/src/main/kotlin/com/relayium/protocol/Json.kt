package com.relayium.protocol

/**
 * A small, strict JSON reader and a writer that renders exactly what
 * JavaScript's `JSON.stringify` renders.
 *
 * ## Why this is hand-written rather than a library
 *
 * Two of this protocol's byte strings are MAC'd (`relayium-link-v1.md` section
 * 4.4), so their bytes are the contract, not their meaning. A general-purpose
 * JSON library gives no guarantee about key order, and several differ from
 * `JSON.stringify` on escaping — a tag over an escaped DEL where the peer signed
 * a raw one verifies on neither side. Swift's port hand-rolls the same
 * serializer for the same reason, and its comment says so.
 *
 * So: insertion-ordered objects, integral numbers rendered without a fraction,
 * and an escaper that matches `JSON.stringify` character for character.
 *
 * ## What the reader refuses
 *
 * Everything it does not understand. It parses one value, skips whitespace, and
 * requires end-of-input; trailing commas, comments, `NaN`, `Infinity`, leading
 * `+`, leading zeros, single quotes and unescaped control characters inside a
 * string are all failures. This runs on bytes a peer chose, so "lenient" here is
 * an attack surface, not a convenience.
 */
sealed interface Json {

    data object Null : Json

    @JvmInline
    value class Bool(val value: Boolean) : Json

    /**
     * JSON has one number type and JavaScript reads it as a double. Storing the
     * double is what keeps this side's idea of `size` identical to the browser's,
     * including the point at which an integer stops being exact.
     */
    @JvmInline
    value class Num(val value: Double) : Json

    @JvmInline
    value class Str(val value: String) : Json

    @JvmInline
    value class Arr(val items: List<Json>) : Json

    /** Insertion-ordered, because for the MAC'd payloads the order IS the value. */
    class Obj(val entries: LinkedHashMap<String, Json>) : Json {
        operator fun get(key: String): Json? = entries[key]
        val keys: Set<String> get() = entries.keys
        override fun equals(other: Any?) = other is Obj && other.entries == entries
        override fun hashCode() = entries.hashCode()
        override fun toString() = stringify(this)
    }

    companion object {

        fun obj(vararg pairs: Pair<String, Json>): Obj {
            val map = LinkedHashMap<String, Json>(pairs.size)
            for ((k, v) in pairs) map[k] = v
            return Obj(map)
        }

        fun of(value: String): Str = Str(value)
        fun of(value: Boolean): Bool = Bool(value)
        fun of(value: Long): Num = Num(value.toDouble())
        fun of(value: Int): Num = Num(value.toDouble())
        fun arr(items: List<Json>): Arr = Arr(items)

        /** Parse, or throw [JsonException]. */
        fun parse(text: String): Json = Parser(text).parseWhole()

        /** Parse, or null — for the many places where malformed peer input must
         *  be dropped rather than raised. */
        fun parseOrNull(text: String): Json? = try {
            parse(text)
        } catch (_: JsonException) {
            null
        }

        /**
         * Render, byte-identically to `JSON.stringify(value)`.
         *
         * No spaces, no newlines, no sorting: objects come out in insertion
         * order, which for `authPayload` and `linkLeavePayload` is the declared
         * field order the tag covers.
         */
        fun stringify(value: Json): String = StringBuilder().also { write(value, it) }.toString()

        private fun write(value: Json, out: StringBuilder) {
            when (value) {
                is Null -> out.append("null")
                is Bool -> out.append(if (value.value) "true" else "false")
                is Num -> out.append(number(value.value))
                is Str -> escape(value.value, out)
                is Arr -> {
                    out.append('[')
                    value.items.forEachIndexed { i, item ->
                        if (i > 0) out.append(',')
                        write(item, out)
                    }
                    out.append(']')
                }
                is Obj -> {
                    out.append('{')
                    var first = true
                    for ((key, item) in value.entries) {
                        if (!first) out.append(',')
                        first = false
                        escape(key, out)
                        out.append(':')
                        write(item, out)
                    }
                    out.append('}')
                }
            }
        }

        /**
         * JavaScript's number-to-string, for the range this protocol emits.
         *
         * Every number on this wire is a non-negative integer — a file size, an
         * index, an offset, an m-line index — and JavaScript renders an integral
         * double with no fraction and no exponent up to 1e21. Rendering `0.0` as
         * Kotlin does, `"0.0"`, would change the bytes a tag covers.
         *
         * A non-integral or out-of-range value is a caller bug rather than
         * something to render approximately, so it is refused: this protocol has
         * no field that carries one, and silently emitting `1.0E21` would be a
         * string no peer can parse back to the same value.
         */
        private fun number(value: Double): String {
            require(value.isFinite()) { "JSON has no representation for $value" }
            val asLong = value.toLong()
            require(asLong.toDouble() == value && kotlin.math.abs(value) < 1e21) {
                "this protocol emits only integral JSON numbers; got $value"
            }
            return asLong.toString()
        }

        /**
         * `JSON.stringify`'s string escaping, exactly.
         *
         * Escaped: quote, backslash, and U+0008/U+0009/U+000A/U+000C/U+000D as
         * the five short forms. Every other code unit below U+0020 as
         * lower-case `\u00xx`. Unpaired surrogates as `\udxxx` — the
         * "well-formed JSON.stringify" rule, which is what makes a MAC over a
         * relay-supplied string reproducible.
         *
         * Emitted RAW, deliberately: U+007F DELETE, the C1 range, U+2028 LINE
         * SEPARATOR, U+2029 PARAGRAPH SEPARATOR, and every astral character as
         * its own UTF-16 pair (which UTF-8 encoding then turns into four bytes,
         * never into two escapes). `relayium-link-v1.md` section 4.4 lists these
         * and `link.linkLeavePayload` in the shared fixture pins them.
         */
        fun escape(value: String, out: StringBuilder) {
            out.append('"')
            var i = 0
            while (i < value.length) {
                val c = value[i]
                when {
                    c == '"' -> out.append("\\\"")
                    c == '\\' -> out.append("\\\\")
                    c == '\b' -> out.append("\\b")
                    c == '\t' -> out.append("\\t")
                    c == '\n' -> out.append("\\n")
                    // Kotlin has no `\f` escape; U+000C written as a code point.
                    c == '\u000C' -> out.append("\\f")
                    c == '\r' -> out.append("\\r")
                    c < ' ' -> out.append(unicodeEscape(c.code))
                    Character.isHighSurrogate(c) -> {
                        val paired = i + 1 < value.length && Character.isLowSurrogate(value[i + 1])
                        if (paired) {
                            out.append(c).append(value[i + 1])
                            i++
                        } else {
                            out.append(unicodeEscape(c.code))
                        }
                    }
                    Character.isLowSurrogate(c) -> out.append(unicodeEscape(c.code))
                    else -> out.append(c)
                }
                i++
            }
            out.append('"')
        }

        private fun unicodeEscape(code: Int): String {
            val hex = Integer.toHexString(code)
            return "\\u" + "0".repeat(4 - hex.length) + hex
        }
    }
}

class JsonException(message: String) : RuntimeException(message)

/** Recursive-descent, with a bounded depth so a peer cannot blow the stack with
 *  a few kilobytes of nested brackets. */
private class Parser(private val text: String) {

    private var at = 0
    private var depth = 0

    fun parseWhole(): Json {
        val value = parseValue()
        skipWhitespace()
        if (at != text.length) fail("trailing input at $at")
        return value
    }

    private fun parseValue(): Json {
        if (depth > MAX_DEPTH) fail("nesting deeper than $MAX_DEPTH")
        return when (peek()) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> Json.Str(parseString())
            't' -> literal("true", Json.Bool(true))
            'f' -> literal("false", Json.Bool(false))
            'n' -> literal("null", Json.Null)
            else -> parseNumber()
        }
    }

    private fun parseObject(): Json {
        expect('{')
        depth++
        val entries = LinkedHashMap<String, Json>()
        if (peek() == '}') { at++; depth--; return Json.Obj(entries) }
        while (true) {
            if (peek() != '"') fail("object key must be a string, at $at")
            val key = parseString()
            expect(':')
            // Last one wins, matching JavaScript. Every EXACT-shape check in
            // this protocol counts keys after parsing, so a duplicate cannot
            // smuggle a field past an allow-list.
            entries[key] = parseValue()
            when (next()) {
                ',' -> continue
                '}' -> { depth--; return Json.Obj(entries) }
                else -> fail("expected , or } at ${at - 1}")
            }
        }
    }

    private fun parseArray(): Json {
        expect('[')
        depth++
        val items = ArrayList<Json>()
        if (peek() == ']') { at++; depth--; return Json.Arr(items) }
        while (true) {
            items.add(parseValue())
            when (next()) {
                ',' -> continue
                ']' -> { depth--; return Json.Arr(items) }
                else -> fail("expected , or ] at ${at - 1}")
            }
        }
    }

    private fun parseString(): String {
        expect('"')
        val out = StringBuilder()
        while (true) {
            if (at >= text.length) fail("unterminated string")
            val c = text[at++]
            when {
                c == '"' -> return out.toString()
                c == '\\' -> out.append(parseEscape())
                // An unescaped control character is invalid JSON. Accepting it
                // would make two encoders of the same value disagree, which for
                // a MAC'd payload is a verification failure nobody can debug.
                c < ' ' -> fail("unescaped control character U+${Integer.toHexString(c.code)} in string")
                else -> out.append(c)
            }
        }
    }

    private fun parseEscape(): Char {
        if (at >= text.length) fail("unterminated escape")
        return when (val c = text[at++]) {
            '"' -> '"'
            '\\' -> '\\'
            '/' -> '/'
            'b' -> '\b'
            'f' -> '\u000C'
            'n' -> '\n'
            'r' -> '\r'
            't' -> '\t'
            'u' -> {
                if (at + 4 > text.length) fail("truncated unicode escape")
                // ASCII hex digits ONLY, decoded by hand. Kotlin's
                // digitToIntOrNull(16)/toInt(16) accept any Unicode digit —
                // fullwidth Ｆ, Arabic-Indic ٤ — which JSON's grammar does not,
                // and this parser runs on peer-controlled MAC'd payloads where
                // two parsers disagreeing about one document is the failure
                // mode. A lone surrogate is deliberately still allowed through:
                // it is representable in a Kotlin String, JavaScript emits one
                // for relay-supplied input, and strict UTF-8 decoding refuses it
                // where bytes are the contract.
                var code = 0
                repeat(4) {
                    val c = text[at++]
                    val digit = when (c) {
                        in '0'..'9' -> c - '0'
                        in 'a'..'f' -> c - 'a' + 10
                        in 'A'..'F' -> c - 'A' + 10
                        else -> fail("bad unicode escape")
                    }
                    code = (code shl 4) or digit
                }
                code.toChar()
            }
            else -> fail("unknown escape")
        }
    }

    private fun parseNumber(): Json {
        skipWhitespace()
        val start = at
        if (at < text.length && text[at] == '-') at++
        // No leading zeros, no leading `+`, no bare `.5` — JSON's grammar, not
        // Kotlin's `toDouble`, which accepts all three.
        if (at >= text.length) fail("truncated number at $start")
        if (text[at] == '0') {
            at++
        } else if (text[at] in '1'..'9') {
            while (at < text.length && text[at].isDigit()) at++
        } else {
            fail("not a number at $at")
        }
        if (at < text.length && text[at] == '.') {
            at++
            if (at >= text.length || !text[at].isDigit()) fail("truncated fraction at $at")
            while (at < text.length && text[at].isDigit()) at++
        }
        if (at < text.length && (text[at] == 'e' || text[at] == 'E')) {
            at++
            if (at < text.length && (text[at] == '+' || text[at] == '-')) at++
            if (at >= text.length || !text[at].isDigit()) fail("truncated exponent at $at")
            while (at < text.length && text[at].isDigit()) at++
        }
        val raw = text.substring(start, at)
        val value = raw.toDoubleOrNull() ?: fail("unreadable number")
        if (!value.isFinite()) fail("number is not finite")
        return Json.Num(value)
    }

    private fun literal(word: String, value: Json): Json {
        if (!text.startsWith(word, at)) fail("expected $word at $at")
        at += word.length
        return value
    }

    private fun skipWhitespace() {
        // JSON's four, and only those. A vertical tab or a form feed between
        // tokens is not whitespace here, exactly as in the specification.
        while (at < text.length &&
            (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r')
        ) {
            at++
        }
    }

    private fun peek(): Char {
        skipWhitespace()
        if (at >= text.length) fail("unexpected end of input")
        return text[at]
    }

    private fun next(): Char {
        skipWhitespace()
        if (at >= text.length) fail("unexpected end of input")
        return text[at++]
    }

    private fun expect(c: Char) {
        if (next() != c) fail("expected $c at ${at - 1}")
    }

    private fun fail(message: String): Nothing = throw JsonException("relayium json: $message")

    private companion object {
        /** Deeper than any document this protocol defines, shallow enough that a
         *  hostile signal cannot reach the JVM's stack limit. */
        const val MAX_DEPTH = 32
    }
}
