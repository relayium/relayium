package com.relayium.android.ingress

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import java.io.IOException
import java.io.InputStream

/**
 * The Android half: an `Intent` in, a decided [IngressOutcome] out.
 *
 * Everything in this file is adaptation, and that is deliberate. The rules —
 * which links are honoured, which URIs are admitted, what happens to a share
 * while a transfer is running — live in the pure files beside it, where a host
 * unit test can drive a hostile case in a millisecond. What is left here is the
 * part that genuinely needs the framework: reading extras, and talking to a
 * `ContentResolver`. Framework behaviour is checked on a device.
 *
 * ## It claims three actions and no more
 *
 * `ACTION_VIEW`, `ACTION_SEND` and `ACTION_SEND_MULTIPLE`. Anything else —
 * including the launcher's own `ACTION_MAIN` — returns null rather than a
 * refusal, because "this is not an entry point" and "this entry point carried
 * something bad" are different events and only one of them is worth telling the
 * user about. A wiring that showed a refusal for every cold start would be
 * reporting an error for opening the app.
 *
 * ## Nothing here is read from the intent's own claims
 *
 * The MIME type is not consulted, and neither is any extra naming a filename or
 * a size: both are the sender's assertions about somebody else's data. What an
 * item is comes from the provider, through [ContentAccess], and what it is
 * ALLOWED to be comes from [ShareAdmission].
 */
object IngressIntents {

    /**
     * The authorities this app answers to, read from the package it is running
     * as.
     *
     * Declared providers first, because that is the FACT: a `<provider>` in the
     * manifest is what the framework will route to this process, and the debug
     * build declares one the release build does not. `android:authorities`
     * takes a semicolon-separated list, so it is split. The package name goes
     * in as a namespace guard for anything a later manifest adds before anyone
     * remembers this set exists.
     *
     * Lowercased on the way in so the comparison in [ShareAdmission] does not
     * have to care which case a sender wrote.
     *
     * Failure to read the package is not a reason to admit everything: an empty
     * set would silently turn the own-provider rule off. The package name is
     * always included, so the guard degrades to the namespace rule rather than
     * to nothing.
     */
    fun ownAuthorities(context: Context): Set<String> {
        val out = LinkedHashSet<String>()
        out += context.packageName.lowercase()
        val providers = try {
            context.packageManager
                .getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS)
                .providers
        } catch (_: PackageManager.NameNotFoundException) {
            null
        }
        for (provider in providers.orEmpty()) {
            val declared = provider.authority ?: continue
            for (one in declared.split(';')) {
                val trimmed = one.trim()
                if (trimmed.isNotEmpty()) out += trimmed.lowercase()
            }
        }
        return out
    }

    /**
     * Read an intent this app was handed.
     *
     * @param ownAuthorities what this app answers to — pass [ownAuthorities].
     *   See [ShareAdmission.admit].
     * @param trustedOrigin the origin this build talks to, from
     *   `com.relayium.android.Backend`.
     * @return the outcome and the handles behind it, or null when the intent is
     *   not an entry point this module claims.
     */
    fun read(
        intent: Intent,
        ownAuthorities: Set<String>,
        trustedOrigin: String,
    ): IntentIngress? = when (intent.action) {
        Intent.ACTION_VIEW -> IntentIngress(readView(intent, trustedOrigin), emptyMap())
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE ->
            readShare(intent, ownAuthorities, trustedOrigin)
        else -> null
    }

    private fun readView(intent: Intent, trustedOrigin: String): IngressOutcome {
        val raw = intent.dataString ?: return IngressOutcome.Refused(IngressRefusal.EMPTY)
        return IngressLinkPolicy.read(raw, trustedOrigin)
    }

    /**
     * A share: items if it carries any, otherwise text.
     *
     * **Items win over text when both are present**, which is the common
     * "photo with a caption" share. The caption is dropped rather than staged
     * beside the photo: a message and a batch of files are two different things
     * to send, to two different destinations, and silently promoting a caption
     * into a message the user never wrote into this app would be inventing
     * content on their behalf.
     */
    private fun readShare(
        intent: Intent,
        ownAuthorities: Set<String>,
        trustedOrigin: String,
    ): IntentIngress {
        val named = try {
            collectUris(intent)
        } catch (_: RuntimeException) {
            return malformed()
        }
        // Before anything else, and deliberately BEFORE the text fallback. A
        // sender that named more than this app will look at has made an
        // unusable share, and falling through to its caption would answer a
        // refused share with a message the user never wrote — a share of a
        // million junk entries would arrive as "here is some text".
        if (named.overBudget) {
            return IntentIngress(IngressOutcome.Refused(IngressRefusal.TOO_MANY_ITEMS), emptyMap())
        }
        if (named.order.isNotEmpty()) {
            // The grant is a property of the INTENT, not of one URI: the sender
            // sets the flag once for everything it attached.
            val granted = (intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0
            val outcome = ShareAdmission.admit(named.order, granted, ownAuthorities)
            return IntentIngress(outcome, named.targets)
        }
        val text = try {
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        } catch (_: RuntimeException) {
            return malformed()
        } ?: return IntentIngress(IngressOutcome.Refused(IngressRefusal.EMPTY), emptyMap())
        return IntentIngress(SharedTextPolicy.read(text, trustedOrigin), emptyMap())
    }

    /**
     * An intent whose extras could not be read at all.
     *
     * **Why `RuntimeException` is caught here, and why that is not the usual
     * mistake.** Reading an extra unparcels a `Bundle` the SENDER wrote, in
     * this process. A payload naming a class that does not exist here raises
     * `BadParcelableException`; a payload whose `EXTRA_STREAM` is a `String`,
     * or an `ArrayList<String>`, raises `ClassCastException` at the erased cast
     * that the compat helper cannot check; a truncated parcel raises whatever
     * `unparcel` decides to raise. None of these is a bug in this app, all of
     * them are reachable by any installed app with one `startActivity`, and
     * every one of them would otherwise take down the activity that received
     * the share — a crash any app can trigger on demand.
     *
     * The reason is carried and the exception is NOT: its message and stack can
     * quote class names the sender chose, and this value is on its way to a
     * user-visible surface and a log.
     */
    private fun malformed() =
        IntentIngress(IngressOutcome.Refused(IngressRefusal.MALFORMED_INTENT), emptyMap())

    /** The URIs an intent named, as the order they came in and the handles
     *  behind them, plus whether the walk was cut short. */
    private class NamedUris {
        val order = ArrayList<IncomingUri>()
        val targets = HashMap<IncomingUri, Uri>()

        /** The sender named more entries than this app will even look at. */
        var overBudget = false
    }

    /**
     * Every URI the intent named, in order, WITH its duplicates, and the `Uri`
     * object each one came from.
     *
     * **Both places are read.** `EXTRA_STREAM` is the canonical list and is
     * read first; `ClipData` is what the platform fills in on the way across
     * and what some senders populate instead. Neither is reliably present on
     * its own, and a share that lost half its files because the sender used the
     * other mechanism is a bug the user discovers at the far end.
     *
     * **Duplicates are deliberately NOT removed here.** Reading both places is
     * exactly what produces them, and dropping them silently in the adapter
     * would mean the deduplication that actually runs in production is the one
     * no host test can reach, while the tested rule in [ShareAdmission] never
     * fires. Passing them through keeps one implementation and makes the
     * "these two are the same item" count honest.
     *
     * **The `Uri` objects are kept rather than re-parsed.** The pure layer
     * identifies an item by the exact string the intent produced; turning that
     * string back into a `Uri` later would run it through a parser a second
     * time, and two spellings of one address are two addresses.
     *
     * **The bound is on entries SCANNED, not on URIs kept, and it is one
     * budget across both containers.** Counting only what survived would leave
     * the walk itself unbounded in exactly the cases that matter: a list of a
     * million wrong-type parcelables and a `ClipData` of a million text items
     * both admit nothing, so a keep-count never rises and every element is
     * still examined. A sender chooses that shape for free. The budget is
     * shared because the two containers are two halves of one share — spending
     * it separately would let a sender pay the ceiling twice.
     *
     * Running out is REPORTED rather than silently truncating: [NamedUris.overBudget]
     * turns into an explicit refusal, because a share this app only looked at
     * part of is not a share it can honestly send part of.
     */
    private fun collectUris(intent: Intent): NamedUris {
        val limit = ShareAdmission.MAX_ITEMS + 1
        val out = NamedUris()
        /** One entry's worth of budget. False means the budget is spent and
         *  THIS entry was not examined — so the walk stops and says so. */
        var budget = limit
        fun scan(candidate: Any?): Boolean {
            if (budget <= 0) return false
            budget--
            val uri = candidate as? Uri ?: return true
            // Both spellings of the authority, taken from the ONE `Uri` the
            // intent produced. Handing the pure layer both is what lets it
            // judge a `userId@authority` without re-parsing the string.
            val incoming = IncomingUri(uri.toString(), uri.scheme, uri.authority, uri.encodedAuthority)
            out.order.add(incoming)
            out.targets.putIfAbsent(incoming, uri)
            return true
        }

        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            // Walked as `List<*>` and cast per element. Below API 33 the compat
            // helper cannot check the element type, so the declared
            // `ArrayList<Uri>` may really hold anything the sender parcelled —
            // and an implicit cast in a `for` header would throw on the first
            // one. Skipping the elements that are not URIs keeps a share of ten
            // real files that happens to carry one hostile entry.
            val list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            for (element in (list as List<*>?).orEmpty()) {
                if (!scan(element)) {
                    out.overBudget = true
                    return out
                }
            }
        } else {
            scan(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        }
        val clip = intent.clipData
        if (clip != null) {
            var i = 0
            while (i < clip.itemCount) {
                if (!scan(clip.getItemAt(i)?.uri)) {
                    out.overBudget = true
                    return out
                }
                i++
            }
        }
        return out
    }
}

/**
 * A read intent: what it asked for, and the handles needed to honour it.
 *
 * The `Uri` objects are private and reachable only through [access], so the
 * only way to open one of them is with the [ContentAccess] built here — which
 * is bound to exactly the URIs this intent named.
 */
class IntentIngress internal constructor(
    val outcome: IngressOutcome,
    private val targets: Map<IncomingUri, Uri>,
) {
    /** A reader for the items this intent carried, and nothing else. */
    fun access(resolver: ContentResolver): ContentAccess = ResolverAccess(resolver, targets)

    override fun toString(): String = "IntentIngress($outcome, items=${targets.size})"
}

/**
 * [ContentAccess] over a real `ContentResolver`, closed over the URIs one
 * intent named.
 *
 * A URI it does not hold is refused rather than resolved: the map is the
 * capability, so this object cannot be turned into a general-purpose opener by
 * a caller that constructs an [IncomingUri] of its own.
 */
private class ResolverAccess(
    private val resolver: ContentResolver,
    private val targets: Map<IncomingUri, Uri>,
) : ContentAccess {

    override fun describe(uri: IncomingUri): ProviderDescription? {
        val target = targets[uri] ?: return null
        // Exactly the two columns that are being read. A null projection asks
        // for everything the provider has, which for some providers is a great
        // deal of unrelated data about the user's document.
        val projection = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return resolver.query(target, projection, null, null, null)?.use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            val name = if (nameIndex >= 0 && !cursor.isNull(nameIndex)) cursor.getString(nameIndex) else null
            val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else null
            ProviderDescription(name, size)
        }
    }

    override fun open(uri: IncomingUri): InputStream {
        val target = targets[uri] ?: throw IOException("relayium: not a staged item")
        // A provider is allowed to return null here, and it means the same
        // thing a throw does: there is nothing to read. Returning null to the
        // caller would push that decision to every read site.
        return resolver.openInputStream(target) ?: throw IOException("relayium: provider opened nothing")
    }
}
