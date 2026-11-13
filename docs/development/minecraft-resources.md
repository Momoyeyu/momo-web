# Minecraft existing-client integration

The plugin attaches to the player's existing Fabric 1.21.1 client and current world/account. It does not launch Minecraft, download vanilla assets, authenticate an account, or maintain a second game instance.

Run `python3 scripts/prepare-minecraft-runtime.py` once during build preparation to verify the pinned official Baritone dependency (network only at build time). Then build the original mod using `scripts/build-minecraft-component.py` with verified Gradle8.10.2/Java21. The install API copies only that mod into an explicitly selected existing instance's `mods` folder, rejecting symlinks and differing existing files. Restart the selected client using the player's normal launcher. Fabric API0.116.4+1.21.1 is required. Automatic mod-loader changes are not performed.

The mod generates a random local bridge token and ephemeral loopback port, writing owner-only discovery under `~/.momo/minecraft-bridge/PID.json`. Credentials are never returned to UI. Discovery reads a bounded owner-only regular file using O_NOFOLLOW, checks live PID, then authenticated ping. The UI selects a detected session and grants observe/chat/move; attach rechecks world/account before configuring Cordis. Commands continue checking identity and activity epoch. Stop releases keys and target; it never closes the player's game.

The deterministic bounded ground navigator detours around walls on safe level terrain, with a fixed node budget and no digging/jumping. It refuses unsafe/unloaded terrain and stops on deadline, lost target, GUI, death, world/account change, or revoke. Vertical traversal and general survival are not implemented.

Actual Fabric build and pathSmoke passed. Backend discovery/identity/install tests passed. Existing authenticated-player world E2E remains to be performed; prior synthetic menu smoke is not evidence for this replacement attachment flow.

The continuous-runtime 007 refactor nests the verified Baritone Fabric 1.11.3 jar in the companion mod; its LGPL notice and source URL are shipped under META-INF/licenses. The API caller uses scoped settings for navigation (no implicit breaking/placing, chat command control or cache packing) and restores them when control ends. Legacy gameplay API remains until the new skill matrix passes; compile success does not establish full gameplay acceptance.
