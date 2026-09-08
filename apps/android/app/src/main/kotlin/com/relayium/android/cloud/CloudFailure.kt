package com.relayium.android.cloud

/**
 * Why a stored transfer did not happen, classified.
 *
 * An enum rather than a message, for the same reason
 * [com.relayium.android.account.AccountFailure] is one: a failure value travels
 * into UI state, and a value carrying server prose or an exception message
 * carries whatever that text happened to contain — a URL with a key fragment, a
 * bearer echoed in a header dump — into a crash report. Nothing here is
 * interpolated from a response body. The UI maps each case to a localized
 * sentence; [status] rides along only for the cases where the exact code is the
 * only diagnostic a bug report would have.
 */
data class CloudFailure(val kind: Kind, val status: Int = 0) {

    enum class Kind {
        /** No live session at the moment the upload needed one. */
        NOT_SIGNED_IN,

        /** The account changed — signed out, switched, or a credential replaced —
         *  between staging the upload and committing its result. */
        STALE_ACCOUNT,

        /** 401. The credential this device holds is no longer accepted. */
        UNAUTHORIZED,

        /** 429 with a `Retry-After`, or an unclassified one: transient. */
        RATE_LIMITED,

        /** 429, this upload needs more than today's remaining allowance. */
        DAILY_QUOTA,

        /** 429, the account is out of monthly traffic. */
        MONTHLY_TRAFFIC,

        /** 413. Over the plan's storage, or larger than the server accepts. */
        STORAGE_LIMIT,

        /** 507. The service itself has no room. */
        SERVER_FULL,

        /** 503. Storage or a node is unavailable; the upload can be retried. */
        STORAGE_UNAVAILABLE,

        /** 400. The server refused the request shape — a combination of
         *  retention options it does not allow, or a malformed body. */
        REJECTED,

        /** Any other non-2xx on an authenticated route. */
        SERVER,

        /** The transport failed, or a response could not be parsed. */
        NETWORK,
        TIMEOUT,
        MALFORMED,

        /** The link is not a Relayium stored link this app can open — wrong
         *  origin, wrong shape, or a key that is not a key. */
        LINK_INVALID,

        /** 404. Expired, deleted, or already burned. */
        NOT_FOUND,

        /** 429 on a download: this reader's request rate, or the sender
         *  account's monthly traffic. The client cannot tell them apart. */
        DOWNLOAD_LIMITED,

        /** A stored download the SERVICE could not answer, carrying the status.
         *  Distinct from [SERVER] because a reader holding a link needs to know
         *  that neither their link nor their key was the problem. */
        DOWNLOAD_UNAVAILABLE,

        /** A redirect this client would not follow: a target that is not the
         *  agreed shape, or too many hops. */
        UNTRUSTED_REDIRECT,

        /** The bytes did not authenticate, were truncated, or did not total what
         *  the manifest promised. */
        DAMAGED,

        /** The manifest named something no device may create. */
        UNSAFE_NAME,

        /** Two entries would land on one document. */
        NAME_COLLISION,

        /** The chosen folder already holds a document of that name. */
        NAME_TAKEN,

        /** Not enough room on this device to stage the download. */
        NO_SPACE,

        /** Writing to the chosen folder failed, or the grant was revoked. */
        SAVE_FAILED,

        /**
         * A chosen document could not be described — no display name, or a size
         * the provider would not report.
         *
         * Its own case rather than a generic save failure: the manifest commits
         * to a name and a size that the receiver checks the bytes against, so a
         * document without both cannot be sent at all. Saying so is the
         * difference between a user who picks a different file and one watching
         * a picker that appears to do nothing.
         */
        UNREADABLE_SELECTION,

        /**
         * The chosen folder could not be opened — the grant was revoked, or the
         * provider no longer resolves it. Distinct from the user backing out of
         * the picker, which is not a failure at all.
         */
        DESTINATION_UNAVAILABLE,

        /**
         * A chosen document failed WHILE it was being uploaded — the provider
         * raised, or the file changed size against the manifest the server was
         * already told about.
         *
         * Not a network failure, and saying so matters: the user's action is to
         * check the file, not their connection.
         */
        SOURCE_FAILED,

        /** The user stopped it. */
        CANCELLED,
    }
}
