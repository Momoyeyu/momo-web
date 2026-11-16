# Minecraft existing-client integration

The plugin attaches to the player's existing **Java 1.21.1 / Fabric** client, current account and selected world. It does not launch a second client, authenticate another account, require Docker, or give momo a system shell. Python remains the only goal, conversation and memory coordinator; Cordis transports typed tasks; Fabric advances the local body on game ticks.

## Locked build inputs

`scripts/minecraft-resources.json` pins the official Baritone Fabric API **1.11.3** artifact, its SHA-256, Minecraft version, source, release and LGPL license. Prepare it at build time:

```sh
python3 scripts/prepare-minecraft-runtime.py
python3 scripts/build-minecraft-component.py --gradle /path/to/gradle-8.10.2/bin/gradle --cache /path/to/build-cache
```

Java 21 and verified Gradle 8.10.2 are required. The builder verifies the already prepared dependency offline before loading bytecode. The production companion nests the unmodified upstream JAR, embeds the dependency lock, and includes LGPL and source/release notices under `META-INF/licenses`. Distribution validation rejects developer fixture content, a wrong mod identity, a different nested dependency or hash, and missing lock/notices. The builder writes a sibling `.provenance.json` containing the actual companion digest, shared source revision and dependency lock. Desktop staging must validate this record against the exact JAR it copies; compilation alone does not prove what the app ships.

The one-way promotion includes the lock, preparer and component builder alongside shared `frontend`, `backend` and `plugin-host` sources. Generated JARs, dependency caches, test worlds and private reports do not enter Git. Development acceptance fixtures are a separate opt-in source set and must never enter the production companion or installed resources.

## Attachment and authorization

The install API copies the managed companion into an explicitly selected existing instance's `mods` folder. It rejects symlinks and unrelated files, and updates only the recognized companion. Fabric API **0.116.4+1.21.1** is required; the plugin does not silently alter the player's mod loader. Restart the selected client through the normal launcher after a mod update.

The mod creates a random token and ephemeral loopback port in an owner-only `~/.momo/minecraft-bridge/PID.json`. Discovery uses a bounded regular file, `O_NOFOLLOW`, a live PID and authenticated ping. Tokens are not returned to the UI. Explicit attachment binds world and account; commands also check activity epoch. Observation is separate from unified gameplay permission (`game.modify`), which covers world changes, local survival and PvP. Normal play does not prompt per action. Stop releases control and keys without closing Minecraft. This implementation requires foreground play; no background-game support is claimed.

## Execution and perception

Semantic submit returns a task ID and acceptance, not completion. A single body executes queued/running/paused tasks and publishes actual progress, terminal state and evidence. Typed plans support bounded conditions/retry; unknown side effects are never retried or skipped. Continuous skills and heartbeat do not wait for each model answer. Menus, manual takeover, death, scene changes and revoked activity pass through the same control barrier.

Baritone replaces the retired simple ground navigator. Default navigation preserves terrain; an explicitly selected `terrain=adapt` route can use owned materials for ordinary clearing/bridging. Scoped settings disable command control and persistent world-cache packing, and restore the player's settings when control ends. Perception uses visible entities, first-hit block rays, owned inventory and visited-place memory. Hidden drops, hidden moving-target coordinates and unknown underground resources are not a source of knowledge. Placement requires a ray hit on the requested support face immediately before use.

Goals survive compaction and restart as intentions, never restored permission. Every submit first stores an immutable activity/world/account/task intent even without a goal. Known pre-dispatch rejection is distinct from an unknown transport result. After a fresh explicit grant, `task` with the original `activityId` reads historical facts only; it never contacts the body, restores an old lease or replays a command. Actual late/stop receipts belong to the original activity.

## Verification status

The current contract, full vanilla capability matrix, final installed acceptance gates and known remaining work are in [007](007-flowing-minecraft.md). Actual tests, failures and scope limits are in [the evidence record](evidence/007-minecraft.md). Source tests and isolated fixtures do not establish complete autonomous play, physical takeover, or installed product parity. Keep 007 active until those full-scope gates pass.

## Additional building reference

The user-supplied [minecraft-build-design assessment](minecraft-build-design-reference.md) records pinned source links and the useful declarative-design, materials and liveability checks. Its Litematica paste test is distinct from survival execution. No shell, save scanning, dependency or second model loop was added by this assessment.
