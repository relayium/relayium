// What this artifact IS, as compiled metadata.
//
// ## Why this is a source constant and not an environment read
//
// The update core compares its own build against the feed's, and `build` is the
// gate: strictly greater, or there is no update. So the number has to be a
// property of the ARTIFACT, fixed when it is produced and identical on every
// machine that runs it. `process.env.npm_package_version` is none of those
// things — it exists only when a process was started through an npm script, is
// absent in a packaged app, and is mutable by whoever launched it. A build that
// read its own identity from the environment could be told it was newer than an
// update simply by starting it differently.
//
// The VERSION comes from `app.getVersion()`, which reads the packaged
// `package.json` baked into the bundle — compiled metadata by the same
// standard. Only the build NUMBER needs a home, because this product has never
// had one.
//
// ## Why zero, and why that is honest
//
// No released build exists. `BUILD_NUMBER` is therefore 0 and
// `BUILD_NUMBER_PROVISIONED` is false, which says plainly that this value is a
// placeholder rather than a version anybody shipped. Every real feed manifest
// declares a build greater than zero, so an unreleased engineering artifact
// correctly considers any published build newer than itself.
//
// **This must be set when the first artifact is released**, alongside the
// pinned feed keys, and by the same person: a build number that stayed at zero
// after a release would make the app offer to "update" to the version it is
// already running. It is deliberately a constant a release process edits and
// not a value derived from the semver — deriving one invents an ordering the
// feed never agreed to, and two different derivations would disagree about
// which of two artifacts is newer.
export const BUILD_NUMBER = 0;

/**
 * Whether `BUILD_NUMBER` names a real release.
 *
 * Read by nothing today. It exists so the placeholder cannot be mistaken for a
 * provisioned value by a later reader — and so a check for it can be added the
 * moment updates are enabled, rather than being remembered.
 */
export const BUILD_NUMBER_PROVISIONED = false;
