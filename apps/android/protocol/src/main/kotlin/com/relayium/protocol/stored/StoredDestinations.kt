package com.relayium.protocol.stored

import com.relayium.protocol.FileMeta
import com.relayium.protocol.Filename

/**
 * Where a received stored object would land, decided IN FULL before the first
 * document is created.
 *
 * Two separate refusals, and both have to happen up front:
 *
 * * **An unsafe entry.** Traversal, an absolute path, a reserved device name, a
 *   name that is nothing but bidi/control characters. [Filename.resolveRelativePath]
 *   already answers this for the realtime wire; a stored manifest reaches the
 *   same judge with the same RAW names.
 * * **A collision.** Two entries that resolve to ONE destination. Nothing
 *   downstream can undo this fairly: the receive store refuses to overwrite, so
 *   the first file would be written and the second would fail — a half-delivered
 *   batch, reported as a failure, with files already in the user's folder. A
 *   collision can also be manufactured, because sanitising is not injective:
 *   two different raw names can clean to the same one. Deciding before any IO
 *   turns that into one honest refusal.
 *
 * Both are decided from the manifest alone, so the user is told the batch cannot
 * be saved before they are asked to choose a folder for it.
 */
sealed interface StoredDestinations {

    /** Every entry resolves, and no two resolve to the same place. */
    data class Accept(val files: List<FileMeta>) : StoredDestinations

    /** [index] is the entry that failed, so the UI can name it. */
    data class Refuse(val reason: Reason, val index: Int) : StoredDestinations

    enum class Reason { UNSAFE_NAME, COLLISION }

    companion object {

        fun plan(files: List<FileMeta>): StoredDestinations {
            val taken = HashSet<String>()
            for ((index, file) in files.withIndex()) {
                val verdict = Filename.resolveRelativePath(file.path, file.name)
                val accepted = verdict as? Filename.PathVerdict.Accept
                    ?: return Refuse(Reason.UNSAFE_NAME, index)
                // The resolved destination, which is what actually collides —
                // not the raw name, and not the leaf alone: `a/x.txt` and
                // `b/x.txt` are two files, `a/x.txt` twice is one.
                val destination = (accepted.segments + accepted.leaf).joinToString("/")
                if (!taken.add(destination)) return Refuse(Reason.COLLISION, index)
            }
            return Accept(files)
        }
    }
}
