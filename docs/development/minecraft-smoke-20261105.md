# Minecraft continuation smoke — 2026-11-05

Source reference: AIRI integrations/minecraft/src/cognitive/reflex/runtime.ts and airi/airi-bridge.ts. Applied separation of deterministic movement and central cognition, visible-target gating and interruptible bounded actions. Did not copy AIRI's separate cognitive loop or survival autonomy.

- Added bounded ground navigation (512 expanded cells, radius16, cardinal movement, 5Hz replanning). Stops on unloaded terrain, non-solid floor, fluids, hazardous floor, lost target, death, GUI, revoked epoch, identity/world change or command timeout. No digging/jumping/building. This is ground obstacle detouring, not general vertical navigation.
- Java smoke covers wall detour, blocked terrain, expansion budget and already-arrived. Wired `pathSmoke` into Gradle check.
- Actual Fabric compileJava/remapJar/build succeeded, mod SHA256 536bfb4095e56fa6df583188c88821a45e6fc5c495f392d02c3b9306c497954c.
- Actual isolated graphical Minecraft client startup succeeded with synthetic menu-only identity and private temporary instance. Authenticated bridge returned `{ready:true,protocol:1}`; stop returned `{stopped:true}` and temporary instance was removed. No real account, existing world or server was used. This verifies client resources/bridge/lifetime, NOT licensed account login or in-world movement.
- Auth/resource/managed backend tests:18 passed.

Outstanding external prerequisite: momo's registered Microsoft public-client ID and account-holder authorization for genuine Xbox/Minecraft entitlement validation. Existing launcher account stores were not read; official launcher client IDs were not borrowed. Multiplayer-world gameplay E2E remains unverified and must not be claimed complete on this evidence.

## Superseding user correction: existing client only

The synthetic managed-client approach above is historical evidence only and no longer a product path. Managed login/launch/resources source was removed. Current mod discovers its own existing session through private rendezvous; UI chooses that session. New attach validation tests:3 passed. Actual replacement Fabricbuild/pathSmoke passed, jar SHA256750c7b79a14b658ac11a5f2d0ff837c5d0ccbb8604947a4b919c796919e9532f. In-world existing-player smoke still requires a running mod-enabled game selected by the player.
