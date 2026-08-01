# Web verification and consent visibility — batch 9

Date: 2026-08-01
Status: implemented, delivered and production validated.
Scope owner: the shared Web realtime transfer surface used by LAN and cross-
network/direct sessions, including file and ephemeral-text verification and
consent placement, conditional reveal behavior, and regression coverage. No
protocol, cryptography, capability, transfer-state, or CLI behavior change.

## Problem

After two devices connect, the device card and its passive availability guidance
remain first in document order. A newly created file request, file transfer, or
text session is appended below them. At a measured 390×844 viewport, the text
sender's verification code began at y=848, the text receiver's spanned y=809–880,
and the file receiver's spanned y=829–858 with its decision controls still lower.
The page therefore changes without placing the next security-critical step in the
user's visible task area. A user who does not scroll can reasonably conclude that
the connection stalled.

The defect is structural rather than protocol-level: `transferSurface` always
renders the peer chooser before every dynamic activity surface, and both the LAN
workspace and `CrossPage` consume that same ordering.

## Design rule

**The currently active secure exchange precedes device selection; a newly required
verification or consent step is revealed once, without moving keyboard focus.**

## Information hierarchy

Keep one render site for every stateful surface. Within the shared transfer
surface, render in this order:

1. queued-room send confirmation, when present;
2. incoming file request and its verification/consent controls;
3. current file send/receive cards;
4. the current text-session panel;
5. the peer chooser, target card, quota and passive availability information.

The activity blocks already render conditionally, so idle document order remains
effectively unchanged: the peer section is still the first visible workflow.
Completed and failed activity stays above peer selection while its existing card
remains present, but it does not force a scroll.

The code-room queued-send confirmation moves out of the peer section because it
is a current decision, not device discovery. Quota, queued-share guidance, radar,
peer cards and the text-availability note remain peer context.

Do not duplicate activity markup into alternate idle/active branches. In
particular, `MessagePanel` must remain one component instance so draft text,
history, transitions and callbacks are not reset by a hierarchy change.

## One-shot reveal behavior

DOM order alone is insufficient: Chrome and Firefox may preserve the focused peer
control through scroll anchoring when new content appears above it, while Safari
may move differently. Give the shared workflow an explicit no-anchor boundary and
use an application-controlled reveal for a new action-bearing exchange.

A reveal is eligible only when a new event requires immediate human attention:

- a code-room queued-send confirmation appears;
- an incoming file request has a verification code and requires accept/decline;
- a file send/receive card first gains a verification code before completion;
- a text session reaches `waitingAccept` or `incomingRequest` with its verification
  code.

Connecting without a code, open/flowing sessions, progress updates, successful
completion, refusal, failure and other terminal states never initiate scrolling.
They retain their activity-first position and existing status announcements.

Each eligible exchange gets at most one reveal. The guard resets after that
exchange leaves the eligible state, allowing a later exchange with the same peer
to reveal normally. After the DOM update, call instantaneous
`scrollIntoView({ block: "nearest" })` on the relevant verification row (or the
compact start marker where the card itself contains the verification status),
with scroll margin for the fixed navigation. Targeting the incoming SAS row is
important when a long file manifest makes the top of the request card visible
while its security decision is still below the fold. Do not use smooth
scrolling and do not call `focus()`. An unsolicited incoming request merely becomes
visible. The initiating control is disabled by the existing busy contract and some
browsers therefore return focus to the document body; visibility handling must not
move focus into the new card or synthesize an action. Repeated progress or state
updates must not move the page again.

Because an individual activity card is far shorter than the full transfer
surface, reveal only its decision-bearing edge rather than a wrapper containing
all activity. This avoids `nearest` aligning the far edge of an over-tall wrapper
and leaving the verification row outside the viewport.

## Accessibility

Keep a visually hidden `role="status"`, `aria-live="polite"`, `aria-atomic="true"`
node mounted before events occur. On an eligible reveal edge, update it with the
already localized request/status text plus the verification code where one exists.
Never include protected text message bodies. Do not make the whole activity
wrapper live, because file progress and message history updates would produce
repetitive announcements. No reveal may move focus or synthesize acceptance.

The existing visible verification code and explicit accept/decline or send
controls remain the source of action. The live announcement is supplementary.

## Layout implications

- Mobile LAN is the primary corrected case: the activity card becomes the first
  task below the compact identity area, and its marker is minimally revealed.
- Wide LAN keeps the entire workflow in the existing task column. Activity-first
  ordering improves scanning; `nearest` is naturally a no-op when the card is
  already visible.
- Cross-network/direct keeps its existing realtime card and heading. Since it
  renders the same transfer snippet, the active exchange rises above the peer
  context inside that card; pairing-code and pre-connection states are unchanged.
- Long translations, dark mode and Arabic RTL use the existing shared card, code,
  button and flow primitives. No CSS visual-order trick may diverge from reading
  order.

## Security and compatibility invariants

- Never auto-confirm a room recipient, accept a file, accept a text session, or
  send content as a consequence of visibility handling.
- Never render or announce protected text/file content earlier than today.
- Preserve the exact SAS computation, value, comparison copy and consent gates.
- Preserve file cancel/resume/save-target behavior, text history/draft behavior,
  busy mutual exclusion and notification behavior.
- Preserve old-client capability suppression and signaling behavior.
- File and text remain mutually exclusive in this batch. A coherent mixed Web
  session is a separately recorded follow-up; CLI unification is excluded.

## Regression coverage and acceptance

- Static/component coverage requires activity markup to precede the peer section
  in real DOM order, one render site for `MessagePanel`, a persistent polite live
  node, and no focus call or smooth scroll in the reveal path.
- Existing `MessagePanel` tests continue to prove that incoming consent renders
  only request metadata, SAS and actions—not message history content.
- At 390×844 and 320×844, real two-tab LAN scenarios cover file sender, file
  receiver, text sender and text receiver. The verification row and required
  decision controls must be within the visual viewport after the transition, with
  zero horizontal overflow.
- A real 390×844 two-tab request containing 40 deliberately long filenames covers
  the capped manifest boundary; its SAS and both consent controls remain visible.
- Visibility handling never focuses the new card or one of its actions; accepting
  or sending still requires the existing explicit click. Natural blur when the
  initiating peer control becomes disabled is allowed.
- Further changes in the same exchange do not alter scroll position. A second,
  later exchange can reveal again.
- Wide 1440×900 LAN does not acquire a page scroll when the activity was already
  visible. Cross/direct inherits the same ordering and reveal behavior inside its
  active card.
- Browser review covers all nine locales at phone width plus dark Arabic RTL.
  Existing full file, resume, text and old-peer E2E scenarios remain green.

## Delivery and production evidence

- Delivered on 2026-08-01 as exact public SHA
  `0c0e9cf6acded55aa2b40224df13b4e84c0aa400`; repository-hygiene run
  `30683215303` passed.
- Production served the exact final main assets `index-wfw_giFb.js` and
  `index-v9jAsopI.css`, and `/healthz` returned `ok`.
- A fresh production Chrome session at 390×844 established a real two-tab text
  session. Both devices showed SAS `674560`; the sender SAS occupied y=381–452,
  the receiver SAS y=389–460 and its consent controls ended at y=508. Both panels
  preceded peer selection in the DOM, had zero horizontal overflow, moved no focus
  into activity, and exposed localized polite announcements containing the SAS.
- The same tabs then created and explicitly rejected a real file request. Both
  devices showed SAS `927379`; the sender verification status occupied y=288–339,
  the receiver SAS y=399–470 and consent controls ended at y=520. The same DOM,
  overflow, focus and announcement contracts held. No file was accepted or saved.
  Console output was limited to the known Cloudflare Insights CSP rejection. The
  dedicated production browser was closed afterward.

## Explicit non-goals

- No mixed file/text session or unified authenticated data channel.
- No CLI command or CLI transfer UI change.
- No peer-card visual redesign, general page restyling, or marketing-page audit.
- No protocol, API, server, relay, persistence or production-operations change.
