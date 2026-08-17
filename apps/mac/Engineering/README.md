# Device Inbox v2 local engineering candidate

This candidate is a separate Release product. It is compiled for
`http://127.0.0.1:18080`, uses bundle id `com.relayium.mac.engineering`, has its
own defaults, Keychain service and Application Support root, carries no App
Group or Associated Domains entitlement, and does not start Sparkle. It cannot
be switched to another origin at runtime.

## Build after committing

The artifact folder must end in the current eight-character commit id:

```sh
SHA=$(git rev-parse --short=8 HEAD)
ARTIFACT=/Users/lily/code/relayium/test-builds/macos/1.2.9-local-v0.20-$SHA
scripts/build-macos-engineering-candidate.sh "$ARTIFACT"
```

## Start and check the local server

Build `web/dist` once if it is absent, then keep the server command running:

```sh
cd web && npm run build && cd ..
scripts/start-device-inbox-v2-local.sh "$ARTIFACT"
```

In another terminal:

```sh
scripts/check-device-inbox-v2-local.sh
```

Open <http://127.0.0.1:18080> in the browser and sign in to both the Web UI and
the engineering app with:

- Email: `engineering@relayium.local`
- Password: `relayium-local-v2`

The app must always show `ENGINEERING · LOCAL SERVER · 127.0.0.1:18080`. Use My
Devices / Device Inbox to send text, files and folders between the browser and
the engineering Mac device.

Stop the server with `Ctrl-C`. Local state is confined to
`$ARTIFACT/local-server`; remove that directory to reset the local account and
inbox. The candidate app and its generated DerivedData remain under `$ARTIFACT`.
