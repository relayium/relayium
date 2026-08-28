# `docs/superpowers/` — dated design history

**Nothing in this directory is a statement about how Relayium currently works.**

`plans/` and `specs/` are the design records written *before* each slice of work
— what was intended on the day it was written, by whom, under the constraints
that applied then. They are kept because the reasoning is genuinely useful: why
a boundary is where it is, which alternatives were rejected, what a decision was
trading against. That value is historical, and it does not decay into
authority.

Several of these documents describe work that was later reshaped, deferred, or
dropped, and a file name ending in `-DEFERRED.md` is only the subset that was
honest enough to say so in its title. A plan is not amended when reality moves;
a new one is written. So the older a file here is, the more likely it is to
describe something that never shipped in that shape.

## What to read instead, when you need to know what is true

| Question | Authority |
| --- | --- |
| What does the product do today? | The root [`README.md`](../../README.md), and the live site. |
| What does the wire actually carry? | The specifications in [`../protocol/`](../protocol), which are versioned and maintained. |
| What are the frozen invariants? | [`../DEVICE-INBOX-ADMISSION-CONTRACT.md`](../DEVICE-INBOX-ADMISSION-CONTRACT.md) and the contracts beside it. |
| How does this code behave? | The code and its tests. When a document and a test disagree, the test is what runs. |
| What is released, on which channel? | `web/native-releases.json`, `web/mac-app-store-release.json`, and the `/releases` page they feed. |
| What is still outstanding? | The requirement records under [`../`](..), each of which carries an explicit status. |

## If you are proposing a change

Read the relevant plan or spec for the *rationale* — it will usually tell you
why the obvious simplification was already considered and rejected. Then check
the current behaviour against the code and the protocol documents before
relying on any specific claim in it. Citing a file from this directory as
evidence that the product behaves some way is the one use it does not support.

Do not update these files to match new behaviour. They are a record of what was
decided when, and editing them to agree with the present destroys the only thing
they are for.
