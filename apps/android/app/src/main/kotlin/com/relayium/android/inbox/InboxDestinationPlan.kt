package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestItem
import com.relayium.protocol.inbox.InboxManifestKind
import java.io.File
import java.util.Locale

/**
 * Turning a decrypted, sender-controlled manifest into the exact set of local
 * paths one delivery is allowed to create.
 *
 * AEAD proves the manifest was written by whoever holds the content key. It does
 * NOT make the names inside it safe: the sender is another machine, possibly
 * compromised, and a name is an INSTRUCTION to this filesystem. Everything below
 * treats a manifest name as hostile input.
 *
 * The plan is computed ONCE, before anything is downloaded, and journalled
 * before anything is committed. That ordering is what makes a crash resumable:
 * the set of destinations a task may ever create is fixed and durable before the
 * first one exists, so recovery never re-derives it from a directory that has
 * since changed — which would walk the collision suffix forward and deliver the
 * same file twice.
 *
 * ## Why names are REFUSED rather than repaired
 *
 * The app's interactive download path sanitises a name and writes it, which is
 * right for a transfer a person is watching: a repaired name beats a refused
 * one. A Device Inbox delivery is unattended, so a repaired name is a file the
 * user never approved appearing under a name nobody chose. Every rule below
 * therefore refuses.
 */

/** One manifest entry bound to the one path it may ever create.
 *
 *  [name] and [destination] are plaintext-derived and therefore LOCAL ONLY: they
 *  live in the journal so a crash can resume, and never reach central or a log. */
data class InboxPlanEntry(
    val index: Int,
    val name: String,
    val size: Long,
    /** Absolute path as a STRING, because it is journalled and compared
     *  byte-for-byte across runs. */
    val destination: String,
)

/** Why a manifest cannot be materialised here. Carries the INDEX, never the name. */
class InboxPlanException(val reason: Reason, val index: Int) :
    RuntimeException("relayium inbox plan: $reason at $index") {

    enum class Reason {
        /** A name this device refuses to create. Terminal: the same bytes are
         *  refused the same way on every attempt. */
        UNSAFE_NAME,

        /**
         * Two entries resolve to one destination, including differing only by
         * case.
         *
         * A REFUSAL rather than a rename: two entries that differ only by case
         * are the sender describing two files, and quietly renaming one would
         * hide that this receiver cannot represent what was sent.
         */
        DUPLICATE_DESTINATION,

        /** Every deterministic candidate name is taken. A person has to look. */
        NO_FREE_NAME,

        /** The manifest describes a message, which has no destination at all. */
        NOT_A_FILE_MANIFEST,
    }
}

object InboxDestinationPlan {

    /** Bounds directory nesting created for one task. Deep trees are legitimate;
     *  unbounded depth is a cheap way to exhaust path limits. */
    const val MAX_PATH_DEPTH = 32

    /** Bounds the deterministic `name (2)` search for a free DIRECTORY name. */
    const val MAX_COLLISION_INDEX = 1000

    /**
     * Windows device names, refused on Android TOO.
     *
     * Deliberate: one manifest is then accepted or refused identically on every
     * receiver, and a name only some of a user's devices can receive is worse
     * than one none can.
     */
    private val RESERVED_DEVICE_NAMES = setOf(
        "con", "prn", "aux", "nul",
        "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    )

    /**
     * Names this component owns. A manifest may never produce one, at the top
     * level of a delivery or as the root of a path inside it.
     *
     * Each would do something specific and bad:
     *
     *  * [InboxCommit.RECEIPT_NAME] is written into the staged tree AFTER every
     *    file has been written and digested. A sender that named a file
     *    `.relayium-delivery` would have it silently replaced by the receipt —
     *    a delivery that downloaded and verified correctly and arrived
     *    corrupted. Refused before a byte moves.
     *  * [InboxContainer.STAGING] is where the delivery is assembled;
     *  * [InboxContainer.PROBE] is deleted by the next readiness check.
     */
    private val RESERVED_TOP_LEVEL = setOf(
        InboxCommit.RECEIPT_NAME,
        InboxContainer.STAGING,
        InboxContainer.PROBE,
    )

    /**
     * Validate one manifest name and return it as a cleaned, slash-separated
     * relative path, or null if this device refuses it.
     *
     * Null rather than a thrown error because only the caller knows which
     * manifest INDEX is being refused, and an error carrying a placeholder index
     * is a value someone has to remember to overwrite.
     *
     * The rules, and what each one stops:
     *
     *  * empty or oversized — unrepresentable or unbounded input;
     *  * control scalars including NUL and DEL — a name that can truncate a C
     *    string or rewrite a terminal line. Refused, not stripped;
     *  * bidi controls — a name that reads one way in a UI and another on disk;
     *  * a leading `/` or a drive/UNC prefix — an ABSOLUTE destination, which
     *    would leave the container entirely;
     *  * `\` anywhere — the separator is `/` by protocol, and a backslash is a
     *    legal byte in a POSIX name but a separator on Windows, so one manifest
     *    would produce different trees on different receivers;
     *  * `.` or `..` components — traversal;
     *  * empty components (`a//b`) — two spellings of one path;
     *  * a component ending in `.` or a space — Windows strips both silently, so
     *    `x ` and `x` would collide there and not here;
     *  * a Windows reserved device name;
     *  * a top-level name this component owns.
     */
    fun checkedRelativePath(name: String): String? {
        if (name.isEmpty() || name.toByteArray(Charsets.UTF_8).size > InboxManifest.MAX_NAME_BYTES) {
            return null
        }
        for (ch in name) {
            val code = ch.code
            if (code <= 0x1F || (code in 0x7F..0x9F)) return null
            if (code in BIDI_CONTROLS) return null
        }
        if (name.contains('\\')) return null
        if (name.startsWith('/')) return null
        // `C:foo` is drive-relative and `C:/foo` drive-absolute on Windows.
        if (name.length >= 2 && name[1] == ':') return null

        val parts = name.split('/')
        if (parts.size > MAX_PATH_DEPTH) return null
        for (part in parts) {
            if (part.isEmpty() || part == "." || part == "..") return null
            if (part.endsWith('.') || part.endsWith(' ')) return null
            val stem = part.substringBefore('.').lowercase(Locale.ROOT)
            if (stem in RESERVED_DEVICE_NAMES) return null
        }
        if (parts.first() in RESERVED_TOP_LEVEL) return null
        return name
    }

    /**
     * Choose the directory this delivery will publish into.
     *
     * Picked ONCE, journalled before anything is created, and never recomputed:
     * a name derived again later — against a container that now holds this
     * task's own output — would walk the suffix forward and publish the same
     * delivery twice.
     *
     * A whole directory per delivery, rather than files dropped into the
     * container root, is what makes publication a single atomic rename of
     * something this task exclusively built. It also means the container root is
     * never a place this feature creates, truncates or deletes a file the user
     * might own.
     */
    fun planTaskDirectory(root: File, items: List<InboxManifestItem>, taskId: String): File {
        val base = baseName(items)
        // The directory name comes from the sender as well, so it cannot be one
        // of this component's own entries either.
        if (base in RESERVED_TOP_LEVEL) return File(root, DEFAULT_DIRECTORY_NAME)
        for (n in 1..MAX_COLLISION_INDEX) {
            val candidate = if (n == 1) base else "$base ($n)"
            val directory = File(root, candidate)
            if (!directory.exists()) return directory
        }
        // Deterministic and certainly free: the task id is unique per delivery.
        return File(root, "$base-${InboxId.checked(taskId, "taskId")}")
    }

    /**
     * A readable folder name for a delivery.
     *
     * Derived from what was actually sent, so the user sees something meaningful
     * rather than an opaque id — and passed through the same refusal every other
     * name gets, because it comes from the sender too.
     */
    private fun baseName(items: List<InboxManifestItem>): String {
        val first = items.firstOrNull()?.name?.substringBefore('/').orEmpty()
        val stem = first.substringBeforeLast('.', first)
        val checked = if (stem.isEmpty()) null else checkedRelativePath(stem)
        // A single component only: a folder name is one name, and a nested one
        // would put the delivery somewhere the plan did not describe.
        return checked?.takeIf { !it.contains('/') } ?: DEFAULT_DIRECTORY_NAME
    }

    /** The fallback when a manifest offers nothing usable as a folder name. */
    const val DEFAULT_DIRECTORY_NAME = "Delivery"

    /**
     * The complete, ordered set of destinations one delivery may create, INSIDE
     * its own published directory.
     *
     * Because that directory is fresh and exclusively this task's, there is no
     * collision with the user's own files to step around: the only clash that
     * can occur is two manifest entries naming one path, and that is a refusal
     * rather than a rename — two entries differing only by case are the sender
     * describing two files, and quietly renaming one would hide that this
     * receiver cannot represent what was sent.
     */
    fun plan(taskDirectory: File, items: List<InboxManifestItem>): List<InboxPlanEntry> {
        val taken = HashSet<String>()
        val entries = ArrayList<InboxPlanEntry>(items.size)
        for ((index, item) in items.withIndex()) {
            val name = item.name
            if (item.kind != InboxManifestKind.FILE || name == null) {
                throw InboxPlanException(InboxPlanException.Reason.NOT_A_FILE_MANIFEST, index)
            }
            val relative = checkedRelativePath(name)
                ?: throw InboxPlanException(InboxPlanException.Reason.UNSAFE_NAME, index)
            val destination = File(taskDirectory, relative).path
            if (!taken.add(destination.lowercase(Locale.ROOT))) {
                throw InboxPlanException(InboxPlanException.Reason.DUPLICATE_DESTINATION, index)
            }
            entries.add(InboxPlanEntry(index, relative, item.size, destination))
        }
        return entries
    }

    /** U+200E..U+200F and U+202A..U+202E and U+2066..U+2069. */
    private val BIDI_CONTROLS: Set<Int> =
        (0x200E..0x200F).toSet() + (0x202A..0x202E).toSet() + (0x2066..0x2069).toSet()
}
