# `apps/mac/tools`

Developer scripts for the macOS app. This directory is a **sibling** of
`apps/mac/Relayium/`, not a child, because that folder is a
`PBXFileSystemSynchronizedRootGroup` — anything inside it is copied into the
shipped bundle. Source artwork and a developer script must not be.

## Regenerating the app icon

```
xcrun swift apps/mac/tools/render-app-icon.swift --mac \
  apps/mac/Relayium/Assets.xcassets/AppIcon.appiconset

xcrun swift apps/mac/tools/render-app-icon.swift --ios \
  apps/ios/Relayium/Assets.xcassets/AppIcon.appiconset
```

macOS writes seven PNGs (16, 32, 64, 128, 256, 512, 1024) and `Contents.json`.
iOS writes one 1024×1024 PNG and `Contents.json`, because iOS derives every
other size from it.

The renderer reads every colour, coordinate and path out of
`apps/mac/Brand/AppIcon.svg`. That SVG is the single place the artwork is
written down; the script holds no second copy of it, and neither does the iOS
mode — it renders the same artwork through one extra transform.

### Why the two platforms differ, and where

Two differences, both Apple's rules rather than taste:

- **Shape.** macOS draws its own rounded body inset in a larger canvas and the
  system does not mask it. iOS is a full-bleed square that the system masks
  itself, so drawing the inset body there would leave a transparent margin and
  then be masked again — a small glyph inside a ring of nothing. `--ios` maps
  the SVG's body rect onto the whole canvas before drawing, so the gradients and
  the glyph follow for free.
- **Alpha.** macOS needs the channel; **iOS must not have it**. App Store
  Connect rejects a transparent icon outright, and an opaque RGBA image still
  carries the channel and is still refused. `--ios` renders through
  `noneSkipLast` so the PNG is RGB. `IOSAppIconAssetTests` asserts PNG colour
  type 2, because this is an upload-time rejection: every build, test and
  simulator run passes with a transparent icon.

### This is a human command

**Nothing runs it automatically** — not CI, not `xcodebuild`, not `swift test`.
That is deliberate. The seven PNGs are tracked in git as the *reviewed
artifact*: what ships is what a person looked at. A build phase that re-rendered
them would mean the icon in a signed build had never been seen by anyone.

The consequence is worth stating plainly: editing `AppIcon.svg` without
re-running this command leaves the catalog stale, and **no test will tell you**.
`AppIconArtworkTests` checks that the SVG still matches the web mark, and
`AppIconAssetTests` checks that the PNGs are structurally sound — neither
compares one against the other. That gap is closed by review, so an SVG change
and its re-rendered PNGs belong in the same commit.

### Why the tests do not compare bytes

CoreGraphics rasterization is a system service and may legitimately change
across macOS releases. `AppIconAssetTests` therefore asserts structure —
dimensions, alpha topology, and colour family at named sample points — never
bytes. Re-rendering and finding a byte difference with no structural difference
is a toolchain change, not a regression.
