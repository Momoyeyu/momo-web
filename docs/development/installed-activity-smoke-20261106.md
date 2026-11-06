# Installed activity smoke — 2026-11-06

Installed product: desktop `637380c`, shared source `14c142d`. Existing profile was privately backed up before replacement. The old application bundle and duplicate candidate were removed after installed startup/settings verification. Subsequent fixes below are source changes, not changes to that installed binary.

## Verified on the installed application

- Title/Boot/chat/settings navigation; inline audio preview and unified plugin cards.
- Official Minecraft launcher, existing account, Fabric Loader 0.16.14 / Minecraft 1.21.1 / Fabric API 0.116.4+1.21.1. A separate test game directory protects existing newer-version worlds; there is no separate account or product-managed client.
- Maintainer entered a fresh single-player test world. momo discovered and attached to its current character/world with observation permission only.
- The local model requested observation. Adapter state changed from stopped to running; response reported world/health/visible-player information and identified the open game menu. Tool pixels are ephemeral, so there is no retained pixel trace proving terrain recognition. This is not movement or multiplayer acceptance.
- Returning to title is the existing activity revocation path. No game chat or movement was authorized during this smoke.

## Defects found and fixed in source

1. Status returned adapter `stopped`, but the UI read `active`/`connected`. Successful attach therefore appeared stopped and disabled the stop button. Backend status now explicitly exposes binding authority as `active`, independently of the adapter's last command state.
2. The model had observe/chat/follow but no stop action. A spoken request to stop did not revoke the connection. `minecraft_action: stop` now revokes the binding immediately for a current local owner run, including focus mode; it does not require vision or remaining action budget. External-channel requests and stale runs remain denied.
3. Window discovery discarded returned system-permission flags. Compact notices now distinguish explicit permission denial from an empty visible-window list, with details behind the existing hint control. An empty list alone is not proof of denied recording permission.

Validation: 40 relevant backend tests, four Minecraft host tests, four frontend notice tests, and frontend TypeScript check passed. These fixes require the next consolidated package; no additional installation was performed for them.

## Still outstanding

- Real application-window capture/input through the installed native helper and the user's system grants.
- Actual Minecraft terrain recognition, chat and movement/follow with an appropriate test target; corrected UI stop and local-model stop in the consolidated installation.
- Browser observation/input using an existing approved browser. No tablet or separate browser profile is planned.

006/007/008/016/017 remain open. Synthetic and unit checks do not replace these remaining real interactions.
