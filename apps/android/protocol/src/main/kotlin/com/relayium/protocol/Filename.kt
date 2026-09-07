package com.relayium.protocol

/**
 * Sanitising peer-supplied names and materialising peer-supplied relative paths.
 *
 * A filename is UNTRUSTED input on every Relayium transport: the sender
 * constructs it freely, and it lands on the receive card the user makes a trust
 * decision from and then on disk. Two separate jobs live here and must not be
 * confused:
 *
 * 1. [safeDisplayName] / [sanitizeNames] — strip characters that let a name LIE
 *    about what it is. Byte-identical to `web/src/lib/filename.ts`, and pinned
 *    by the shared `sanitizedNames` fixture.
 * 2. [resolveRelativePath] — decide whether a manifest `path` may be
 *    materialised under a chosen destination tree AT ALL. That is a storage
 *    safety question the Web does not have in the same form (a browser download
 *    directory is not a tree the peer can walk out of), and it is answered by
 *    REFUSING rather than by rewriting.
 */
object Filename {

    /**
     * Every code point with the Unicode `Bidi_Control` property: U+061C (ALM),
     * U+200E/U+200F (LRM/RLM), U+202A-U+202E (LRE/RLE/PDF/LRO/RLO) and
     * U+2066-U+2069 (LRI/RLI/FSI/PDI).
     *
     * Built from numeric code points rather than typed, for the reason
     * `web/src/lib/filename.ts` gives: a literal RLO in this source would make
     * the FILE a Trojan-source vector, visually reordering the code after it —
     * which is the exact attack this function exists to defend the UI against.
     */
    private val BIDI_CONTROL: Set<Char> = intArrayOf(
        0x061C, 0x200E, 0x200F,
        0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
        0x2066, 0x2067, 0x2068, 0x2069,
    ).map { it.toChar() }.toSet()

    /** C0 (U+0000-U+001F), DEL (U+007F) and C1 (U+0080-U+009F). */
    private fun isControl(c: Char): Boolean =
        c.code <= 0x1F || (c.code in 0x7F..0x9F)

    /**
     * Strip bidirectional and control characters.
     *
     * A single RLO turns `evil<RLO>gnp.exe` into something that reads as
     * `evilexe.png` in every list that renders it — the classic executable
     * disguise. LRM/RLM only affect neighbouring neutral characters, and ALM is
     * weaker still, but none of the twelve has any legitimate use in a filename,
     * and stripping the whole property leaves no exception anyone has to explain.
     *
     * Called at the SINGLE decode entry point (manifest parsing), so the UI,
     * the transfer record and the on-disk name all get the sanitised value.
     * Scattering the call across render sites guarantees one is missed.
     */
    fun safeDisplayName(value: String): String {
        val out = StringBuilder(value.length)
        for (c in value) {
            if (c in BIDI_CONTROL || isControl(c)) continue
            out.append(c)
        }
        return out.toString()
    }

    /**
     * Sanitise a `/`-separated relative path SEGMENT BY SEGMENT.
     *
     * Per segment, not over the whole string, so the separators survive and the
     * directory structure is not flattened. `path` must be sanitised as well as
     * `name`: the card shows `name`, but the bytes land at `path`, and cleaning
     * only the former puts a disguised name on disk while showing a clean one.
     */
    fun sanitizePath(value: String): String =
        value.split('/').joinToString("/") { safeDisplayName(it) }

    fun sanitizeNames(files: List<FileMeta>): List<FileMeta> = files.map { file ->
        file.copy(
            name = safeDisplayName(file.name),
            path = file.path?.let(::sanitizePath),
        )
    }

    // ── materialising a path under a chosen destination ─────────────────────

    sealed interface PathVerdict {
        /** Safe to create, as this exact sequence of directory names plus a leaf. */
        data class Accept(val segments: List<String>, val leaf: String) : PathVerdict
        /** Refused, with a reason a human can act on. */
        data class Refuse(val reason: Reason) : PathVerdict

        enum class Reason {
            ABSOLUTE,
            PARENT_TRAVERSAL,
            CURRENT_DIRECTORY,
            EMPTY_SEGMENT,
            BACKSLASH,
            RESERVED,
            TOO_DEEP,
            EMPTY_AFTER_SANITISING,
        }
    }

    /** Deep enough for any real folder send, shallow enough to bound the number
     *  of directory documents one batch can make a receiver create. */
    const val MAX_PATH_DEPTH = 32

    /**
     * May this manifest entry be materialised beneath the user's chosen tree?
     *
     * REFUSE, never rewrite. A path that a receiver "cleans" into something else
     * silently changes where a file lands and can collide two entries onto one
     * name; the brief's rule is that a folder send is either materialised safely
     * or clearly rejected before the batch is accepted, never silently
     * flattened.
     *
     * What is refused, and why each one matters on Android specifically:
     *
     * - **absolute** (`/etc/x`) — a leading separator makes the whole path
     *   meaningless relative to a SAF tree, and a naive join escapes it.
     * - **`..`** — the traversal. Even under SAF, where a document tree is not a
     *   filesystem path, a `..` segment is never a name the sender legitimately
     *   meant.
     * - **`.`** — no legitimate meaning, and it collapses two distinct paths onto
     *   one destination.
     * - **empty segment** (`a//b`, trailing `/`) — ambiguous, and produces a
     *   directory with no name.
     * - **backslash** — Windows separators are NOT separators here, so a peer
     *   could otherwise smuggle a second level past a `/`-only check. Refusing
     *   is safer than reinterpreting, because reinterpreting is exactly how the
     *   two sides come to disagree about the destination.
     * - **`.` or `..` as the leaf**, and Windows reserved device names — a
     *   receiver may be exporting to a shared or synced tree.
     * - **too deep** — bounds the directory documents one batch can force.
     *
     * Sanitising runs FIRST, so a name that is only bidi/control characters
     * refuses as empty rather than creating an unnameable document.
     */
    fun resolveRelativePath(rawPath: String?, rawName: String): PathVerdict {
        val leaf = safeDisplayName(rawName)
        if (leaf.isEmpty()) return PathVerdict.Refuse(PathVerdict.Reason.EMPTY_AFTER_SANITISING)
        if (leaf == "." || leaf == "..") return PathVerdict.Refuse(PathVerdict.Reason.CURRENT_DIRECTORY)
        if (leaf.contains('/')) return PathVerdict.Refuse(PathVerdict.Reason.EMPTY_SEGMENT)
        if (leaf.contains('\\')) return PathVerdict.Refuse(PathVerdict.Reason.BACKSLASH)
        if (isReserved(leaf)) return PathVerdict.Refuse(PathVerdict.Reason.RESERVED)

        val path = rawPath?.takeIf { it.isNotEmpty() }
            ?: return PathVerdict.Accept(emptyList(), leaf)

        if (path.startsWith("/")) return PathVerdict.Refuse(PathVerdict.Reason.ABSOLUTE)
        if (path.contains('\\')) return PathVerdict.Refuse(PathVerdict.Reason.BACKSLASH)

        // The last component of `path` is the file itself; the directories are
        // everything before it. A `path` whose leaf disagrees with `name` is not
        // an error — the Web sends `{name: "c.txt", path: "sub/c.txt"}` — so the
        // leaf comes from `name` and the directories from `path`.
        val parts = path.split('/')
        val directories = parts.dropLast(1)
        if (directories.size > MAX_PATH_DEPTH) return PathVerdict.Refuse(PathVerdict.Reason.TOO_DEEP)

        val segments = ArrayList<String>(directories.size)
        for (raw in directories) {
            if (raw.isEmpty()) return PathVerdict.Refuse(PathVerdict.Reason.EMPTY_SEGMENT)
            if (raw == "..") return PathVerdict.Refuse(PathVerdict.Reason.PARENT_TRAVERSAL)
            if (raw == ".") return PathVerdict.Refuse(PathVerdict.Reason.CURRENT_DIRECTORY)
            val clean = safeDisplayName(raw)
            if (clean.isEmpty()) return PathVerdict.Refuse(PathVerdict.Reason.EMPTY_AFTER_SANITISING)
            if (clean == "." || clean == "..") return PathVerdict.Refuse(PathVerdict.Reason.PARENT_TRAVERSAL)
            if (isReserved(clean)) return PathVerdict.Refuse(PathVerdict.Reason.RESERVED)
            segments.add(clean)
        }
        return PathVerdict.Accept(segments, leaf)
    }

    /**
     * Windows device names, refused as a whole component.
     *
     * Android does not have them, but a SAF destination can be a synced or
     * network-backed provider whose far end does, and a file that vanishes on
     * sync is a worse outcome than a refusal the user can see.
     */
    private val RESERVED = setOf(
        "con", "prn", "aux", "nul",
        "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    )

    private fun isReserved(component: String): Boolean {
        val stem = component.substringBefore('.').lowercase()
        return stem in RESERVED
    }
}
