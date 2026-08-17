package account

import (
	"context"
	"errors"
)

// ErrNotFound is returned by Store methods when a requested row does not exist.
// Callers depend on this sentinel rather than any storage-specific error, so a
// Postgres swap need only touch sqlite.go.
var ErrNotFound = errors.New("account: not found")

const MaxBrowserDevicesPerAccount = 20

var ErrBrowserDeviceLimit = errors.New("account: browser device limit reached")

// User is an account holder. PII is limited to email + display name.
type User struct {
	ID            string
	Email         string
	DisplayName   string
	CreatedAt     int64
	EmailVerified bool
	// OnlyOwnNodes restricts this user's transfers to their own self-hosted
	// nodes (SP3 BYO nodes), excluding the shared fleet.
	OnlyOwnNodes bool
	// DeletedAt is when the user requested account deletion (unix seconds);
	// 0 = active account, not scheduled for deletion.
	DeletedAt int64
	// PurgeAfter is when GC may hard-delete this account and its data (unix
	// seconds); 0 = not scheduled. Set alongside DeletedAt with a grace period.
	PurgeAfter int64
	// PlanID is the user's billing tier (plans.id); defaults to "free".
	PlanID string
	// StripeCustomerID is this user's Stripe customer id, set on first
	// checkout; '' = no Stripe customer yet.
	StripeCustomerID string
	// StripeSubscriptionID is the CANONICAL subscription id (the earliest one the
	// user holds). The webhook uses it to dedup a double-checkout: an event for a
	// DIFFERENT id triggers a reconcile (keep earliest, cancel+refund the rest);
	// an event matching it takes the normal per-event path with no Stripe call.
	// '' = no subscription recorded yet.
	StripeSubscriptionID string
	// SubscriptionStatus mirrors the Stripe subscription status ('', 'active',
	// 'canceled', 'past_due', ...); '' = no subscription on record.
	SubscriptionStatus string
	// SubscriptionEnd is the current subscription period's end (unix seconds);
	// 0 = no subscription on record.
	SubscriptionEnd int64
	// PlanSource records who last set PlanID: '' (default/free), 'admin'
	// (manual comp — a Stripe webhook must not override it), or 'stripe'.
	PlanSource string
	// ScheduledPlanID is the tier a pending period-end downgrade will switch to;
	// '' = no pending change. Display hint only (see the column comment).
	ScheduledPlanID string
	// ScheduledCycle is the billing cycle ('monthly'|'yearly') that pending
	// downgrade switches to, stored next to ScheduledPlanID so a same-tier cycle
	// downgrade can be told apart from "already landed". '' = legacy (predates the
	// column) → clear falls back to tier-only matching. See handleStripeWebhook.
	ScheduledCycle string
	// BillingCycle is 'monthly' or 'yearly' for a Stripe-sourced subscription;
	// '' means unknown (a row that predates the column). Treat '' as "cannot
	// compare cycles" rather than as a third cycle — see handleBillingChangePlan.
	BillingCycle string
	// PlanStartedAt 是当前档位生效的时刻（unix 秒）；0 表示从未改过档。
	// 与 QuotaAccrued* 一起把当月切成若干"档位段"，用来给月中改档的用户按段
	// 计算流量上限，而不是每次改档都白送一整个月的额度。
	PlanStartedAt int64
	// QuotaAccruedBytes 是本月 PlanStartedAt 之前那些已结束的段累计下来的流量
	// 额度（每段 = 该段档位上限 × 该段占全月的比例）。
	QuotaAccruedBytes int64
	// QuotaAccruedPeriod 是 QuotaAccruedBytes 所属的 'YYYYMM' 桶。与当前月份不
	// 符即视为过期作废，用户直接拿当前档的整月上限——这也让存量用户（三列全为
	// 零值）天然走满额分支，无需回填。
	QuotaAccruedPeriod string
}

// Plan is an admin-configurable billing tier: per-account storage + monthly
// traffic caps and a staged-file retention ceiling. Prices are US cents.
type Plan struct {
	ID            string
	Name          string
	StorageBytes  int64
	TrafficBytes  int64
	RetentionSecs int64
	PriceMonthly  int64
	PriceYearly   int64
	SortOrder     int64
	Active        bool
	UpdatedAt     int64
	// StripePriceMonthlyID/StripePriceYearlyID are the Stripe Price ids for
	// this tier's monthly/yearly billing cycle; '' = that cycle isn't
	// purchasable via Stripe (e.g. the free tier, or an unmapped price).
	StripePriceMonthlyID string
	StripePriceYearlyID  string
	// DailyQuotaBytes 是该档每 24 小时的上传额度；<= 0 表示回落到全局
	// SettingDailyQuota。存量 plans 行的该列默认 0，因此迁移后行为不变。
	DailyQuotaBytes int64
}

// Identity links an external auth subject (google sub, or the email itself) to a user.
type Identity struct {
	Provider string // "google" | "email"
	Subject  string
	UserID   string
}

// Session is a server-side login session referenced by an httpOnly cookie.
type Session struct {
	ID        string
	UserID    string
	CreatedAt int64
	ExpiresAt int64
	Revoked   bool
}

// MagicToken is a one-time email login token. Only its hash is stored.
type MagicToken struct {
	TokenHash string
	Email     string
	CreatedAt int64
	ExpiresAt int64
	UsedAt    int64 // 0 = unused
}

// EmailToken is a one-time verification or password-reset token. Only its hash
// is stored. Purpose is "verify" or "reset".
type EmailToken struct {
	TokenHash string
	UserID    string
	Email     string
	Purpose   string
	CreatedAt int64
	ExpiresAt int64
	UsedAt    int64 // 0 = unused
}

// Device is a browser (later: a CLI) registered under a user. Static registry only;
// online presence/rendezvous belongs to the cross-network spec, not here.
type Device struct {
	ID         string
	UserID     string
	Name       string
	CreatedAt  int64
	LastSeenAt int64
	// LastIP is the last server-observed network address of this credential.
	// It contains an IP only (never a port or forwarded-header text) and is
	// visible only to the owning account as an identification hint. It may be a
	// NAT or VPN address, so the UI must not present it as a precise location.
	LastIP string
	// Kind distinguishes the device's platform: "" / "browser" (default) or
	// "cli" for a device registered via the device-code CLI login flow.
	Kind string
	// InstallID is the client-generated installation lookup hint this row was
	// registered under, or "" for every row that predates it and every client
	// that does not send one (all CLI versions, all pre-1.1.3 apps).
	//
	// It is account-scoped and unique within an account (a partial unique index
	// covers the non-empty values), which is what lets an approved re-login find
	// exactly one row or none. It is NEVER an authenticator, never matched
	// across accounts, and never emitted in an API response — deviceView has no
	// field for it, and a test asserts the device list does not echo it.
	InstallID string
}

type BrowserDeviceRegistration struct {
	UserID, DeviceID, TokenHash, Name, LastIP string
	At                                        int64
}

// DeviceInbox is one device's Device Inbox enrolment: the negotiated protocol
// version, the capabilities it announced, its automatic-receive policy, and its
// heartbeat-derived presence. One row per device; absent = the device is not
// enrolled and is not a send target.
//
// Presence is stored ONLY as PresenceExpiresAt (plus the raw LastHeartbeatAt for
// display). There is deliberately no `online` column: a boolean would survive a
// crashed device, a killed process or a central restart, and the first thing a
// sender would see is a lie. See inbox.Presence.
//
// RevokedAt is set when the device's ACTIVE end-to-end key is revoked. A revoked
// enrolment is terminal: the device cannot heartbeat, cannot register a new key,
// and is never a send target. The owner clears it by deleting the enrolment (an
// explicit re-enrolment) or by deleting the device outright.
type DeviceInbox struct {
	DeviceID string
	UserID   string
	// Platform ("darwin"/"linux"/"ios"/…) and AppVersion are self-reported
	// display/diagnostic metadata, bounded but not trusted.
	Platform   string
	AppVersion string
	// ProtocolVersion is the NEGOTIATED version (highest common), not what the
	// client asked for. 0 is impossible on a stored row: a failed negotiation
	// stores nothing.
	ProtocolVersion int
	// Capabilities is the canonical (deduplicated, sorted) announced set.
	Capabilities []string
	// ReceiveCapability is the negotiated member of the inbox.receive.* family.
	ReceiveCapability string
	// AutoAccept is off|ask|auto, default off (PRD §8).
	AutoAccept string
	// ReceiveDirReady is the device's own last report of whether its configured
	// receive directory is usable. Reported, never inferred: central has no way
	// to check a directory on someone else's machine.
	ReceiveDirReady   bool
	LastHeartbeatAt   int64
	PresenceExpiresAt int64
	RegisteredAt      int64
	UpdatedAt         int64
	RevokedAt         int64
}

// DeviceKey is ONE end-to-end public key in a device's key history. PublicKey is
// a PUBLIC key and nothing else — there is no private-key field on this struct,
// no column behind it, and no API that accepts one (zero-knowledge invariant).
//
// History is retained rather than overwritten on rotation, because a task queued
// before a rotation was sealed to the OLDER key: dropping the row would make
// central unable to say which key a queued task belongs to, and the honest
// recovery ("this task was sealed to a key you have rotated away from") would
// become an unexplained failure. Superseded is therefore distinct from revoked:
//
//   - SupersededAt != 0 — rotated away from. Not used for NEW tasks; the device
//     still holds the private key and can drain tasks sealed to it.
//   - RevokedAt != 0 — compromised or withdrawn. Never usable again, for new or
//     queued tasks.
//
// Generation is a per-device counter starting at 1, unique by DB constraint. It
// makes a replayed or reordered rotation detectable rather than merely unlikely.
type DeviceKey struct {
	ID           string
	DeviceID     string
	UserID       string
	Algorithm    string
	PublicKey    string
	Generation   int64
	CreatedAt    int64
	SupersededAt int64
	RevokedAt    int64
}

// Active reports whether this key may be used to seal a NEW task: the current
// key of its device and not revoked.
func (k DeviceKey) Active() bool { return k.SupersededAt == 0 && k.RevokedAt == 0 }

// InboxTask is ONE encrypted asynchronous delivery to a device (PRD §6.2).
//
// WHAT CENTRAL MAY KNOW, and therefore what this struct is allowed to contain:
// the owning account, the source and target devices, the ciphertext byte count,
// timestamps, the state, an opaque error code, and idempotency metadata. Plus
// exactly two opaque blobs it cannot read — the encrypted manifest and the
// content key sealed to the target device's public key.
//
// WHAT IT MUST NEVER CONTAIN, and has no field for: plaintext content, file or
// directory names, the target's real filesystem path, the content key, or any
// device private key. Adding one would be a zero-knowledge regression, not a
// feature.
//
// The ciphertext itself is NOT duplicated here. StoredFileID references an
// existing same-account Stored Object, so the task reuses the storage, quota,
// expiry and download paths that already exist rather than creating a second,
// parallel object lifecycle. That also means a task never OWNS a blob: deleting
// a task cannot orphan one, because the object's owner is the stored_files row
// and its normal TTL/GC still governs it.
type InboxTask struct {
	ID     string
	UserID string
	// TargetDeviceID is the device that will receive. SourceDeviceID is the
	// device that created the task, or "" when a browser session did — kept for
	// audit ("which of my machines sent this"), never for authorization.
	TargetDeviceID string
	SourceDeviceID string
	// IdempotencyKey is chosen by the SENDER and unique per account. It is what
	// makes a retried create converge on one task instead of queueing a second
	// copy of the same file.
	IdempotencyKey string
	// StoredFileID is the same-account encrypted Stored Object holding the
	// ciphertext. EncManifest is that object's encrypted manifest, carried on
	// the task so the device gets it with the wrapped key in one response.
	StoredFileID string
	EncManifest  []byte
	// WrappedKey is the task's one-time content key sealed to TargetKeyID with
	// WrapAlgorithm. Central cannot open it: it never holds the private half.
	WrapAlgorithm string
	WrappedKey    string
	// TargetKeyID/TargetKeyGeneration bind the task to ONE key at creation. A
	// later rotation does not move the binding — the device still holds that
	// private key and can drain the task — but revoking that key terminates it,
	// because nothing can decrypt it any more.
	TargetKeyID         string
	TargetKeyGeneration int64
	// CiphertextBytes is derived from the referenced Stored Object, never from
	// the sender's claim about it.
	CiphertextBytes int64
	State           string
	// ClaimTokenHash is the hash of the token issued to the current claimant.
	// Only the hash is stored, like every other bearer in this store. "" = the
	// task is not leased.
	ClaimTokenHash string
	LeaseExpiresAt int64
	Attempts       int64
	NextAttemptAt  int64
	ErrorCode      string
	CreatedAt      int64
	UpdatedAt      int64
	// ExpiresAt is inherited from the referenced Stored Object. The task cannot
	// outlive the ciphertext it points at, and there is no separate task TTL to
	// keep consistent with it.
	ExpiresAt  int64
	NotifiedAt int64
	// SavedAt is set ONLY when the target device asserted a completed atomic
	// commit. A database CHECK keeps it zero on every other state, so no code
	// path can leave a saved timestamp on a task that was not saved.
	SavedAt    int64
	TerminalAt int64
}

// Leased reports whether the task currently has a claimant.
func (t InboxTask) Leased() bool { return t.ClaimTokenHash != "" }

// InboxTaskReport is one target device's assertion about a task it holds.
//
// RawClaimToken is required on every report and is matched against the stored
// hash INSIDE the update transaction. That is what makes a stale claimant — a
// device whose lease expired and was reclaimed, or one that was superseded by a
// later claim — fail instead of overwriting the state of whoever holds the task
// now.
type InboxTaskReport struct {
	TaskID        string
	DeviceID      string
	UserID        string
	RawClaimToken string
	To            string
	ErrorCode     string
	// SavedAssertion is the device saying, explicitly, that authenticated
	// decryption, complete verification and the atomic local commit all
	// succeeded. `saved` is refused without it (ErrSavedNotAsserted), so a
	// client cannot arrive at "saved" by reporting a state name alone.
	SavedAssertion bool
	Now            int64
}

// DeviceAuthRequest is one device-code CLI login flow request (RFC 8628-style).
// Status transitions pending -> approved -> consumed exactly once each; denied
// is a terminal dead end. TokenHash is the hash of the CLI bearer token minted
// on approval; PendingToken (DB-only, not exposed on this struct) transiently
// holds the raw token between approve and the CLI's next poll, then is blanked.
type DeviceAuthRequest struct {
	UserCode       string // short code shown to the user (e.g. "WDJB-MJHT")
	DeviceCodeHash string // hash of the long-lived code the CLI polls with
	Status         string // "pending" | "approved" | "denied"
	UserID         string // set on approval
	TokenHash      string // hash of the minted CLI token, set on approval
	CreatedAt      int64
	ExpiresAt      int64
	ConsumedAt     int64  // 0 = not yet consumed
	ClientIP       string // origin of the CLI that started the flow (for the approval page)
	UserAgent      string // CLI's User-Agent, truncated
	// DeviceName is the account-visible label the CLI asked to register,
	// already sanitized (internal/devicelabel). It is bound here at start so the
	// browser approves the same identity that gets persisted, and so a person
	// can match the pending request to the terminal in front of them.
	// Descriptive and spoofable — never an authentication signal. '' = a
	// pre-label CLI; approval substitutes the historical "CLI" name.
	DeviceName string
	// InstallID is the installation lookup hint the client offered at start,
	// already validated (validInstallID) — an unparseable one is dropped to ''
	// rather than stored. Bound HERE, at start, for the same reason DeviceName
	// is: approval must consume the identifier the request was created with, not
	// one a concurrent request could substitute between the read and the write.
	//
	// '' means "no hint", and approval then registers a fresh device row — what
	// every CLI version and every pre-1.1.3 app gets.
	InstallID string
}

// ApprovedDeviceAuth is what a successful ApproveAndRegisterDeviceAuth read out
// of the row it transitioned, inside that same transaction. A struct rather than a growing
// tuple of same-typed returns: three strings in a row are exactly what a later
// edit transposes silently.
type ApprovedDeviceAuth struct {
	// DeviceName is the label the request carried; '' means a pre-label client
	// and the caller substitutes the historical name.
	DeviceName string
	// ClientIP is the origin the flow was started from, recorded as the row's
	// server-observed address.
	ClientIP string
	// InstallID is the validated installation hint, or '' for none.
	InstallID string
}

// ApprovedDeviceRegistration is one approved device-code login binding a device
// row to a freshly minted bearer.
//
// It exists so that finding-or-creating the row, revoking whatever bearer that
// row previously held, and installing the new one happen in ONE transaction.
// As three separate calls each intermediate state is a real defect: a row with
// two live bearers (a logout that only half revokes), a row with none (a device
// that authenticates nowhere while the user has just watched themselves sign
// in), or two rows for one machine — the bug this batch exists to fix.
type ApprovedDeviceRegistration struct {
	UserID string
	// NewDeviceID is used ONLY when no existing row matches. A reused row keeps
	// its own id, because that id is what the Device Inbox enrolment, the
	// registered key history and every queued task hang off.
	NewDeviceID string
	// Name and Kind are applied only when a row is CREATED. A reused row keeps
	// the name the owner gave it: re-registering must not rename a machine back
	// to the login flow's fallback label on every sign-in.
	Name string
	Kind string
	// InstallID is the validated hint, or "" to register a fresh row
	// unconditionally.
	InstallID string
	// LastIP is the canonicalized server-observed address of the approval.
	// Empty leaves an existing row's address alone.
	LastIP    string
	TokenHash string
	At        int64
}

// CLIToken is a long-lived hashed bearer credential minted at the end of a
// device-code CLI login flow. Only its hash is stored; the raw token is shown
// to the CLI once (via ConsumeDeviceAuth's pending_token handoff).
type CLIToken struct {
	TokenHash  string
	UserID     string
	DeviceID   string
	CreatedAt  int64
	LastSeenAt int64
}

// UsageEvent is one coturn allocation's relay accounting. Recorded unattributed
// (empty UserID) since pairing codes are anonymous; kept for global relay
// accounting.
type UsageEvent struct {
	AllocID      string
	Token        string
	UserID       string
	RelayedBytes int64
	RecordedAt   int64
	NodeID       string
	Billable     bool
}

// UploadSessionRow is the durable state of one in-progress chunked upload
// (item #9). The live blob handle is NOT stored — it is reconstructed from
// NodeID per request via blobFor; the DB replaces the per-session mutex.
type UploadSessionRow struct {
	ID          string
	UserID      string
	BlobKey     string
	NodeID      string
	Billable    bool
	EncManifest []byte
	TTL         int64
	MaxDL       int64
	MaxSize     int64 // write cap fixed at init (see sessionWriteCap)
	Received    int64 // bytes committed to the blob so far
	CreatedAt   int64
	Done        bool
	// Purpose is the StoredFile.Purpose the finalized object will carry. Fixed
	// at init and persisted, because finalize may run on a different instance
	// and must not have to re-derive an authorization-relevant decision from a
	// query string it can no longer see.
	Purpose string
	// PairRoomID is the pairing-code room this upload is pre-uploading into, ""
	// for every other purpose. Persisted for the same reason Purpose is: the
	// finalize that binds the object may not be the instance that resolved the
	// code, and it must not have to re-check an ownership decision from a query
	// string it can no longer see.
	PairRoomID string
	// Metered is how many of Received's bytes have already been charged to the
	// account's monthly traffic. Uploads are billed per committed append (so a
	// cancelled upload is billed for exactly what moved), and finalize charges
	// only the remainder — this column is what keeps the two from double-billing
	// the same bytes across instances.
	Metered int64
	// UnresolvedAt is when this session was moved into the RECOVERY state: it
	// was abandoned, and its blob's node could not be reached even once to ask
	// how many bytes it really holds. 0 for every ordinary session.
	//
	// It marks the row as accounting evidence that is explicitly NOT settled.
	// Received is only a lower bound in this state — the node may have committed
	// bytes it never got to acknowledge — so nothing may purge the row, nothing
	// may drop the blob, and nothing may read the meter as final until a probe
	// succeeds (SettleUnresolvedUpload) and clears this back to 0. See
	// Service.recoverUnresolvedUploads.
	UnresolvedAt int64
}

// UploadProgress is one committed append as the store must record it: the bytes
// that landed, and the pairing-room deadline they bought.
type UploadProgress struct {
	// SessionID is the upload session; UserID is who pays for it.
	SessionID string
	UserID    string
	// Committed is the blob's own authoritative size after the append — never a
	// client-supplied number and never an increment. The delta to bill is derived
	// from it inside the transaction, against the offset the database holds, so a
	// duplicated or concurrent request cannot bill the same bytes twice.
	Committed int64
	// Billable is false for own-node uploads, which are never metered.
	Billable bool
	Now      int64
	// RoomID is the pairing room this upload is pre-uploading into, "" for every
	// other purpose. RoomExpiry is the deadline the room and its objects take on
	// as a result of this progress (pairRoomProgressExpiry — the rule lives in
	// pairroom.go, never in SQL).
	RoomID     string
	RoomExpiry int64
}

// UploadProgressResult is what one CommitUploadProgress actually did.
type UploadProgressResult struct {
	// Received is the session's committed offset after the call.
	Received int64
	// RoomOpen reports whether the pairing room named by UploadProgress.RoomID
	// was still open and inside its deadline at the instant this transaction
	// wrote. Always true when there is no room.
	//
	// It is the transactional answer to a question the caller can only ask
	// racily: the room's liveness is re-derived before every append, but a room
	// that ends in the microseconds after that check would otherwise have bytes
	// accepted, billed and a deadline projected for ciphertext that is already
	// void. False means "billed, but refuse the request and take the ciphertext
	// away" — never "silently succeeded".
	RoomOpen bool
	// RoomJoinDeadline is the instant the room named by UploadProgress.RoomID is
	// joinable until, as its ROW held it inside this transaction — after the
	// deadline this call may have bought, or as it already stood when it bought
	// none.
	//
	// 0 for every case that has nothing to say rather than something reassuring:
	// no room, a room that is gone, any room this same transaction found not
	// open (RoomOpen false), and a room somebody has already JOINED. A closed
	// room's join deadline can still be in the future — closing does not rewind
	// the last byte — and it names a rendezvous whose ciphertext is already
	// deleted; a joined room's would name a rendezvous nobody else may enter
	// (pairRoomCodeDeadline, invariant 5).
	//
	// It exists because the caller CANNOT compute it. A handler holds a room
	// snapshot it read before the append, and between that read and this write a
	// sibling request — a duplicate, a retry, another file of the same batch — can
	// move the room further out and lose its own answer. Reconstructing the
	// deadline from that stale snapshot plus the handler's own clock produces a
	// number the room never carried: earlier than the truth, so a client counts
	// down to an expiry the registry is still admitting joins past, or later than
	// it, so it counts down a window no byte bought.
	//
	// This is the row's own answer — whatever the deadline is when this
	// transaction commits, a sibling's included — and never a projection of one.
	RoomJoinDeadline int64
}

// PairRoomTouch is what one TouchPairRoomUpload actually left behind: the room's
// own answer, read inside the transaction that wrote it.
//
// It exists for the same reason UploadProgressResult.RoomJoinDeadline does, one
// call site along. Finalize's touch is followed by a sync of the pairing CODE,
// and the only number the caller had for it was one it PROJECTED from the room
// snapshot it read before the write (pairRoomProgressJoinDeadline). That
// projection has two ways of being wrong, and both were reachable by ordinary
// use: a sibling append can move the room after this snapshot was taken, and —
// the one this type was added for — a room somebody has JOINED has no join
// deadline at all, while the projection cheerfully computes one from
// created/last_upload and hands the registry another five minutes of six digits
// for a rendezvous that is already full.
//
// The handoff between the database and the registry (in-memory, in the signaling
// layer) is still two steps and cannot be made one: the code is extended AFTER
// the transaction commits, deliberately, so the credential can never claim a
// window the room does not hold. What this removes is the caller's freedom to
// invent the number in between — not the gap itself. See pairroom.go's
// notePairRoomUpload for what a crash inside that gap costs.
type PairRoomTouch struct {
	// CodeDeadline is the instant the room's pairing CODE may be extended to, as
	// the row stood at the end of this transaction — this call's own move
	// included, and a sibling's too if the sibling got there first.
	//
	// 0 means "extend nothing", and it is the answer for every case that has
	// nothing to say rather than something reassuring: a room somebody has
	// already joined (invariant 5 — joining ends every clock, and a code kept
	// alive past it holds six of a million digits out of circulation while
	// buying nothing), and a room that is gone. A closed or expired room does not
	// reach this at all: it comes back as ErrPairRoomClosed.
	CodeDeadline int64
}

// PairRoomCompletionOutcome is what a completion attempt actually did. Four
// values rather than an error and a bool, because each maps to a different thing
// the receiver must do next and two of them are refusals that mean opposite
// things.
type PairRoomCompletionOutcome int

const (
	// PairRoomCompletionGone: there is nothing here to complete. The object was
	// already completed, never existed, or is not a pair-room object at all —
	// ONE outcome for all three, because this endpoint is unauthenticated and
	// separating them would make it an existence oracle over every stored object.
	// It is also the answer that keeps shares and Device Inbox objects out of
	// reach of this path entirely.
	PairRoomCompletionGone PairRoomCompletionOutcome = iota
	// PairRoomCompletionNoVerifier: a live pair-room object whose sender never
	// asked for a completion capability — a client predating it, or one that
	// chose not to offer one. Distinct from a wrong proof on purpose: a receiver
	// told "wrong proof" will keep deriving proofs from the key it holds, and no
	// proof it can ever produce will work. Nothing is deleted.
	PairRoomCompletionNoVerifier
	// PairRoomCompletionMismatch: the proof does not open this object's
	// capability. Nothing is deleted, and the object stays exactly as readable as
	// it was — a failed completion is not a half-performed one.
	PairRoomCompletionMismatch
	// PairRoomCompletionDone: the row is gone, the blob has a durable owner, and
	// the storage it held is released.
	PairRoomCompletionDone
)

// PairRoomCompletion is what one completion transaction did, and the work list it
// leaves behind. Every row it describes is ALREADY changed; what is left for the
// caller is only the part that has to talk to a node or to the code registry,
// neither of which may hold up a database transaction.
type PairRoomCompletion struct {
	Outcome PairRoomCompletionOutcome
	// Object is the row that was removed, valid only for PairRoomCompletionDone.
	// The caller needs its blob key and node for the physical delete — which is
	// best-effort, because the intent queued in the same transaction is what
	// actually guarantees the bytes go.
	Object StoredFile
	// RoomClosed reports that this completion also ended the room: it was the
	// last thing the room held, nothing was still uploading into it, and somebody
	// had joined. Never true for an unjoined room — that one is still waiting for
	// files and for a receiver, and its deadline is what ends it.
	RoomClosed bool
	// Room is that room as it stood after being closed, for the caller to revoke
	// the pairing code with. Zero unless RoomClosed.
	Room PairRoom
}

// ErrPairRoomClosed is returned by a store write whose pairing-room
// precondition failed: the room closed, expired, or vanished before the write
// could land. It is a terminal condition, never a transient one — retrying it
// cannot make a closed room open — so the retry helper stops on it and the
// upload routes turn it into the same 410 a pre-check refusal produces.
var ErrPairRoomClosed = errors.New("account: pair room is closed")

// StoredFile is one zero-knowledge stored-transfer object's lifecycle row. The
// server holds only ciphertext: EncManifest (encrypted filenames/sizes) and the
// blob it points at are opaque. It never sees plaintext content, names, or the key.
type StoredFile struct {
	ID            string
	UserID        string
	BlobKey       string
	EncManifest   []byte
	Size          int64 // ciphertext byte count
	BurnAfterRead bool
	CreatedAt     int64
	ExpiresAt     int64
	DownloadedAt  int64  // 0 = not yet downloaded
	DownloadCount int64  // lifetime successful downloads of this file (non-burn)
	NodeID        string // "" = central-local blob; else the relay node holding the ciphertext
	// MaxDownloads generalizes BurnAfterRead: 0 = unlimited until TTL; N = delete
	// after the Nth successful download; 1 = burn-equivalent. BurnAfterRead is
	// kept for back-compat, but runtime logic is driven off MaxDownloads.
	MaxDownloads int64
	// Purpose is what this object IS: StoredPurposeShare (a capability link,
	// the only kind before Phase 1D-A) or StoredPurposeDeviceTask (ciphertext
	// that exists only to be delivered to one of the account's own devices and
	// is never publicly readable). See taskobject.go. Empty on read means a row
	// written before the column existed; the store normalizes it to `share`.
	Purpose string
	// InboxTaskID is the one Device Inbox task a task-purpose object is bound
	// to, "" while unbound. A share is never bound: it may back several tasks
	// and it belongs to its link, not to a delivery.
	InboxTaskID string
	// PairRoomID is the pairing-code room a pair-purpose object was pre-uploaded
	// into, "" for every other kind. It is the room INSTANCE id, never the code:
	// codes are recycled, and binding to one would let a reissued code reach the
	// previous holder's ciphertext. See pairroom.go.
	PairRoomID string
	// CompletionVerifier is SHA-256 of the proof a receiver must present to end
	// this object's life — 32 bytes, or nil for an object that has none.
	//
	// Set only by a pair-room finalize, only when the SENDER asked for it, and
	// never derived by the server: it is the one end of a chain rooted in the file
	// key, which this server has never seen and never will (pairroom_complete.go).
	// Holding it lets the server CHECK a completion; it does not let the server
	// perform one, and it says nothing about the ciphertext it guards.
	//
	// nil is the ordinary state, not a degraded one. Every row written before this
	// column existed has it, every share and Device Inbox object has it, and a
	// pair-room object whose sender predates the capability has it — which is why
	// "no verifier" is answered with a distinct status rather than a refusal that
	// looks like a wrong proof.
	CompletionVerifier []byte
}

// StoredFileWrite is what a stored-file insert ACTUALLY landed — the row's own
// answer, produced inside the transaction that wrote it.
//
// It exists for one field. A pair-room object's expires_at is not the caller's to
// choose: it is the room's, every other object in the room carries it, and the
// room moves. Finalize used to compute it from a room snapshot plus its own
// clock, in the interval between recording its progress and inserting the row —
// and a sibling request (the batch's next file, or a retry of an append whose
// answer was lost) can move the room inside exactly that interval. The object
// then lands BEHIND its own room and expires early, alone in its batch, while the
// response under-reports the window the code registry is still admitting joins
// for. Nothing repairs it afterwards: the room's projection onto its objects only
// moves rows that are behind the value being written, and a later touch writes a
// value this row is already at.
//
// So the deadline is read where the row is written, and handed back rather than
// reconstructed. A post-write re-read would reopen the same gap one statement
// further along.
type StoredFileWrite struct {
	// Reason is "" when the row was inserted, and names the cap that refused it
	// otherwise: "storage" (the owner's plan) or "global" (the disk cap). A
	// non-empty Reason means NOTHING was written.
	Reason string
	// ExpiresAt is the deadline the row carries. For a pair-room object it is the
	// ROOM's, as its row stood inside this transaction — a sibling's move
	// included; for every other object it is simply what the caller asked for.
	// 0 when Reason is non-empty: there is no row to have a deadline.
	ExpiresAt int64
	// RoomJoinDeadline is the instant that room is joinable until, from the same
	// read — the number the pairing CODE is extended to, which is NOT ExpiresAt: a
	// joined room's objects have no expiry at all (pairRoomNoDeadline), and a code
	// extended to that would hold six of a million digits out of circulation for
	// good.
	//
	// 0 for an object with no room, for a refused insert, and for a room somebody
	// has already joined — which is the same "nothing to extend to" the two other
	// authoritative answers give (pairRoomCodeDeadline).
	RoomJoinDeadline int64
}

// UsageKind selects which per-month meter a RecordMeter call increments.
type UsageKind int

const (
	MeterUpload UsageKind = iota
	MeterDownload
)

// UnbilledMeter is one bill that is OWED: bytes that are known to have moved,
// whose meter write failed, and whose evidence has been (or is about to be)
// destroyed.
//
// It exists because two settlement paths bill something the database has never
// held — the size of a partial blob, read from the node an instant before the
// blob is deleted. Everywhere else the bill and the state change it belongs to
// are one transaction; there they cannot be, so the number is made durable on
// its own and GC settles it (see Store.SettleUnbilledMeter).
//
// Reason is free text naming the path that owed it. It is read by a human after
// something has already gone wrong, so it should say what and for which blob.
type UnbilledMeter struct {
	ID     string
	UserID string
	Kind   UsageKind
	Bytes  int64
	At     int64
	Reason string
}

// UserStats are a user's lifetime aggregate counters for the personal center /
// future metering. Monotonic (never decremented), survive file expiry/GC, and
// carry no per-event metadata (no timestamps, no downloader identity).
type UserStats struct {
	TransfersTotal int64 // stored download-links created (one per upload)
	DownloadsTotal int64 // successful downloads of this user's files (each fetch)
	UploadBytes    int64 // ciphertext bytes uploaded
	DownloadBytes  int64 // ciphertext bytes delivered to downloaders
}

// UploadEvent is an immutable ledger row for the rolling-24h upload quota. It is
// independent of StoredFile lifecycle: a file may be burned/expired and deleted,
// but the day's quota still counts. GC prunes rows older than ~25h.
type UploadEvent struct {
	ID         string
	UserID     string
	Bytes      int64
	UploadedAt int64
}

// Node is one registered relay node (SP1: fleet-owned pion/turn relay). urls are
// the node's turn: URLs; turn_secret is its static-auth-secret (so /api/ice can
// mint ephemeral credentials it will validate). relayed_bytes/stored_bytes are the
// node's own cumulative, keep-max counters fed from heartbeats.
type Node struct {
	ID            string
	OwnerType     string // "fleet" (SP3 adds "user")
	OwnerUserID   string // "" for fleet
	Label         string // human-set display name / note; seeded from the node token's name, editable
	Region        string
	URLs          []string
	TURNSecret    string
	Version       string
	RelayedBytes  int64
	StoredBytes   int64
	CreatedAt     int64
	LastSeenAt    int64
	StorageURL    string
	StorageSecret string
	// StorageFP is the SHA-256 fingerprint (hex) of the node's self-signed TLS
	// cert for its blob endpoint, reported at registration. When set (and the
	// StorageURL is https), central pins it on every blob call so the bearer
	// secret and blob traffic can't be sniffed/tampered on-path. Empty for legacy
	// http nodes not yet redeployed.
	StorageFP      string
	StorageEnabled bool
	StorageTotal   int64
	StorageFree    int64
	// StorageUnreachable is set when central could not reach this node's blob
	// endpoint, and cleared when it could. The heartbeat cannot stand in for it:
	// the heartbeat is node→central and blob writes are central→node, so a node
	// with its blob port firewalled shut heartbeats perfectly while every write
	// to it fails. Written only by the reachability probe — never by
	// register/heartbeat, or a node would clear its own mark seconds later.
	//
	// Zero value means eligible, so the gate fails open: a prober that has not
	// run yet, or is broken, must not empty the placement pool.
	StorageUnreachable bool
	// When the reachability probe last ran (unix seconds); 0 = never probed.
	StorageProbedAt int64
	// Admin-set hard caps for official (fleet) nodes; 0 = unlimited. TrafficLimit
	// is a monthly relay-bytes cap enforced in handleICE; DiskLimit caps stored
	// bytes and is enforced in StorageNodes placement.
	TrafficLimitBytes int64
	DiskLimitBytes    int64
	// DownloadURL is the node's PUBLIC base URL for direct client downloads (e.g.
	// https://node3.relayium.com), distinct from StorageURL (central's internal,
	// bearer-authed blob API). When set, central can 302 a client straight to
	// <DownloadURL>/dl/{key}?t=<token> so the bytes bypass central. '' = no direct
	// download; central proxies as before. Reported by the node at registration.
	DownloadURL string
	// UpdateStartedAt is when central last commanded this node to self-update
	// (unix seconds); 0 = no update in flight. The Part 2 rollout state machine
	// uses it to notice a node that never came back (timeout past its expected
	// self-update duration signals a stuck/failed update). Set by the rollout
	// state machine, NOT by node register/heartbeat — UpsertNode must never
	// overwrite it on a routine re-register (see the ON CONFLICT clause).
	UpdateStartedAt int64
	// UpdateFromVersion is the version this node was running when the update was
	// commanded, kept so a rollback target is known even after Version has
	// already changed (or the update failed partway through).
	UpdateFromVersion string
	// UpdateResult is the outcome the node last reported for a commanded
	// self-update: "" (none in flight / never asked), "ok", or "failed".
	UpdateResult string
	// UpdateAttempts used to count how many times central had told this node to
	// RESUME the update it already holds the claim for, bounding the fleet
	// resume path in handleUpdateCheck by POLL COUNT. That bound was
	// cadence-dependent (the poll interval is entirely client-side) so it has
	// been replaced by an elapsed-wall-clock check against UpdateStartedAt
	// (see updateSilenceLimit). Nothing writes this column anymore; it is kept
	// rather than dropped, per the package's schema-migration policy, and
	// simply reads 0 forever on both existing and new rows.
	UpdateAttempts int
	// Draining marks a node as being wound down for safe removal: it stays OUT
	// of the placement pool (StorageNodes/UserStorageNodes exclude it) so no new
	// file lands on it, but it keeps serving the files it already holds — those
	// still need to reach their TTL, since a file binds to exactly one node and
	// there are no replicas. Set only by an operator (SetNodeDraining), never by
	// register/heartbeat: UpsertNode's ON CONFLICT clause deliberately omits
	// this column so a node re-registering can't silently clear the flag out
	// from under an operator mid-drain.
	Draining bool
	// RemovedAt is when the node told central it was being uninstalled (unix
	// seconds); 0 = still installed. The row is KEPT rather than deleted so the
	// admin panel and audit trail still explain where a file's node went, but a
	// removed node is out of the placement pool, out of the ICE candidate list
	// and never receives a download redirect — the machine is gone, so pointing
	// anyone at it only produces a dead origin.
	//
	// Deliberately sticky: nothing clears it, not even a later re-register. The
	// uninstaller deregisters BEFORE it stops the service, so a dying node could
	// otherwise race a register and resurrect itself. A genuinely reinstalled
	// machine gets a fresh state.json (the uninstaller removes the state dir)
	// and therefore a new node ID, so it never needs the flag cleared.
	RemovedAt int64
	// ActiveTransfers is how many relay allocations this node was serving as of
	// its last heartbeat — a live gauge, not a total. It is the ONLY load signal
	// central has about a node, and it exists for one consumer: decideFleet's
	// canary pick, which gives the new build to the least-busy machine first
	// because that machine has the least to lose if the build is bad.
	//
	// Reported by the node as heartbeatBody.activeTransfers and written only by
	// TouchNode. It is a COUNT OF LIVE ALLOCATIONS, deliberately not len(usage):
	// the usage array skips allocations that have not yet joined a username and
	// includes ones that closed since the last heartbeat (they are reported one
	// final time so their bytes flush), so it answers "seen since the last
	// heartbeat", which is a different question.
	//
	// TRI-STATE, not a plain count: -1 means "no load signal for this node" —
	// either it has never heartbeated with this field (a binary older than the
	// field omits it entirely; see nodeHeartbeatReq.ActiveTransfers), or it has
	// never heartbeated at all. Any value >= 0 is a REAL reported count, 0
	// included. The two used to be the same value (0), which let an unreported
	// node tie with a genuinely idle one on canaryRank and win the fleetHash
	// tie-break outright — a systematic pull toward the machine central knows
	// least about during a mixed-version window, not merely a coin flip against
	// the rest of the fleet. See canaryRank for how the distinction is used.
	ActiveTransfers int
}

// NodeFileCount is a node's live-file footprint, as returned by
// CountFilesOnNode / NodeFileCounts: how many stored files still sit on it,
// and the furthest-out ExpiresAt among them — the earliest moment it is safe
// to uninstall. The zero value (both fields 0) is exactly "holds nothing,
// safe now", which is also what a node absent from NodeFileCounts' map means.
type NodeFileCount struct {
	Count        int
	MaxExpiresAt int64
}

// NodeToken is a per-user credential a BYO node presents as its bearer. The
// plaintext is shown once at mint; only its sha256 hash is stored. Binding to a
// node_id links it for per-node revoke/delete.
type NodeToken struct {
	ID         string
	TokenHash  string
	UserID     string
	NodeID     string
	Name       string
	CreatedAt  int64
	LastUsedAt int64
	RevokedAt  int64
}

// FleetToken is an admin-minted, userless bearer credential an official (fleet)
// node presents at register/heartbeat. Unlike NodeToken it has no owning user,
// so it lives in its own table rather than node_tokens (whose user_id is NOT
// NULL). Plaintext is shown once at mint; only its sha256 hash is stored.
type FleetToken struct {
	ID         string
	TokenHash  string
	Name       string
	NodeID     string
	CreatedAt  int64
	LastUsedAt int64
	RevokedAt  int64
}

// PendingNodeDelete is a blob GC has taken durable responsibility for: either
// its owning node was unreachable when its file expired/was deleted, or the row
// that used to point at it has been removed and this is now the ONLY record
// that those bytes must go. GC retries the node DELETE each sweep until it
// succeeds, reclaiming the orphan under the no-replication model.
type PendingNodeDelete struct {
	BlobKey    string
	NodeID     string
	EnqueuedAt int64
	// NotBefore is the instant this responsibility may be RETIRED — the row
	// dropped because a delete succeeded. 0 (the ordinary case) means "as soon as
	// one does": nothing can put the blob back, so the first success is the end
	// of it.
	//
	// A pairing room's void sets it, and it is the whole answer to the one race
	// a delete cannot win on its own. Central deletes the blob of an upload whose
	// session row it has just removed, and an append that read that row a moment
	// earlier is still streaming to the node: it lands AFTER the delete and
	// re-creates the key. Retiring the row on the first success would leave those
	// bytes with no owner at all — no session, no stored_files row, nothing for
	// any generic sweep to find. Holding it until every append that could still
	// be in flight has finished is what makes the responsibility outlive the
	// race, and outlive a crash in the middle of it.
	//
	// It is a hold on the ROW, never on the delete: the bytes go on the first
	// sweep that can reach the node, and every sweep in the hold window asks
	// again, so a re-created blob is removed by the next pass rather than
	// surviving to the end of the window.
	NotBefore int64
	// DeletedAt is when a delete for this key first SUCCEEDED, 0 if none ever
	// has. Only rows inside a hold can carry it: everywhere else the success is
	// the end of the row.
	//
	// It is what makes age eviction safe. A row is retired by age only once it
	// has one, because until then the row is not a hold on a discharged
	// responsibility — it is the only record that the blob exists at all, its
	// stored_files or upload_sessions row having been deleted in the same
	// transaction that created it. See Store.RetirePendingNodeDeletes.
	DeletedAt int64
	// BillUserID, when non-empty, is a BILLING obligation riding on the row: any
	// bytes the blob turns out to hold past BilledThrough (clamped to BillMax)
	// must be durably billed to this user, as BillKind, BEFORE the bytes are
	// destroyed — the blob is the last evidence of the number, so destroying it
	// first would make the bill unrecoverable.
	//
	// Written by a pairing room's close for its upload-session blobs, in the
	// SAME transaction that deletes the session rows: that ordering is what lets
	// the obligation survive a database that refuses every write afterwards.
	// The settle paths (Service.settleBlobBillingDurably, GC.drainPending)
	// advance BilledThrough atomically with the meter or journal write, so a
	// crash between "billed" and "recorded as billed" cannot double-charge.
	// "" — the ordinary case — is a deletion-only row, exactly as before.
	BillUserID string
	BillKind   UsageKind
	// BillMax caps what the blob's self-reported size can be billed as: a node
	// is free to answer a probe with anything, and max_size is the most this
	// upload was ever authorized to write.
	BillMax int64
	// BilledThrough is the durable billing floor: bytes [0, BilledThrough) are
	// already metered or journaled. Monotonic — settling never lowers it.
	BilledThrough int64
}

// PairRoomClosure is everything one room close took responsibility for: the
// single, transactional enumeration of the ciphertext a voided room owns.
//
// Both halves are ciphertext the room's deadline governs, and before this had
// two of them only the first was reclaimed — an upload still in flight when the
// deadline passed kept its partial blob and its session until the generic
// one-hour reaper, twelve times the window the room promised.
//
// The close is exactly-once, so exactly one of two racing voids receives a
// non-empty closure and no artifact can be reclaimed (or double-deleted) twice.
type PairRoomClosure struct {
	// Objects are the finalized stored_files rows bound to the room: blob and
	// row both go.
	Objects []StoredFile
	// Sessions are the upload sessions the room held, in whatever state they were
	// in — open, finalized-but-not-persisted, or in the unresolved recovery
	// state. Their ROWS ARE ALREADY GONE: the close settled each one's meter and
	// deleted it inside the same transaction, so the account's open-session slots
	// and the room's bindings are free the instant the close commits, whatever
	// any node is doing.
	//
	// What comes back is therefore a work list, not live state. Each row is the
	// last thing the database knew about that upload, and the caller's remaining
	// job is physical and best-effort: ask the blob how big it really is (bill
	// the delta), then delete it (Service.settleReclaimedUpload). Every one of
	// them already has a durable delete intent queued by this transaction, so a
	// caller that runs out of budget — or dies — loses accuracy on the residual,
	// never the bytes.
	//
	// An earlier version handed these back untouched and claimed them one at a
	// time afterwards, so that an append still in flight kept committing against
	// an open session. That bought the bytes of one in-flight chunk and cost the
	// property the room exists to enforce: a claim that never came (a finalize
	// that crashed holding it, a budget that expired) left the session, its slot
	// and its ciphertext alive until the generic one-hour reaper.
	Sessions []UploadSessionRow
}

type PairRoomOwnerReleaseOutcome int

const (
	PairRoomOwnerReleaseGone PairRoomOwnerReleaseOutcome = iota
	PairRoomOwnerReleaseWaiting
	PairRoomOwnerReleaseUploading
	PairRoomOwnerReleaseDone
)

// PairRoomHolding is ONE of an account's own pair rooms, as the account is
// allowed to see it.
//
// It is the answer to a question nothing could ask before: a joined room has no
// deadline at all (pairroom.go, invariant 5), so its ciphertext sits on the
// account's storage — and therefore against its plan's cap — with no expiry, no
// entry in the share list (which is deliberately shares only, files.go) and no
// control anywhere. Charged and invisible is the one combination an account
// surface may not leave standing.
//
// NOTE WHAT IS NOT IN IT, because the omissions are the design rather than an
// oversight. There is no CODE (six digits that may since have been minted to a
// stranger, and a credential to a rendezvous either way), no object id, no blob
// key, no node identity, no completion verifier, no encrypted manifest and
// nothing at all about the peer who joined. What is left is the room's own
// identity, when it opened, when somebody joined it, and how much ciphertext it
// is holding — which is exactly the information needed to decide whether to let
// it go, and nothing that helps anyone reach it.
type PairRoomHolding struct {
	// RoomID is the room INSTANCE id — opaque, never the pairing code. It is what
	// a release names, and it is safe to show: it authorizes nothing on its own
	// (release is owner-bound) and it cannot be resolved to ciphertext by anyone.
	RoomID string
	// CreatedAt is when the room opened; JoinedAt when a second participant
	// entered it. JoinedAt is always > 0 here — an unjoined room is not listed at
	// all (see ListPairRoomHoldings).
	CreatedAt int64
	JoinedAt  int64
	// Objects and Bytes are the finalized ciphertext this room holds: the count
	// of stored_files rows bound to it and the sum of their sizes. Bytes is the
	// same number CurrentStorage counts for these rows, so the figure shown next
	// to a storage meter and the figure the meter itself sums cannot disagree.
	//
	// Bytes deliberately excludes an upload still in flight: it has no
	// stored_files row yet, so CurrentStorage does not count it either, and a
	// surface that added it would be reporting storage the plan is not charging
	// for.
	Objects int64
	Bytes   int64
	// Releasable is the SERVER's own eligibility verdict, computed here so no
	// client has to reconstruct it. False while an upload session is still bound
	// to the room — a file of the batch that was already in flight when the peer
	// joined, which §3 of the protocol promises is allowed to finish. Releasing
	// then would throw away bytes the sender is being billed for and was told it
	// could send, so the release endpoint refuses it with the same verdict.
	//
	// It can only ever go from false to true while a room is listed: no NEW
	// upload can bind to a joined room (pairRoomForUpload refuses one with
	// errPairRoomJoined), so the session set of a joined room only shrinks.
	Releasable bool
}

// PairRoomHoldings is one answer to "what pair-room ciphertext is this account
// holding": a BOUNDED page of rooms, plus totals that are not bounded.
//
// The split is deliberate. The row list has a hard cap so one account cannot ask
// the server to materialize an unbounded result set, but the AGGREGATE has to
// stay complete or the surface would under-report the storage it exists to
// explain — a number smaller than the storage meter beside it is worse than no
// number at all. Totals are therefore computed over every qualifying room, and
// Truncated says plainly when the list is showing fewer rooms than the totals
// count.
type PairRoomHoldings struct {
	Rooms []PairRoomHolding
	// Total is over ALL qualifying rooms, including any the page left out.
	Total PairRoomHoldingTotals
	// Truncated reports that the cap bit: there are more rooms than Rooms holds.
	Truncated bool
}

// PairRoomHoldingTotals is the account-wide aggregate over every joined, open
// room holding ciphertext — the row count, the object count and the bytes.
type PairRoomHoldingTotals struct {
	Rooms   int64
	Objects int64
	Bytes   int64
}

// BlobRef names ONE piece of ciphertext to reclaim: the key, and the node
// holding it ("" = central-local storage). It is everything the caller needs to
// delete-or-enqueue a blob and deliberately nothing else — a finalized
// stored_file's ciphertext and an abandoned upload's partial blob are the same
// job once their rows are gone, and the reclaim path should not have to care
// which kind of row a key came from.
type BlobRef struct {
	BlobKey string
	NodeID  string
}

// RolloutTrack is the persisted state of one automatic node-update rollout
// track ("fleet" or "byo"). This is the ONLY thing Part 1's per-node
// `relayium-node update -to` subcommand doesn't decide for itself: which node
// updates to which version, when.
//
// There are always exactly two independent rows, keyed by Track, and this is
// deliberate: the fleet (our ~16 official nodes) and byo (unbounded
// user-owned nodes) tracks must be able to hold DIFFERENT TargetVersions and
// DIFFERENT Statuses at the same time. A stalled or halted BYO rollout (users'
// nodes are out of our control — one could be offline, pinned to an old
// binary, whatever) must never block shipping the next release to our own
// fleet. Collapsing this into a single row would silently destroy that
// property, so don't "simplify" it that way.
type RolloutTrack struct {
	Track string // "fleet" | "byo"
	// TargetVersion is the version this track is currently rolling out to.
	TargetVersion string
	// PreviousVersion is the target this track held immediately BEFORE
	// TargetVersion, and it is the only version Service.RollbackByoToPreviousVersion
	// will point the byo track at. It is written on the byo track only, by the
	// same chokepoint that changes a target, so its invariant is exact: every
	// value that ever lands here passed the byo-behind-fleet gate at the moment
	// it was set (or is a version this track was already rolled back onto,
	// which passed it earlier for the same reason). That is what makes the
	// rollback path safe to run without re-consulting the gate — it can never
	// name a version the fleet has not vetted. '' means "no history": the
	// track is on its first target and there is nothing to roll back to.
	PreviousVersion string
	// CurrentNodeID is the fleet node presently being updated (fleet track
	// only; fleet nodes are updated one at a time). Unused for byo.
	CurrentNodeID string
	// ByoBatch is the batch size in flight for the byo track (10 | 50 | 100
	// nodes at once). Unused for fleet.
	ByoBatch int
	// FirstNodeID is the node that was picked FIRST in the current rollout —
	// the canary that gets the long (6h) observation window. It is recorded
	// positionally, when the rollout picks its first node (decideFleet reports
	// this via RolloutDecision.IsFirst), and must NOT be re-derived from fleet
	// version state: "no other node is on target" is false for a freshly
	// provisioned node already shipping the new build, a hand-updated node, or
	// a resumed rollout, and every one of those would silently cut the canary
	// window to 30min. Cleared when a new rollout starts. Fleet track only.
	FirstNodeID string
	// StageStartedAt is when the current stage (this node / this batch) began
	// (unix seconds), for the state machine's timeout check. It MUST be
	// rewritten on EVERY stage transition (each time CurrentNodeID / ByoBatch
	// changes): decideFleet measures the observation window from it, so a value
	// left over from the previous stage would expire the next node's window
	// early. decideFleet defends against that by taking the later of this and
	// the node's own UpdateStartedAt, but that defence is a backstop, not a
	// licence to leave the field stale.
	StageStartedAt int64
	Status         string // "rolling" | "halted" | "complete"
	// HaltedReason is a human-readable note on why Status == "halted" (e.g. a
	// heartbeat timeout or an elevated post-update failure rate). '' otherwise.
	HaltedReason string
	// Emergency releases the WHOLE track at once: while it is set, the update
	// check bypasses the staged ladder entirely (the fleet's one-node-at-a-time
	// queue with its 6h canary window, and the byo 10/50/100 batches) and tells
	// every node of the track that is behind the target to update on its next
	// poll. It is set ONLY by the admin emergency-release action, which is
	// step-up confirmed and audited, and it is cleared by every other way a
	// track's state is written — SetTargetVersion's whole-row replace and
	// ResumeRolloutTrack both put the track back on the staged ladder — so a
	// track can never be left in emergency mode by accident.
	//
	// It deliberately gives up the failure gating that goes with staging: an
	// emergency release ships to everyone at once, so there is no canary left
	// whose failure could stop it. The admin's 暂停 (pause) control is the kill
	// switch, since a track that is not 'rolling' is inert on every path.
	Emergency bool
	// ManualFast makes the fleet ladder run at speed instead of over ~14 hours.
	// It removes exactly one thing — the WAITING: the canary's 6h observation
	// window and the 30min soak between nodes (see decideFleet). Everything the
	// staged ladder does to stop a bad release is kept, and that list is why the
	// mode exists separately from Emergency:
	//
	//   - at most ONE fleet node holds the slot at a time, via the same
	//     ClaimRolloutNode compare-and-swap;
	//   - every node still downloads, signature-verifies, installs, restarts and
	//     passes its own updater health watch, local rollback intact;
	//   - the queue advances only once the node in flight has REPORTED "ok" — not
	//     merely once it is SEEN on the target version, which happens the moment
	//     the new binary starts, up to healthWindow before its updater has
	//     decided whether to roll it back;
	//   - a failure, rollback, silence, wedge, missing or contradictory result
	//     halts the track before any later node is commanded.
	//
	// So it is the opposite of Emergency, which releases the whole track at once
	// with no queue and no failure gating: Emergency trades safety for reach,
	// this trades nothing but time. One action must never set both.
	//
	// FLEET ONLY, by construction rather than by a check: the only writer is
	// Service.StartManualFastFleetRollout, which takes no track parameter, behind
	// a route with "fleet" spelled out. The byo ladder exists to keep our own
	// fleet ahead of every user's machine, and "faster" is not a reason to
	// mass-push hardware we do not own.
	//
	// Cleared by every other way a track's state is written (SetTargetVersion's
	// whole-row replace writes it false, ResumeRolloutTrack and
	// CompleteRolloutTrack zero it), so a track cannot be left in fast mode by
	// accident. HaltRolloutTrack is the deliberate exception: a halted track
	// keeps the flag so the panel can say which kind of rollout stopped.
	ManualFast bool
	// FastAfterCanary is the SAFE first-use form of the fast fleet ladder: the
	// canary keeps its ENTIRE six-hour observation window and must additionally
	// report "ok" while actually running the target; only AFTER that first node
	// has passed both does the rest of the fleet run without the 30-minute soak
	// between nodes.
	//
	// It exists because ManualFast alone cannot be the first thing a version ever
	// gets: that mode advances the moment the node in flight reports success, so
	// the very first machine to run a never-before-fleet-tested build hands the
	// slot on ~10 minutes later, and a release that only breaks after hours of
	// real traffic reaches every node before anything notices. That is precisely
	// what fleetFirstWindow exists to catch, and the manual-fast runbook already
	// says the mode must not be used to validate a version no fleet canary has
	// passed. This field is the entry point that obeys that rule instead of
	// asking an operator to.
	//
	// What it keeps, beyond the canary window: everything ManualFast keeps (one
	// node at a time via the same compare-and-swap, each node's own download,
	// signature verification, install, restart, health watch and local rollback),
	// and it is STRICTLY SAFER than ManualFast on the canary — the two differ in
	// exactly one thing, whether the first node's six hours are skipped, and this
	// is the mode that KEEPS them. It is looser than ManualFast nowhere.
	// Everywhere else the two share the same failure gates: every bad outcome
	// halts on BOTH — failed, rolled_back, skipped, unreachable, silence, wedge, a
	// missing result inside fleetInstallLimit, and "ok" reported while not on the
	// target version.
	//
	// What it drops: only the 30-minute inter-node soak, and only for the nodes
	// AFTER the canary. There is no adjustable canary duration on purpose — a
	// tunable observation window is a dial that gets turned down under pressure,
	// which is the one circumstance in which it is load-bearing.
	//
	// MUTUALLY EXCLUSIVE with Emergency and ManualFast, enforced at every write
	// rather than trusted: each of the three start paths writes all three columns
	// explicitly (StartCanaryFastRollout, StartManualFastRollout,
	// setTargetVersion's whole-row replace), and the retained
	// SQLiteStore.SetRolloutEmergency clears both fast columns in the same
	// statement that arms emergency, so no row can carry two modes. See
	// decideFleet for the defensive precedence if one ever did.
	//
	// FLEET ONLY, by the same construction as ManualFast: the only writer is
	// Service.StartCanaryFastFleetRollout, which takes no track parameter, behind
	// a route with "fleet" spelled out.
	//
	// Cleared by every path back into 'rolling' that is not this mode
	// (SetTargetVersion, ResumeRolloutTrack, StartManualFastRollout) and by
	// CompleteRolloutTrack. HaltRolloutTrack is the same deliberate exception it
	// is for ManualFast: a halted track keeps the flag so the panel and an
	// incident review can say which kind of rollout stopped.
	FastAfterCanary bool
}

// Setting is one admin-editable integer config value (bytes or seconds).
type Setting struct {
	Key       string
	Value     int64
	UpdatedAt int64
}

// ReleaseCheck is the single row behind the admin panel's "a newer release
// exists" notice: what the last SUCCESSFUL check saw, and which tag the
// operator dismissed.
//
// Both halves are persisted rather than held per-process because central is
// built to run as several instances (see the admin-session and TOTP-guard
// notes on Service). Process-local state would have each instance polling on
// its own schedule and the "last checked" line jumping around depending on
// which one served the page, while the dismissal beside it stayed consistent.
//
// CheckedAt == 0 means no check has ever SUCCEEDED. That is a state the panel
// renders in its own words; it is never rendered as "up to date".
type ReleaseCheck struct {
	LatestTag    string
	CheckedAt    int64
	DismissedTag string
	DismissedAt  int64
}

// AdminUserRow 是后台用户列表的一行聚合视图（只读）。
type AdminUserRow struct {
	ID            string
	Email         string
	DisplayName   string
	CreatedAt     int64
	Methods       []string // identities 表里的 provider 去重升序
	DeviceCount   int
	RelayedBytes  int64  // 选定月的中继流量（来自 usage_events）
	UploadBytes   int64  // 选定月上传（usage_monthly）
	DownloadBytes int64  // 选定月下载（usage_monthly）
	StorageBytes  int64  // 当前存储占用（未过期文件 size 之和，与月份无关）
	PlanID        string // 当前套餐（plans.id）
	// SubscriptionStatus mirrors users.subscription_status ('' when there is
	// no active Stripe subscription). PlanSource mirrors users.plan_source
	// ('' default/free, 'admin' manual comp, 'stripe' webhook-assigned).
	SubscriptionStatus string
	PlanSource         string
}

// AdminUserQuery 参数化后台用户列表查询。
type AdminUserQuery struct {
	Search  string // 空 = 不过滤;非空按 email/display_name 模糊匹配
	SortBy  string // "created"|"email"|"relayed"|"upload"|"download"|"storage";非法回退 "created"
	SortDir string // "asc"|"desc";非法回退 "desc"
	Period  string // 'YYYYMM'，决定上传/下载/中继列的口径
	Now     int64  // 用于存储占用的"未过期"判定
	Limit   int
	Offset  int
}

// AdminMetrics 是后台首页的快照指标。存储/用户/文件为当前快照;上传/下载/中继为选定月合计。
type AdminMetrics struct {
	TotalUsers        int64
	ActiveStoredFiles int64 // 未过期暂存文件数(expires_at > now)
	ActiveStoredBytes int64 // 上述文件 size 之和(近似当前磁盘占用)
	UploadBytes       int64 // 选定月上传合计
	DownloadBytes     int64 // 选定月下载合计
	RelayBytes        int64 // 选定月中继合计
}

// AdminCredential is one registered admin passkey. CredJSON holds the full
// webauthn.Credential record (public key, sign counter, flags, transports,
// attestation) as JSON: the library requires the whole record be preserved and
// written back after each successful login, so it is not split into columns.
// UserHandle is the WebAuthn user ID, identical across all rows and
// deliberately decoupled from RELAYIUM_ADMIN_USER so renaming the admin does
// not silently invalidate every registered passkey.
type AdminCredential struct {
	ID         string
	UserHandle []byte
	CredJSON   []byte
	Name       string
	CreatedAt  int64
	LastUsedAt int64
}

// AuditEntry 是一条管理员操作记录。永久保留，不参与 GC。
//
// Auth 与 StepUp 是两个不同的维度：Auth 是**建立当前会话**时用的登录方式，
// StepUp 是**这一次操作**实际验的第二因子。用 passkey 登录、用 TOTP 步进是
// 完全正常的组合，合并成一列就再也还原不出当时发生了什么。
type AuditEntry struct {
	ID     int64
	At     int64
	Actor  string
	IP     string
	Auth   string // "password" | "passkey"
	Action string
	Target string
	// Changes 是 []ChangeField 的 JSON。存**存储层原始值**（bytes/secs），
	// 不存表单里的 MB/GB/天 —— 单位混用会让日志和库里的实际值对不上。
	Changes string
	// StepUp: "" = 该操作无需步进；"grace" = 落在 60 秒宽限期内跳过了因子校验。
	// grace 必须单独标记而不是记成验过了，否则日志会在最要紧的地方说谎。
	StepUp string
}

// Store is the only abstraction that touches persistent storage. Implemented by
// SQLiteStore today; a Postgres impl could replace it without changing callers.
type Store interface {
	// users + identities
	UpsertUserByEmail(ctx context.Context, email, displayName string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)
	LinkIdentity(ctx context.Context, provider, subject, userID string) error
	GetUserByIdentity(ctx context.Context, provider, subject string) (User, bool, error)
	// ListIdentityProviders returns the distinct OAuth providers linked to a
	// user ("google"/"apple"/…), sorted, for surfacing + the unlink guard.
	ListIdentityProviders(ctx context.Context, userID string) ([]string, error)
	// UnlinkIdentity removes a user's link to one provider (owner-scoped).
	// Returns ErrNotFound when no such link exists.
	UnlinkIdentity(ctx context.Context, provider, userID string) error
	// UnlinkIdentityIfSafe atomically removes a provider link only if the account
	// keeps at least one login method afterward, closing the concurrent-unlink
	// lockout race. Returns deleted, wouldOrphan (refused — last method), and err.
	UnlinkIdentityIfSafe(ctx context.Context, provider, userID string) (deleted, wouldOrphan bool, err error)
	SetPassword(ctx context.Context, userID, passwordHash string) error
	// ClearPassword removes a user's password credential (NULLs password_hash),
	// so GetCredentials/HasPassword no longer report a usable password. Used to
	// drop a password that was planted on an unverified account before an
	// external identity provider proves ownership of the email.
	ClearPassword(ctx context.Context, userID string) error
	GetCredentials(ctx context.Context, email string) (userID, passwordHash string, ok bool, err error)
	// UserByCanonicalEmail looks up an account by its folded canonical email form
	// (H2b anti-Sybil register dedupe: strips +tag for all domains, dot-folds
	// gmail.com/googlemail.com). Distinct from normEmail, which stays exact for
	// login/identity.
	UserByCanonicalEmail(ctx context.Context, canonical string) (User, bool, error)
	// InsertUserDedupedByCanonical atomically checks-then-inserts a new user by
	// canonical email form in a single transaction, closing the TOCTOU race a
	// separate UserByCanonicalEmail-then-UpsertUserByEmail pair leaves open:
	// concurrent Register calls for canonicalization-equivalent addresses (e.g.
	// a+x@gmail.com / a+y@gmail.com / a.b@gmail.com) can otherwise all read "not
	// taken" before any of them inserts. taken=true means some existing row
	// (any exact email) already owns this canonical form; nothing was written and
	// the returned User is the zero value.
	InsertUserDedupedByCanonical(ctx context.Context, email, displayName, canonical string) (u User, taken bool, err error)
	HasPassword(ctx context.Context, userID string) (bool, error)
	// ClaimTOTPStep atomically advances the admin TOTP replay guard to `step` iff
	// step is strictly newer than the last committed one, in a single writer
	// statement. ok=false means the step was already spent on ANY instance
	// (replay / stale) — this is what makes admin 2FA "one code, one use" hold
	// across instances and across process restarts. Call it after the credential
	// check passes; a false result must fail the login / step-up.
	ClaimTOTPStep(ctx context.Context, step int64) (ok bool, err error)
	// Admin sessions live in the store (shared across instances), not a
	// per-process map. See the multi-instance-state-migration doc in relayium-ops, item #4.
	CreateAdminSession(ctx context.Context, token, auth, credFP string, expires int64) error
	AdminSession(ctx context.Context, token, credFP string, now int64) (auth string, lastStepUpAt int64, ok bool, err error)
	MarkAdminStepUp(ctx context.Context, token string, at int64) error
	DeleteAdminSession(ctx context.Context, token string) error
	PurgeExpiredAdminSessions(ctx context.Context, now int64) error
	// Pending high-risk actions live in the store (claimable exactly once on any
	// instance). See the multi-instance-state-migration doc in relayium-ops, item #2.
	PutPendingAction(ctx context.Context, token, sessionTok, action, form, pathID string, now, expires int64, cap int) (ok bool, err error)
	TakePendingAction(ctx context.Context, token string) (sessionTok, action, form, pathID string, expires int64, ok bool, err error)
	// In-flight WebAuthn ceremonies live in the store (spendable exactly once on
	// any instance). session is the json-encoded webauthn.SessionData. Item #3.
	PutPasskeyCeremony(ctx context.Context, token, kind, session, name string, now, expires int64, cap int) (ok bool, err error)
	TakePasskeyCeremony(ctx context.Context, token string) (kind, session, name string, expires int64, ok bool, err error)
	// Resumable upload sessions live in the store (multi-instance + restart-safe).
	// See the multi-instance-state-migration doc in relayium-ops, item #9.
	CreateUploadSession(ctx context.Context, row UploadSessionRow, maxPerUser int) (ok bool, err error)
	GetUploadSession(ctx context.Context, id, userID string) (UploadSessionRow, bool, error)
	// CommitUploadProgress records ONE committed append: it advances the session's
	// offset to the blob's authoritative size (only ever forward, only while the
	// session is open, never past max_size), adds exactly the bytes that advance
	// bought to the session's metered ledger AND to the account's monthly traffic,
	// and — for a pre-upload — moves its pairing room's deadline and projects that
	// deadline onto the room's objects. All in ONE transaction.
	//
	// One transaction is the point. These used to be three best-effort writes, so
	// a failure between them could bill bytes twice, bill none at all, or leave a
	// progressing upload's room expiring underneath it. Together they are either
	// all true or all false, and "all false" is a failed request the client
	// retries — the blob's own size is authoritative, so the retry re-derives the
	// same delta and bills it exactly once.
	//
	// The pairing-room half carries a PRECONDITION, evaluated inside the same
	// transaction: bytes may only buy a deadline for a room that is still open
	// and inside its own. A room that closed after the caller's check and before
	// this write comes back as RoomOpen=false — the bytes are still committed and
	// still billed, because they moved, but no deadline is projected and the
	// caller must refuse the request rather than hand back success for ciphertext
	// nobody can reach.
	CommitUploadProgress(ctx context.Context, p UploadProgress) (UploadProgressResult, error)
	// ReconcileUploadMeter charges the account for every committed byte of this
	// session that is not on its meter yet (received - metered), atomically with
	// moving the session's ledger to match, and returns what it billed.
	//
	// Idempotent by construction: a second call bills nothing. Non-billable
	// (own-node) sessions bill nothing at all.
	//
	// It is the reconcile for a session that is ALREADY terminal (the orphan-row
	// pass). The way an upload normally ends reconciles inside ClaimUploadDone,
	// because a bill that can fail separately from the claim it belongs to is a
	// bill that gets skipped.
	ReconcileUploadMeter(ctx context.Context, id string, now int64) (billed int64, err error)
	// ClaimUploadDone atomically marks the session terminal, settles its meter and
	// returns the offset at that instant, stamping last_activity=now. ok=false ⇒
	// already claimed (a racing finalize/reaper won).
	//
	// The claim and the reconcile are ONE transaction on purpose. They used to be
	// two calls, and the second one's error was logged: a transient failure there
	// left a session claimed, its committed bytes unbilled, and the row deleted
	// moments later by the very caller that logged it — a permanent underbill with
	// no record left of what was lost. Together they are all-or-nothing, so a
	// failure claims nothing and the caller's retry settles it exactly once.
	ClaimUploadDone(ctx context.Context, id string, now int64) (received, billed int64, ok bool, err error)
	DeleteUploadSession(ctx context.Context, id string) error
	// ListExpiredOpenUploadSessions returns open sessions idle since ≤ before.
	// Never a session already in the recovery state (see MarkUploadUnresolved).
	ListExpiredOpenUploadSessions(ctx context.Context, before int64) ([]UploadSessionRow, error)
	// ListOrphanDoneUploadSessions returns finalized rows idle since ≤ before whose
	// blob no stored_files row references (a finalize that crashed before persist).
	//
	// EXCLUDES rows in the recovery state. Their blob is the only thing that can
	// still say how many bytes the node accepted, and this pass drops blobs.
	ListOrphanDoneUploadSessions(ctx context.Context, before int64) ([]UploadSessionRow, error)
	// PurgeDoneUploadSessions deletes finalized rows idle since ≤ before (their
	// blob is either a live file or already dropped by the orphan pass). Rows
	// whose meter is short, and rows in the recovery state, are never purged:
	// the row is the only record of what an upload accepted.
	PurgeDoneUploadSessions(ctx context.Context, before int64) error
	// MarkUploadUnresolved moves an abandoned open session into the RECOVERY
	// state: terminal for the client, but explicitly NOT settled. ok=false ⇒ the
	// session was claimed by a racing finalize or reaper first.
	//
	// It is what the reaper does instead of settling a session whose blob it
	// cannot reach. `received` is a lower bound there — the node may hold bytes
	// no append survived to record — so writing the session off against it
	// permanently underbills committed traffic and destroys the only evidence
	// that could ever correct it. This keeps the evidence instead, and hands the
	// session to the paced recovery pass below.
	MarkUploadUnresolved(ctx context.Context, id string, now int64) (ok bool, err error)
	// ListUnresolvedUploadSessions returns recovery-state rows whose last probe
	// attempt was at/before `before`, oldest attempt first, at most limit — so
	// one sweep's work is bounded however many nodes are away.
	ListUnresolvedUploadSessions(ctx context.Context, before int64, limit int) ([]UploadSessionRow, error)
	// NoteUnresolvedProbe records that a re-probe was attempted and failed,
	// which is what paces the next one. It settles nothing.
	NoteUnresolvedProbe(ctx context.Context, id string, now int64) error
	// SettleUnresolvedUpload closes the recovery state with the blob's own
	// authoritative size: the offset moves to it (clamped to max_size, so a
	// lying node cannot inflate the bill), every byte of it that is not on the
	// account's meter is charged, and unresolved_at is cleared — all in one
	// transaction. Returns what it billed.
	//
	// Only ever called with a size a probe actually returned. There is no
	// variant that settles without one: "the node did not answer" is not a size.
	SettleUnresolvedUpload(ctx context.Context, id string, size, now int64) (billed int64, err error)
	EmailVerified(ctx context.Context, userID string) (bool, error)
	SetEmailVerified(ctx context.Context, userID string) error
	// SetOnlyOwnNodes toggles the BYO-nodes-only restriction (SP3) for a user.
	SetOnlyOwnNodes(ctx context.Context, userID string, on bool) error
	// SetUserPlan assigns a user's billing tier (plans.id). now is the change
	// timestamp, used to freeze the outgoing tier's earned quota segment.
	SetUserPlan(ctx context.Context, userID, planID string, now int64) error
	// SetUserPlanAdmin assigns a user's billing tier from the admin console,
	// recording plan_source='admin' so a later Stripe webhook won't override it.
	SetUserPlanAdmin(ctx context.Context, userID, planID string, now int64) error
	// SetUserStripeCustomer binds a user to their Stripe customer id.
	SetUserStripeCustomer(ctx context.Context, userID, customerID string) error
	// SetUserStripeCustomerIfEmpty binds a customer id only if the user has none
	// yet, returning the id now in force (the existing one if already bound).
	SetUserStripeCustomerIfEmpty(ctx context.Context, userID, customerID string) (string, error)
	// SetUserStripeSubscription records the canonical subscription id ('' clears).
	// It also claims that id on the Stripe source row, in the same transaction,
	// and so returns ErrExternalSubscriptionOwned when another account already
	// owns it — a refusal to adopt, not a transient failure to retry past.
	SetUserStripeSubscription(ctx context.Context, userID, subID string) error
	ClaimStripeWebhookEvent(ctx context.Context, eventID, eventType string, now int64) (StripeWebhookClaim, error)
	FinishStripeWebhookEvent(ctx context.Context, eventID string, claimGeneration int64, processed bool, failure string, now int64) error
	// GetUserByStripeCustomer looks up a user by Stripe customer id (webhook
	// dispatch). An empty customerID returns not-found.
	GetUserByStripeCustomer(ctx context.Context, customerID string) (User, bool, error)
	// ListStripePaidUsers returns active users on a Stripe-sourced paid plan with
	// a customer id — candidates for the periodic reconcile sweep that downgrades
	// anyone whose subscription was canceled but whose deletion webhook was missed.
	ListStripePaidUsers(ctx context.Context) ([]User, error)
	// SetUserSubscription updates plan_id, subscription_status, subscription_end,
	// and plan_source together (Stripe webhook path). now is the change timestamp,
	// used to freeze the outgoing tier's earned quota segment. subEventAt is the
	// Stripe event.created (0 for non-webhook callers), stored monotonically for
	// the ordering guard.
	SetUserSubscription(ctx context.Context, userID, planID, status string, end int64, source, cycle string, now, subEventAt int64) error
	// LastSubEventAt returns users.sub_event_at (0 if none). Legacy: the
	// ordering authority is LastSourceEventAt, per provider. See its comment in
	// sqlite.go for why the column is still maintained.
	LastSubEventAt(ctx context.Context, userID string) (int64, error)

	// ---- Provider-neutral subscription state (see entitlement.go) ----

	// ApplySubscriptionSource records one provider's event on that provider's
	// own row — with that provider's own replay clock — and recomputes the
	// user's effective entitlement projection, in one transaction. A stale
	// event for its provider changes nothing and reports Applied=false.
	ApplySubscriptionSource(ctx context.Context, ev SourceEvent) (SubscriptionApply, error)
	ApplyAuthorizedStripeLifecycle(ctx context.Context, ev SourceEvent) (SubscriptionApply, error)
	BillingAuthority(ctx context.Context, userID string) (BillingAuthority, bool, error)
	// GetSubscriptionSource returns one provider's recorded state for a user.
	GetSubscriptionSource(ctx context.Context, userID, provider string) (SubscriptionSource, bool, error)
	// ListSubscriptionSources returns every provider row a user holds.
	ListSubscriptionSources(ctx context.Context, userID string) ([]SubscriptionSource, error)
	// LiveEntitlementProviders names the providers currently granting this user
	// paid access, sorted. More than one is the double-billing state clients
	// must surface rather than hide.
	LiveEntitlementProviders(ctx context.Context, userID string) ([]string, error)
	// LastSourceEventAt returns one provider's last applied event clock (0 when
	// that provider has never been seen).
	LastSourceEventAt(ctx context.Context, userID, provider string) (int64, error)
	// BindExternalSubscription binds an external subscription id to a user's
	// provider row, first-write-wins across users ('' clears it). Returns
	// ErrExternalSubscriptionOwned when another account already owns that id.
	BindExternalSubscription(ctx context.Context, userID, provider, externalID string) error
	// UserByExternalSubscription resolves the owner of an external subscription
	// id. An empty id returns not-found.
	UserByExternalSubscription(ctx context.Context, provider, externalID string) (string, bool, error)
	// EnsureAppleAccountToken binds candidate as the user's stable App Store
	// appAccountToken if they have none, returning whichever value is in force.
	// It is an attribution key, never an authorization one.
	EnsureAppleAccountToken(ctx context.Context, userID, candidate string) (string, error)
	// UserByAppleAccountToken resolves the account a token belongs to. An empty
	// or malformed token returns not-found rather than scanning.
	UserByAppleAccountToken(ctx context.Context, token string) (User, bool, error)
	ApplyAppleRenewalState(ctx context.Context, state AppleRenewalState) (bool, error)
	GetAppleRenewalState(ctx context.Context, userID string) (AppleRenewalState, bool, error)
	// AppleProductPlan resolves one app's product id to a Relayium tier, keyed
	// by bundle identity as well as product id (the macOS and iOS apps ship
	// different bundle ids). An empty key returns not-found, and so does a
	// mapping whose tier has since been retired: the tier is re-checked at read
	// time, because retiring a plan never revisits the mappings pointing at it.
	AppleProductPlan(ctx context.Context, bundleID, productID string) (AppleProduct, bool, error)
	// GetAppleProduct reads ONE raw catalog row by its exact key, whatever state
	// it is in — retired, or pointing at a retired or missing tier. It is the
	// read an admin confirmation "before" image needs; AppleProductPlan above is
	// the live-only projection and would report every one of those as absent.
	GetAppleProduct(ctx context.Context, bundleID, productID string) (AppleProduct, bool, error)
	// ListAppleProducts returns every raw catalog row, in a stable order, with
	// the state of the tier each one points at. No filtering: a mapping that
	// cannot currently grant anything is the one an operator most needs to see.
	ListAppleProducts(ctx context.Context) ([]AppleProductRow, error)
	// UpsertAppleProduct records (or retires, with Active=false) one mapping.
	UpsertAppleProduct(ctx context.Context, p AppleProduct) error

	// ---- App Store Server Notifications V2 ledger (see sqlite_apple_notification.go) ----

	// ClaimAppleNotification records a delivery of one notificationUUID and
	// reports whether this caller created the row. It never overwrites an
	// existing row, and the row it writes is a CLAIM rather than a completion:
	// only a terminal state ends the work, so a crash between claiming and
	// applying is redone by the next delivery instead of being short-circuited.
	// These operations are exactly what the notification handler, deferred
	// replay and bounded-retention sweep call. The ledger's two READ-ONLY methods
	// — GetAppleNotification and
	// CountAppleNotificationsByState — are deliberately left off this interface
	// and live on SQLiteStore alone: nothing in the request path reads them, and
	// widening a ~90-method interface for a diagnostic read would oblige every
	// future implementation to provide one.
	ClaimAppleNotification(ctx context.Context, rec AppleNotificationRecord) (AppleNotificationRecord, bool, error)
	// SetAppleNotificationState moves a ledger row to its outcome. It refuses to
	// move a row back out of a terminal state.
	SetAppleNotificationState(ctx context.Context, uuid, state string, now int64) error
	// PendingAppleNotificationsFor returns the deferred notifications for one
	// external subscription, oldest generation first, for the drain that runs
	// once attribution becomes resolvable.
	PendingAppleNotificationsFor(ctx context.Context, originalTransactionID string) ([]AppleNotificationRecord, error)
	// PruneTerminalAppleNotifications bounds completed notification history.
	// Received, pending and conflict rows are unfinished and must never be
	// discarded merely because they are old.
	PruneTerminalAppleNotifications(ctx context.Context, before int64) error
	// SetScheduledPlan records (or clears, with planID="" and cycle="") the tier
	// AND cycle a pending period-end downgrade will switch to — a display hint for
	// the pricing UI and the key the webhook uses to detect when the change lands.
	SetScheduledPlan(ctx context.Context, userID, planID, cycle string) error
	// PlanByStripePrice resolves a webhook's Stripe Price id (monthly or yearly)
	// to the plan tier mapped to it. An empty priceID returns not-found.
	PlanByStripePrice(ctx context.Context, priceID string) (Plan, bool, error)
	// SetAccountDeletion schedules a user for deletion: sets deleted_at and
	// purge_after (the GC hard-delete deadline), resetting purge_reminder_sent
	// so a re-request re-arms the reminder.
	SetAccountDeletion(ctx context.Context, userID string, deletedAt, purgeAfter int64) error
	// ClearAccountDeletion cancels a pending deletion, zeroing all three
	// lifecycle columns (deleted_at, purge_after, purge_reminder_sent) and
	// revoking the user's remaining unused "reactivate" tokens, in one
	// transaction — so no leftover token stays a passwordless login post-recovery.
	ClearAccountDeletion(ctx context.Context, userID string) error
	// MarkPurgeReminderSent records when the pre-purge reminder email was sent,
	// so GC sends it at most once per deletion request.
	MarkPurgeReminderSent(ctx context.Context, userID string, at int64) error
	// PurgeTransientUserData wipes a user's transient/live data immediately at
	// deletion-confirmation time (sessions, cli_tokens, cli_device_auth,
	// devices, magic_tokens, stored_files, upload_sessions, pair_rooms,
	// node_tokens, and their own owner_type='user' nodes), keeping the account
	// shell (users row + identities + usage_events/usage_monthly/user_stats)
	// intact until the 30-day hard-purge. Runs in one transaction.
	//
	// It returns every blob those rows pointed at — finalized ciphertext AND the
	// partial blob of every upload session, in whatever state — so the caller can
	// delete or enqueue each one. Deduplicated by (node, key): a finalize that
	// crashed between persisting the stored_file and dropping its session leaves
	// two rows naming ONE blob, and the reclaim path must not be handed it twice.
	//
	// Upload sessions go with everything else, INCLUDING the recovery state
	// (unresolved_at>0) whose row is otherwise protected as the only surviving
	// evidence of bytes an unreachable node may have accepted. That protection
	// exists to stop an automatic sweep from writing off a bill; it is not a
	// claim on the data of an account that has asked to be deleted. Deleting the
	// account is the user's explicit instruction, the residual bytes could never
	// be charged to it afterwards anyway, and keeping a user_id and a partial
	// ciphertext behind for a node that may never return would make the
	// immediate-deletion promise (and the later hard purge) false indefinitely.
	PurgeTransientUserData(ctx context.Context, userID string) (blobs []BlobRef, err error)
	// ListUsersToPurge returns every user whose grace period has fully
	// elapsed (purge_after>0 AND purge_after<=now): GC's hard-purge worklist.
	ListUsersToPurge(ctx context.Context, now int64) ([]User, error)
	// ListUsersToRemind returns every pending-deletion user who hasn't yet
	// received the one-time pre-purge reminder and whose purge_after falls
	// within the reminder window (now..now+remindWindow).
	ListUsersToRemind(ctx context.Context, now, remindWindow int64) ([]User, error)
	// ArchiveAndPurgeUser is the GC hard-purge: in one transaction it folds
	// userID's usage_monthly rows into the anonymized usage_archive (summed by
	// period, no user identity retained), then deletes every user-linked row
	// (identities, sessions, magic_tokens, devices, cli_tokens,
	// cli_device_auth, usage_events, stored_files, upload_sessions, pair_rooms,
	// upload_events, user_stats, usage_monthly, email_tokens, node_tokens,
	// the user's own nodes) before
	// finally deleting the users row itself. FK-safe delete order (children
	// before the users parent, PRAGMA foreign_keys=ON). The final users delete
	// is guarded on purge_after>0 AND purge_after<=now; if a concurrent
	// reactivation cleared the schedule, the guard matches nothing and the whole
	// purge rolls back, so a revived account is never destroyed.
	ArchiveAndPurgeUser(ctx context.Context, userID string, now int64) error
	// sessions
	CreateSession(ctx context.Context, s Session) error
	GetSession(ctx context.Context, id string) (Session, bool, error)
	RevokeSession(ctx context.Context, id string) error
	RevokeUserSessions(ctx context.Context, userID, exceptID string) error
	DeleteExpiredSessions(ctx context.Context, now int64) error
	// magic tokens
	CreateMagicToken(ctx context.Context, t MagicToken) error
	UseMagicToken(ctx context.Context, tokenHash string, now int64) (MagicToken, bool, error)
	DeleteSpentMagicTokens(ctx context.Context, now int64) error
	// email tokens (verify + reset)
	CreateEmailToken(ctx context.Context, t EmailToken) error
	UseEmailToken(ctx context.Context, tokenHash, purpose string, now int64) (EmailToken, bool, error)
	DeleteSpentEmailTokens(ctx context.Context, now int64) error
	// devices
	UpsertDevice(ctx context.Context, d Device) (Device, error)
	RegisterBrowserDevice(ctx context.Context, in BrowserDeviceRegistration) (Device, error)
	ListDevices(ctx context.Context, userID string) ([]Device, error)
	RenameDevice(ctx context.Context, id, userID, name string) error
	DeleteDevice(ctx context.Context, id, userID string) error
	// Device Inbox enrolment (Phase 1A). Every method is scoped by userID as
	// well as deviceID: a device id is guessable, so ownership is re-checked in
	// the query rather than assumed from whatever authenticated the caller.
	//
	// UpsertDeviceInbox creates or updates the enrolment. It deliberately does
	// NOT touch presence — registering is not evidence of being online — and
	// refuses a revoked enrolment (ErrDeviceInboxRevoked).
	UpsertDeviceInbox(ctx context.Context, in DeviceInbox) (DeviceInbox, error)
	GetDeviceInbox(ctx context.Context, deviceID, userID string) (DeviceInbox, bool, error)
	// ListDeviceInboxes returns every enrolment for a user, keyed by device id,
	// so the device list is one query rather than one per row.
	ListDeviceInboxes(ctx context.Context, userID string) (map[string]DeviceInbox, error)
	// DeleteDeviceInbox removes the enrolment AND its whole key history. This is
	// the owner's explicit re-enrolment path out of a revoked state.
	// byDeviceItself says the caller's bearer is bound to this device row; a
	// revoked enrolment then yields ErrRevokedSelfClear. The rule is applied
	// inside the delete transaction so a revoked device cannot race a
	// check-then-delete and clear its own revocation. Unfinished queue tasks for
	// the device are terminated in the same transaction, because clearing the
	// key history makes them permanently unopenable.
	DeleteDeviceInbox(ctx context.Context, deviceID, userID string, byDeviceItself bool, now int64) (bool, error)
	// TouchDeviceInboxPresence records a heartbeat. ok=false when there is no
	// enrolment for this (device, user) or it is revoked — a revoked device must
	// not be able to resurrect its own presence.
	TouchDeviceInboxPresence(ctx context.Context, deviceID, userID string, now, expiresAt int64, receiveDirReady bool) (ok bool, err error)
	// ExpireDeviceInboxPresence is the graceful goodbye: a device shutting down
	// says so instead of leaving senders to wait out the TTL.
	ExpireDeviceInboxPresence(ctx context.Context, deviceID, userID string, now int64) (ok bool, err error)
	// RotateDeviceKey registers a device's first key (previousKeyID == "") or
	// replaces its current one, as a compare-and-swap against previousKeyID.
	// Returns ErrStaleKeyRotation when the named predecessor is not the current
	// key, which is what makes a replayed or reordered rotation fail rather than
	// silently install an old key.
	RotateDeviceKey(ctx context.Context, k DeviceKey, previousKeyID string) (DeviceKey, error)
	// ActiveDeviceKey returns the key new tasks must be sealed to, if any.
	ActiveDeviceKey(ctx context.Context, deviceID, userID string) (DeviceKey, bool, error)
	// ActiveDeviceKeys returns the active key per device for a user, keyed by
	// device id (companion to ListDeviceInboxes for the device list).
	ActiveDeviceKeys(ctx context.Context, userID string) (map[string]DeviceKey, error)
	// ListDeviceKeys returns the full history, newest generation first.
	ListDeviceKeys(ctx context.Context, deviceID, userID string) ([]DeviceKey, error)
	// RevokeDeviceKey marks one key permanently unusable. Revoking the ACTIVE
	// key also revokes the enrolment and expires presence in the same
	// transaction, so there is no window where a keyless device still looks
	// like a valid send target.
	RevokeDeviceKey(ctx context.Context, deviceID, userID, keyID string, now int64) (revokedActive, ok bool, err error)
	// Device Inbox task queue (Phase 1B). Same scoping rule as above: every
	// method takes userID and re-checks ownership in the query.
	//
	// CreateInboxTask inserts one task, idempotently on (UserID,
	// IdempotencyKey). A repeat of an IDENTICAL create returns the existing task
	// with created=false; a repeat with the same key and different content is
	// ErrIdempotencyKeyConflict, because silently returning the first task would
	// tell the sender their second, different file was queued.
	CreateInboxTask(ctx context.Context, t InboxTask) (saved InboxTask, created bool, err error)
	GetInboxTask(ctx context.Context, taskID, userID string, now int64) (InboxTask, bool, error)
	// ListInboxTasks returns a device's tasks newest first, account-scoped.
	ListInboxTasks(ctx context.Context, deviceID, userID string, now int64, limit int) ([]InboxTask, error)
	// DeleteInboxTask removes one task the account owns. A REFERENCED share is
	// never touched — the task borrows that object, it does not own it — but a
	// task-purpose Stored Object (Phase 1D-A) is deleted with the task, and
	// returned so the caller can drop its blob. A zero StoredFile means nothing
	// was released.
	DeleteInboxTask(ctx context.Context, taskID, userID string) (deleted bool, released StoredFile, err error)
	// CountPendingInboxTasks counts a device's unfinished rows, for the
	// per-device row bound.
	CountPendingInboxTasks(ctx context.Context, deviceID, userID string) (int64, error)
	// NotifyInboxTasks marks a device's queued tasks as notified and returns the
	// pending set. Device-self: it is the device saying "I am asking", which is
	// exactly what makes `notified` true.
	NotifyInboxTasks(ctx context.Context, deviceID, userID string, now int64, limit int) ([]InboxTask, error)
	// ClaimInboxTasks leases up to max claimable tasks for the target device,
	// returning each with a freshly minted RAW claim token (returned once; only
	// its hash is stored). Exactly one concurrent caller can win any given task.
	// It first reclaims leases that have expired, so a crashed claimant's work
	// becomes claimable without waiting for a sweep.
	ClaimInboxTasks(ctx context.Context, deviceID, userID string, now int64, max int) (tasks []InboxTask, rawTokens []string, err error)
	// AuthorizeInboxTaskBlob validates a device's current task claim before the
	// encrypted object is streamed. It rejects expired leases and terminal or
	// non-working tasks, and terminalizes a task whose object disappeared.
	AuthorizeInboxTaskBlob(ctx context.Context, taskID, deviceID, userID, rawClaimToken string, now int64) (InboxTask, error)
	// ReportInboxTask applies a device-asserted transition under the claim
	// token. `to` == current state is an idempotent lease renewal.
	// savedAssertion must be true for `to == saved`, which is legal only from
	// `verifying`.
	ReportInboxTask(ctx context.Context, req InboxTaskReport) (InboxTask, error)
	// AcceptInboxTask resolves an attention_required task: accept=true queues
	// it, accept=false terminates it as declined. Device-self, no lease — an
	// attention_required task is deliberately not leased by anyone.
	AcceptInboxTask(ctx context.Context, taskID, deviceID, userID string, accept bool, now int64) (InboxTask, error)
	// SweepInboxTasks is GC's pass: reclaim expired leases, expire tasks past
	// their TTL, and delete terminal rows past retention. Returns counts for the
	// log.
	SweepInboxTasks(ctx context.Context, now, terminalRetention int64) (reclaimed, expired, pruned int64, err error)
	// usage (cross-network relay metering)
	RecordUsage(ctx context.Context, e UsageEvent) error
	UserUsageTotal(ctx context.Context, userID string) (int64, error)
	UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error)
	// NodeRelayedSince sums relayed bytes per node for usage since `since`
	// (per-node monthly traffic cap), keyed by node id.
	NodeRelayedSince(ctx context.Context, since int64) (map[string]int64, error)
	// admin (read-only)
	AdminListUsers(ctx context.Context, q AdminUserQuery) (rows []AdminUserRow, total int64, err error)
	AdminMetrics(ctx context.Context, period string, now int64) (AdminMetrics, error)
	// AdminUserEmailsByIDs batch-resolves user ids to emails for the admin BYO
	// nodes table, which shows Node.OwnerUserID: a raw generated id needs a
	// separate lookup to answer "whose machine is this", the exact question an
	// operator about to drain it needs answered first. One IN(...) query for
	// however many distinct owners are in the (already row-capped) BYO table —
	// never one query per row, since that population is unbounded. An id with
	// no matching row (deleted user) is simply absent from the returned map.
	AdminUserEmailsByIDs(ctx context.Context, ids []string) (map[string]string, error)
	// stored files (zero-knowledge stored transfer)
	// CreateStoredFile inserts a stored file with no cap enforcement. An object
	// bound to a pairing room goes through the same transaction the capped path
	// uses, so its deadline and its room's open precondition cannot differ by
	// which entry point it came in at.
	CreateStoredFile(ctx context.Context, f StoredFile) error
	// CreateStoredFileWithinStorageCaps atomically enforces the owner (userCap)
	// and global (globalCap) live-storage caps and inserts the row in one writer
	// transaction, so concurrent uploads cannot collectively bust a cap. A
	// non-positive cap disables that check. A StoredFileWrite with a non-empty
	// Reason ("storage"|"global") names the cap hit and nothing was inserted; a
	// real error is returned as err (caller fails closed).
	//
	// For a pair-room object the same transaction also carries the room's open
	// precondition (ErrPairRoomClosed if it ended first) and is where the object's
	// expires_at is DECIDED — see StoredFileWrite.
	CreateStoredFileWithinStorageCaps(ctx context.Context, f StoredFile, now, userCap, globalCap int64) (StoredFileWrite, error)
	GetStoredFile(ctx context.Context, id string) (StoredFile, error)
	// GetStoredFileByBlobKey resolves a blob key back to its stored-file row (a
	// direct-download receipt only carries the blob key). ErrNotFound if absent.
	GetStoredFileByBlobKey(ctx context.Context, blobKey string) (StoredFile, error)
	// ClaimDownloadReceipt records a direct-download receipt nonce, returning true
	// only the first time so reconciliation refunds exactly once (idempotent).
	ClaimDownloadReceipt(ctx context.Context, nonce string, at int64) (bool, error)
	ListStoredFilesByUser(ctx context.Context, userID string) ([]StoredFile, error)
	MarkDownloaded(ctx context.Context, id string, at int64) error
	// ClaimBurnDownload atomically consumes a burn-after-read file's single
	// download: it sets downloaded_at only if the file is burn and still unclaimed,
	// returning claimed=true exactly once across concurrent callers.
	ClaimBurnDownload(ctx context.Context, id string, at int64) (claimed bool, err error)
	// ReleaseBurnDownload reverses a ClaimBurnDownload when the download failed
	// mid-stream, restoring downloaded_at=0 only if it still matches the claim's
	// timestamp (so a concurrent re-claim is never clobbered).
	ReleaseBurnDownload(ctx context.Context, id string, claimedAt int64) error
	// DeleteStoredFile atomically makes unfinished Inbox tasks truthful before
	// deleting their backing object. Tasks at the object's TTL become expired;
	// earlier deletion becomes failed_terminal/stored_object_unavailable.
	DeleteStoredFile(ctx context.Context, id string, now int64) error
	ListExpiredStoredFiles(ctx context.Context, now int64) ([]StoredFile, error)
	// ListReclaimableTaskObjects returns task-purpose Stored Objects (Phase
	// 1D-A) that no delivery can legitimately read any more: unbound past the
	// bind grace, bound to a task that no longer exists, or bound to a task that
	// is terminal. bindGrace is in seconds.
	ListReclaimableTaskObjects(ctx context.Context, now, bindGrace int64) ([]StoredFile, error)
	// DeleteTaskObjectIfReclaimable re-evaluates that same condition under the
	// writer lock and deletes the row, so a binding that landed between the list
	// and the delete keeps its ciphertext. ok=false means the object became live
	// again and the caller must NOT delete its blob.
	DeleteTaskObjectIfReclaimable(ctx context.Context, id string, now, bindGrace int64) (bool, error)
	// pair rooms (code-first pre-upload; see pairroom.go for the lifecycle these
	// methods implement — every deadline RULE lives there, never in SQL)
	//
	// CreatePairRoomIfAbsent opens r's room unless these digits already have an
	// open, unjoined one, in which case that room comes back with created=false.
	// Get-or-create in one transaction: two files starting their pre-upload at the
	// same instant must not open two rooms, because a join only ever resolves one
	// of them and a file in the other is stranded.
	CreatePairRoomIfAbsent(ctx context.Context, r PairRoom) (room PairRoom, created bool, err error)
	GetPairRoom(ctx context.Context, id string) (PairRoom, bool, error)
	// LivePairRoomByCode resolves the NEWEST room opened for `code` that has not
	// been closed. Newest, because codes are recycled: an older row with the same
	// digits belongs to a different transfer and must never be reachable.
	// Liveness against the clock is the caller's (pairRoomLive), so a caller that
	// finds an over-deadline room can void it rather than silently miss it.
	LivePairRoomByCode(ctx context.Context, code string) (PairRoom, bool, error)
	// TouchPairRoomUpload records upload progress: last_upload_at and the room's
	// deadline move forward (never back), and the same deadline is projected onto
	// every object already in the room, in one transaction.
	//
	// It answers with what the ROW then holds (PairRoomTouch), because the only
	// other source for that number is a projection off the caller's snapshot —
	// which is how a code came to be extended for a room somebody had already
	// joined.
	TouchPairRoomUpload(ctx context.Context, id string, at, expiresAt int64) (PairRoomTouch, error)
	// JoinPairRoom stamps the join and projects the post-join deadline, only
	// while the room is open and unjoined (so a second join changes nothing).
	JoinPairRoom(ctx context.Context, id string, at, expiresAt int64) error
	// ClosePairRoom ends the room and, in the SAME transaction, performs every
	// part of the void that a database alone can perform:
	//
	//   - marks the room closed, exactly once (a second call returns an empty
	//     closure, so two racing voids cannot double-reclaim);
	//   - settles the meter of every upload session bound to it — the bytes the
	//     account is KNOWN to have sent stay billed, whatever happens next;
	//   - DELETES those session rows, so the account's open-session slots and the
	//     room's bindings are free immediately;
	//   - DELETES every stored-file row through the shared removal helper, so the
	//     account's storage quota is released in this same commit;
	//   - queues a durable delete intent (pending_node_deletes) for every blob
	//     the room held, finalized and half-uploaded alike, held until holdUntil
	//     (see PendingNodeDelete.NotBefore).
	//
	// Nothing here touches a node. That is the point: the authoritative state
	// transition completes on the database's own clock, and the caller's slow,
	// failable, budgeted physical work — probing a blob for its real size,
	// deleting it — can only ever make the outcome MORE accurate, never more
	// correct. A caller that runs out of budget, or dies, leaves no room-bound row
	// behind and no blob without an owner.
	//
	// The closure is that remaining work list (see PairRoomClosure); the rows it
	// describes are already gone.
	ClosePairRoom(ctx context.Context, id string, at, holdUntil int64) (PairRoomClosure, error)
	// CloseOwnedPairRoom atomically binds an account-requested close to its owner,
	// joined state and absence of active uploads.
	CloseOwnedPairRoom(ctx context.Context, userID, id string, at, holdUntil int64) (PairRoomClosure, PairRoomOwnerReleaseOutcome, error)
	// CompletePairRoomObject removes ONE pair-room object on a receiver's word,
	// in one transaction: it checks `verifier` against the object's own stored
	// one in constant time, queues the blob's durable delete intent (held until
	// holdUntil) BEFORE deleting the row that is the only other thing pointing at
	// it, and — when that was the last thing the room held and somebody has
	// joined — closes the room too.
	//
	// The verdict is reached under the writer lock rather than by the caller, so
	// two receivers racing cannot both act on it: exactly one gets Done and the
	// other is told it is already gone. Nothing here touches a node; the physical
	// delete is the caller's, best-effort, against the intent this wrote.
	CompletePairRoomObject(ctx context.Context, id string, verifier []byte, at, holdUntil int64) (PairRoomCompletion, error)
	// CloseEmptyJoinedPairRooms closes joined, open rooms created at or before
	// `before` that hold neither an object nor an upload session, at most limit
	// of them. GC's hygiene pass for the one room shape no deadline and no
	// completion can reach (see the SQLite implementation).
	//
	// It returns THE ROOMS IT CLOSED — each one the row as this call found it,
	// with closed_at stamped — and only those: a room another path closed first is
	// not in the result. The caller needs the identity, not a tally, because
	// closing a room is only half of a void and the other half (revoking the
	// room's pairing code) is bounded by the room's own owner and join deadline.
	CloseEmptyJoinedPairRooms(ctx context.Context, before, at int64, limit int) ([]PairRoom, error)
	// ListDeadPairRooms returns open rooms whose deadline has passed (GC's
	// backstop pass), newest-deadline-last, at most limit rows.
	ListDeadPairRooms(ctx context.Context, now int64, limit int) ([]PairRoom, error)
	PurgeClosedPairRooms(ctx context.Context, before int64) error
	// ListPairRoomHoldings reports the pair-room ciphertext `userID` is holding:
	// at most `limit` rooms in a deterministic order, plus totals over all of
	// them. Scoped to the one account by the query itself, so there is no shape
	// of this call that can see another user's room.
	//
	// It lists JOINED, OPEN rooms that hold at least one finalized object, and
	// deliberately nothing else — see the SQLite implementation for why each of
	// the three conditions is load-bearing rather than a filter of convenience.
	ListPairRoomHoldings(ctx context.Context, userID string, limit int) (PairRoomHoldings, error)
	IncDownloadCount(ctx context.Context, id string) error
	// ClaimDownloadSlot atomically takes one of a file's remaining download
	// slots: increments download_count only while download_count < max_downloads
	// (max_downloads = 0 means unlimited). Returns claimed=true exactly for the
	// callers that fit under the cap across concurrent requests, and slot = the
	// post-increment download_count (1-based) THIS call took — the caller's own
	// slot number, not a value a concurrent claim can later inflate out from
	// under it. slot==0 when claimed==false.
	ClaimDownloadSlot(ctx context.Context, id string, at int64) (slot int64, claimed bool, err error)
	// ReleaseDownloadSlot undoes a ClaimDownloadSlot after a failed delivery
	// (download_count-1, floored at 0). Slots are fungible — any failed claim
	// returns one — so this takes no claim timestamp: a downloaded_at guard would
	// wrongly leak slots when several downloads of a multi-download file race.
	ReleaseDownloadSlot(ctx context.Context, id string) error
	// user_stats (lifetime aggregate counters; privacy-minimal, no per-event rows)
	AddUploadStat(ctx context.Context, userID string, bytes int64) error
	AddDownloadStat(ctx context.Context, userID string, bytes int64) error
	GetUserStats(ctx context.Context, userID string) (UserStats, error)
	// usage_monthly (per-month billing ledger: upload/download bytes; relay is
	// derived from usage_events, not stored here)
	RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error
	// EnqueueUnbilledMeter durably records bytes that are owed after a
	// RecordMeter failed, on the paths whose evidence does not survive the
	// failure. See UnbilledMeter.
	EnqueueUnbilledMeter(ctx context.Context, m UnbilledMeter) error
	// SettleUnbilledMeter charges up to `limit` owed rows, each in one
	// transaction with the removal of the row that owed it, and reports how
	// many it settled. GC's retry.
	SettleUnbilledMeter(ctx context.Context, limit int) (int, error)
	// CountUnbilledMeter reports how many bills are still owed.
	CountUnbilledMeter(ctx context.Context) (int, error)
	MonthlyUsage(ctx context.Context, userID, period string) (upload, download int64, err error)
	// upload events (rolling-24h quota ledger)
	RecordUpload(ctx context.Context, e UploadEvent) error
	UserUploadedSince(ctx context.Context, userID string, since int64) (int64, error)
	// ReserveUpload atomically records an upload event only if the user's rolling
	// usage since `since` plus e.Bytes stays within quota, in one transaction, so
	// concurrent uploads cannot collectively exceed the quota. ok=false means the
	// reservation was refused (over quota) and nothing was written.
	ReserveUpload(ctx context.Context, e UploadEvent, since, quota int64) (ok bool, err error)
	// RefundUpload removes a reserved upload event (by id) when a later gate fails,
	// so the daily quota isn't charged for a file that never landed.
	RefundUpload(ctx context.Context, id string) error
	PruneUploadEvents(ctx context.Context, before int64) error
	// PruneDownloadReceipts deletes direct-download dedup rows older than `before`
	// (a generous margin past any in-flight download) to keep the table bounded.
	PruneDownloadReceipts(ctx context.Context, before int64) error
	// settings (admin-editable limits)
	GetSetting(ctx context.Context, key string) (int64, bool, error)
	SetSetting(ctx context.Context, key string, value, at int64) error
	ListSettings(ctx context.Context) ([]Setting, error)
	// release check (admin "a newer release exists" notice)
	GetReleaseCheck(ctx context.Context) (ReleaseCheck, error)
	// SetReleaseCheckResult records a SUCCESSFUL check. A failed check must not
	// call this: leaving the previous values in place is what makes the panel
	// degrade to silence rather than to a false claim.
	SetReleaseCheckResult(ctx context.Context, tag string, at int64) error
	// SetReleaseCheckDismissed records (or, with an empty tag, clears) the
	// dismissal without touching the result.
	SetReleaseCheckDismissed(ctx context.Context, tag string, at int64) error
	// relay nodes (self-reporting fleet telemetry)
	UpsertNode(ctx context.Context, n Node) (Node, error)
	// TouchNode records a heartbeat. activeTransfers is the node's live
	// in-flight allocation count (see Node.ActiveTransfers) and, like the three
	// storage gauges, is SET rather than kept-max.
	TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, storageTotal, storageFree, at int64, activeTransfers int) error
	GetNode(ctx context.Context, id string) (Node, bool, error)
	StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error)
	OnlineNodes(ctx context.Context, since int64) ([]Node, error)
	ListNodes(ctx context.Context) ([]Node, error)
	// ListByoNodes returns ONE PAGE of user-contributed (owner_type='user')
	// nodes matching q, plus the total number of matches. Filtering, ranking
	// and paging all happen in SQL rather than in Go, so an operator can reach
	// any node in an unbounded population instead of only the top of a list.
	// For the unsearched live page the ranking is index-supplied and the rows
	// past the page really are not read; see SQLiteStore.ListByoNodes for the
	// exact query plan, including the cases (search, the removed section) where
	// more than the page is touched.
	ListByoNodes(ctx context.Context, q AdminByoNodeQuery) ([]Node, int64, error)
	// UserNodes returns a user's own (owner_type='user') nodes seen since `since`.
	UserNodes(ctx context.Context, userID string, since int64) ([]Node, error)
	// UserNodesAll returns all of a user's own nodes regardless of last_seen,
	// for the dashboard list (which shows offline nodes too).
	UserNodesAll(ctx context.Context, userID string) ([]Node, error)
	// UserStorageNodes is UserNodes filtered to storage-enabled nodes with at
	// least minFree bytes free.
	UserStorageNodes(ctx context.Context, userID string, since, minFree int64) ([]Node, error)
	// DeleteNode removes a user-owned node, scoped to its owner: only a node
	// with owner_user_id == ownerUserID is deleted, so a non-owner's call and a
	// missing id are indistinguishable (both ErrNotFound). Also clears the
	// node's pending_node_deletes entries.
	DeleteNode(ctx context.Context, id, ownerUserID string) error
	// SetNodeLimits sets a node's admin hard caps (bytes; 0 = unlimited).
	SetNodeLimits(ctx context.Context, nodeID string, trafficLimit, diskLimit int64) error
	// SetUserNodeLabel renames a user-owned node, scoped to its owner so a user
	// can only rename their own nodes.
	SetUserNodeLabel(ctx context.Context, id, ownerUserID, label string) error
	// SetNodeLabel renames any node (admin, unscoped) — used for fleet nodes.
	SetNodeLabel(ctx context.Context, id, label string) error
	// SetNodeDraining sets/clears a node's drain flag (admin, unscoped): a
	// draining node is excluded from new-upload placement but keeps serving its
	// existing files. See Node.Draining.
	SetNodeDraining(ctx context.Context, id string, on bool) error
	// SetNodeStorageReachable records the outcome of a central→node blob-endpoint
	// probe. `at` is the probe time (unix seconds).
	SetNodeStorageReachable(ctx context.Context, id string, reachable bool, at int64) error
	// MarkNodeRemoved records that a node has been uninstalled: the row stays for
	// audit, but the node leaves the placement pool, the ICE candidate list and
	// the direct-download path. Idempotent — re-marking an already-removed node
	// keeps the FIRST timestamp, so a retried deregistration cannot rewrite
	// history. Returns ErrNotFound for an unknown id. See Node.RemovedAt.
	MarkNodeRemoved(ctx context.Context, id string, at int64) error
	// ClearNodeRemoved undoes MarkNodeRemoved (removed_at back to 0), putting
	// the node back into placement, ICE and the direct-download path. It exists
	// so deregistration is a door that opens both ways: the node token does not
	// bind to a node id, so one mistaken (or malicious) POST can empty the whole
	// pool, and the only other way back used to be deleting the row — which
	// destroys its history and its file bookkeeping with it. Admin-only.
	// Idempotent: clearing an already-live node is a no-op success. Returns
	// ErrNotFound for an unknown id.
	ClearNodeRemoved(ctx context.Context, id string) error
	// CountFilesOnNode reports how many LIVE stored files (expires_at > now)
	// still sit on nodeID, plus the largest ExpiresAt among them — the earliest
	// moment the node is safe to uninstall, since a file binds to exactly one
	// node and there are no replicas. An expired-but-not-yet-GC'd row does not
	// count and cannot push the safe-from time out further; a deleted file is
	// never in the table at all (stored_files rows are hard-deleted, not
	// soft-deleted), so it is excluded automatically. A node holding nothing
	// live reports (0, 0, nil).
	CountFilesOnNode(ctx context.Context, nodeID string, now int64) (count int, maxExpiresAt int64, err error)
	// NodeFileCounts is CountFilesOnNode for every node at once, in a single
	// grouped query — the admin nodes listing renders every row from one read
	// instead of one query per node. Nodes with no live files are simply absent
	// from the map (read as the zero NodeFileCount).
	NodeFileCounts(ctx context.Context, now int64) (map[string]NodeFileCount, error)
	// CentralStoredBytes sums the live sizes of files held on central-local
	// storage (node_id unset) — the app server's own disk fallback.
	CentralStoredBytes(ctx context.Context) (int64, error)
	// DeleteFleetNode removes an official (fleet) node, scoped to owner_type='fleet'.
	DeleteFleetNode(ctx context.Context, id string) error
	// node_rollout (Part 2: automatic node update rollout state machine).
	// GetRolloutTrack returns ok=false if the track has no persisted state yet
	// (a fresh DB, or a track that has never had a rollout started).
	GetRolloutTrack(ctx context.Context, track string) (RolloutTrack, bool, error)
	// PutRolloutTrack upserts a track's full state in one row. The fleet and
	// byo rows are independent — see RolloutTrack's doc comment.
	PutRolloutTrack(ctx context.Context, t RolloutTrack) error
	// ClaimRolloutNode is the compare-and-swap that hands the fleet slot to one
	// node: it only writes if the row still holds the current_node_id AND the
	// target_version the caller read, and is still 'rolling'. ok=false means the
	// track moved first (another instance's claim or halt, or an admin retarget)
	// and the caller must NOT tell its node to update — it would be installing
	// the version the decision was computed from, not the one now targeted.
	ClaimRolloutNode(ctx context.Context, track, expectTargetVersion, expectCurrentNodeID, nodeID, firstNodeID string, at int64) (bool, error)
	// HaltRolloutTrack stops a track, conditional on it still being 'rolling',
	// so a halt can never be clobbered by (nor clobber) a concurrent writer.
	HaltRolloutTrack(ctx context.Context, track, reason string, at int64) (bool, error)
	// CompleteRolloutTrack marks a track finished, conditional on it still
	// being 'rolling' — same rationale as HaltRolloutTrack: a whole-row write
	// here could erase a concurrent halt and its reason.
	CompleteRolloutTrack(ctx context.Context, track string, at int64) (bool, error)
	// AdvanceByoBatch opens the next byo batch, conditional on the row still
	// being 'rolling', still at the batch percentage (fromBatch) AND still on
	// the target_version this decision was computed from — otherwise a stale
	// write can resurrect a halted track, jump the ladder forward, or land
	// against a rollout to a different version whose canary window it has just
	// skipped. See its doc comment in rollout_store.go.
	AdvanceByoBatch(ctx context.Context, track, expectTargetVersion string, fromBatch, toBatch int, at int64) (bool, error)
	// ResumeRolloutTrack restarts a HALTED track on the version it already
	// targets, resetting the staging fields (batch, in-flight/canary node,
	// emergency) that would otherwise make it re-halt immediately, and clearing
	// this track's passed-over node results in the same transaction so 继续
	// really does restart the ladder from the beginning. It reads no other
	// track — resuming one track must never be able to fail because of the
	// other. ok=false means the track was not halted (already rolling, or
	// complete) and NOTHING was written, node rows included.
	ResumeRolloutTrack(ctx context.Context, track string, at int64) (bool, error)
	// StartManualFastRollout points a track at version, arms manual-fast mode
	// (RolloutTrack.ManualFast) and starts it rolling — but ONLY if the row is
	// still exactly what the operator was shown: either no row at all
	// (expectStatus "") or a FINISHED one on expectTargetVersion (expectStatus
	// "complete"). Any other expectStatus is refused without touching the
	// database, so this can never replace a rollout in flight or resurrect a
	// paused one. It clears this track's passed-over node results in the same
	// transaction, exactly as ResumeRolloutTrack does, because it is another way
	// a ladder starts. ok=false means the row moved (or appeared) since the
	// confirmation page was rendered and NOTHING was written, node rows included.
	StartManualFastRollout(ctx context.Context, track, expectStatus, expectTargetVersion, version string, at int64) (bool, error)
	// StartCanaryFastRollout is the same operation for the SAFE fast mode
	// (RolloutTrack.FastAfterCanary): the canary keeps its full six-hour
	// observation window and only the nodes after it skip the inter-node soak.
	// Same two startable states, same compare-and-swap, same passed-over clear in
	// the same transaction, same "ok=false means nothing was written" contract —
	// it differs from StartManualFastRollout only in which mode column it arms,
	// and both write all three mode columns so a row can never carry two modes.
	StartCanaryFastRollout(ctx context.Context, track, expectStatus, expectTargetVersion, version string, at int64) (bool, error)
	// RetryRolloutNode gives one passed-over node its candidacy back on a
	// COMPLETE track and sets that track rolling again, so the queue re-offers
	// the same target version to it. It touches neither target_version nor
	// first_node_id.
	//
	// Both conditions are compare-and-swaps in the SQL, in one transaction, and
	// BOTH must match or nothing is written: the track must still be 'complete',
	// and the node must still be passed over, belong to this track's owner class
	// and not be removed. ok=false means one of them did not match — a halt that
	// lands between the caller's read and this write is never clobbered, and a
	// track is never left rolling with no node re-admitted (which would hand the
	// build back to a node that reported a failure). A refused retry writes
	// nothing at all.
	RetryRolloutNode(ctx context.Context, track, nodeID string, at int64) (bool, error)
	// SetRolloutEmergency arms emergency mode (release the whole track at
	// once, skipping the staged ladder) on a track that is rolling to
	// expectVersion — a compare-and-swap against exactly what the admin
	// confirmed. ok=false means the track moved in between and nothing was
	// released.
	//
	// Arming it DISARMS both fast modes in the same write, because the three are
	// mutually exclusive and emergency is the opposite trade: it gives up the
	// gated one-at-a-time queue that either fast mode is defined by keeping.
	SetRolloutEmergency(ctx context.Context, track, expectVersion string, at int64) (bool, error)
	// NodesByOwnerType returns every node of one ownership class ("fleet" |
	// "user") INCLUDING offline ones. The rollout state machines require the
	// offline rows (see the method's doc comment) — do not substitute
	// OnlineNodes here.
	NodesByOwnerType(ctx context.Context, ownerType string) ([]Node, error)
	// CommandNodeUpdate stamps update_started_at/update_from_version and clears
	// update_result when central commands a node to self-update.
	CommandNodeUpdate(ctx context.Context, nodeID, fromVersion string, at int64) error
	// SetNodeUpdateResult records the outcome a node reported for the update it
	// was last commanded.
	SetNodeUpdateResult(ctx context.Context, nodeID, result string) error
	// ClearPassedOverResults erases the "skipped"/"unreachable" update results
	// of one ownership class, so a node passed over by the rollout that is
	// ending is a candidate again for the one being started. setTargetVersion
	// calls it; ResumeRolloutTrack performs the same erase inside its own
	// transaction. Together they are what scopes decideFleet's passed-over
	// exclusion to the current rollout — see passedOverResult.
	ClearPassedOverResults(ctx context.Context, ownerType string) error
	// BumpNodeUpdateAttempts increments nodes.update_attempts. No longer called
	// by the rollout path (see Node.UpdateAttempts) — kept on the interface and
	// the schema rather than removed, in case a future caller needs it.
	BumpNodeUpdateAttempts(ctx context.Context, nodeID string) error
	// pending_node_deletes (orphan-retry queue for GC when a node's DELETE fails)
	EnqueueNodeDelete(ctx context.Context, blobKey, nodeID string, at int64) error
	ListPendingNodeDeletes(ctx context.Context) ([]PendingNodeDelete, error)
	DeletePendingNodeDelete(ctx context.Context, blobKey, nodeID string) error
	// MarkPendingNodeDeleteDone stamps the first delete that succeeded for a
	// row still inside its hold, so age eviction can tell a discharged
	// responsibility from an undischarged one.
	MarkPendingNodeDeleteDone(ctx context.Context, blobKey, nodeID string, at int64) error
	// RetirePendingNodeDeletes drops the rows that own nothing any more — a
	// discharged (deleted_at > 0) row past its age window, and nothing else —
	// and reports how many old undischarged rows it deliberately KEPT. Age,
	// an absent node row and removed_at are all non-reasons: only the explicit
	// irreversible node deletion ends an undischarged row, by removing its own
	// rows itself. See the implementation for why.
	RetirePendingNodeDeletes(ctx context.Context, before int64) (retired, retained int, err error)
	// SettleBlobBilling atomically charges the unbilled residual a pending blob
	// carries (its size `through`, clamped to the row's bill_max, minus the
	// row's billed_through floor) to the row's bill_user_id, advancing the
	// floor in the same transaction. Idempotent: a repeat with the same
	// `through` bills nothing. Returns the bytes billed; (0, nil) when the row
	// is missing, carries no obligation, or owes nothing.
	SettleBlobBilling(ctx context.Context, blobKey, nodeID string, through, at int64) (int64, error)
	// JournalBlobBilling is SettleBlobBilling's fallback for a database whose
	// meter tables are refusing writes: the residual goes to the owed-bills
	// outbox (unbilled_meter) instead of the meter, with the floor advanced in
	// the same transaction so the two records cannot both exist for one byte.
	// GC settles the outbox row later (SettleUnbilledMeter).
	JournalBlobBilling(ctx context.Context, blobKey, nodeID string, through, at int64, reason string) (int64, error)
	// node_tokens (per-user BYO-node bearer credentials; SP3)
	CreateNodeToken(ctx context.Context, t NodeToken) error
	NodeTokenByHash(ctx context.Context, hash string) (NodeToken, bool, error)
	BindNodeToken(ctx context.Context, id, nodeID string) error
	ListNodeTokensByUser(ctx context.Context, userID string) ([]NodeToken, error)
	RevokeNodeToken(ctx context.Context, id, userID string, at int64) error
	TouchNodeTokenUsed(ctx context.Context, id string, at int64) error
	// fleet_tokens (admin-minted, userless official-node bearer credentials)
	CreateFleetToken(ctx context.Context, t FleetToken) error
	FleetTokenByHash(ctx context.Context, hash string) (FleetToken, bool, error)
	BindFleetToken(ctx context.Context, id, nodeID string) error
	TouchFleetTokenUsed(ctx context.Context, id string, at int64) error
	RevokeFleetToken(ctx context.Context, id string, at int64) error
	ListActiveFleetTokens(ctx context.Context) ([]FleetToken, error)
	// cli_device_auth (device-code CLI login flow)
	CreateDeviceAuth(ctx context.Context, r DeviceAuthRequest) error
	GetDeviceAuthByUserCode(ctx context.Context, userCode string) (DeviceAuthRequest, bool, error)
	GetDeviceAuthByCodeHash(ctx context.Context, hash string) (DeviceAuthRequest, bool, error)
	// ApproveAndRegisterDeviceAuth performs the whole human-approved handoff in
	// one transaction: validate and approve the pending code, find or create the
	// account-scoped installation row, rotate its bearer, and make the raw token
	// available to poll. A poll can therefore never observe an approved request
	// whose bearer has not committed yet.
	ApproveAndRegisterDeviceAuth(ctx context.Context, userCode, userID, rawToken, newDeviceID string, at int64) (approved ApprovedDeviceAuth, device Device, ok bool, err error)
	// ConsumeDeviceAuth atomically transitions an approved request to
	// consumed exactly once, returning the raw one-time token stashed by
	// ApproveAndRegisterDeviceAuth and blanking pending_token so it never lingers at
	// rest. ok=false on any second call or if the request isn't approved.
	ConsumeDeviceAuth(ctx context.Context, codeHash string, at int64) (rawToken string, ok bool, err error)
	// DeleteExpiredDeviceAuth reclaims device-auth rows past their expiry.
	DeleteExpiredDeviceAuth(ctx context.Context, now int64) error
	// cli_tokens (long-lived hashed CLI bearer tokens; prefix "rlm_cli_")
	CreateCLIToken(ctx context.Context, t CLIToken) error
	GetCLITokenUser(ctx context.Context, tokenHash string) (userID, deviceID string, ok bool, err error)
	TouchCLIToken(ctx context.Context, tokenHash string, at int64, clientIP string) error
	DeleteCLIToken(ctx context.Context, tokenHash string) error
	// plans (billing phase-1)
	ListPlans(ctx context.Context) ([]Plan, error)
	GetPlan(ctx context.Context, id string) (Plan, bool, error)
	UpsertPlan(ctx context.Context, p Plan) error
	CountActivePlans(ctx context.Context) (int, error)
	// usage read queries (billing phase-1 enforcement inputs)
	UserMonthlyUpDown(ctx context.Context, userID, period string) (int64, error)
	CurrentStorage(ctx context.Context, userID string, now int64) (int64, error)
	GlobalStorageUsed(ctx context.Context, now int64) (int64, error)
	// admin passkeys
	ListAdminCredentials(ctx context.Context) ([]AdminCredential, error)
	// CountAdminCredentials reports how many passkeys are registered without
	// reading any credential material. The unauthenticated login page asks this
	// on every render, so it must not pull cred_json blobs into memory.
	CountAdminCredentials(ctx context.Context) (int, error)
	GetAdminCredential(ctx context.Context, id string) (AdminCredential, bool, error)
	InsertAdminCredential(ctx context.Context, c AdminCredential) error
	// TouchAdminCredential writes back the updated credential record and the
	// last-used timestamp after a successful login.
	TouchAdminCredential(ctx context.Context, id string, credJSON []byte, lastUsedAt int64) error
	DeleteAdminCredential(ctx context.Context, id string) error
	// AdminUserHandle returns the shared WebAuthn user handle, ok=false when no
	// credential is registered yet (the first registration mints one).
	AdminUserHandle(ctx context.Context) ([]byte, bool, error)
	// InsertAudit 追加一条管理员操作记录。审计写入失败绝不能让业务操作回滚：
	// 调用方记录错误后继续（见 WriteAudit）。
	InsertAudit(ctx context.Context, e AuditEntry) error
	// ListAudit 按时间倒序返回审计记录。action 非空时按动作过滤。
	ListAudit(ctx context.Context, limit, offset int, action string) ([]AuditEntry, error)
	// PruneAudit deletes audit rows written strictly before `before`, the
	// age-based half of keeping admin_audit bounded (see auditRetentionDefault
	// for why the window is deliberately long). NOT scoped to machine rows: it
	// deletes ADMIN rows of that age too, which is why the configured window
	// is the one knob here that can destroy the human audit trail.
	PruneAudit(ctx context.Context, before int64) error
	// PruneNodeAudit keeps only the newest `keep` MACHINE-written audit rows
	// (auth = 'node-token'), the burst-based half. Admin/human rows are never
	// touched by it — see auditNodeRowsMax.
	PruneNodeAudit(ctx context.Context, keep int) error
}

// AdminByoNodeQuery is one page of the admin dashboard's BYO node table.
//
// Search matches the three things an operator actually has in hand when
// hunting one node out of an unbounded population: the node id (from a log
// line), the owner's email (from a support ticket), and the label/region the
// owner set on the machine. Empty = no filter.
//
// Removed selects WHICH half of the population is being listed: false = live
// and draining nodes (the main table), true = already-uninstalled ones (the
// separate small section that is the only entry point to /restore). They are
// two queries rather than one flag-less list precisely so a pile of tombstones
// can never crowd the live rows out of the page — and so a search can still
// reach a removed node.
// Search is clamped to adminByoSearchMax before it reaches LIKE; a term past
// SQLite's pattern limit is an error, not an empty result.
type AdminByoNodeQuery struct {
	Search        string
	Removed       bool
	Limit, Offset int
}
