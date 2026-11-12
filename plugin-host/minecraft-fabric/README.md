# Minecraft Fabric companion

This is the game-specific component of momo's Cordis Minecraft plugin. It attaches to the player's existing Fabric client and account; momo neither provisions another client nor signs into Minecraft.

Pinned build: Minecraft Java 1.21.1, Yarn 1.21.1+build.3, Fabric Loader 0.16.14, Fabric API 0.116.4+1.21.1, Java 21, Loom 1.7.4, Gradle 8.10.2. Run `gradle --no-daemon build`; `check` includes the bounded-path smoke test. The release JAR is `build/libs/momo-fabric-companion-0.1.0.jar`. Desktop packaging copies it to `plugin-host/resources/minecraft/` outside asar.

The user explicitly selects an existing instance to install the JAR, then restarts that client. The mod generates a per-process token, binds a random loopback port, and publishes an owner-only discovery file under `~/.momo/minecraft-bridge/`. Stopping the game removes that file. momo rechecks PID, token, world and account before attaching; no public management port or model-provided script is exposed.

All game access runs on the game thread. Actions require the current Boot lease, verified visual model, application permissions and shared attention. Observation returns a bounded first-person screenshot and visible state. Chat rejects slash commands. Following uses bounded local path search and short movement leases, releasing keys when the target/world disappears, a menu opens, the player dies or the lease expires. It does not guarantee navigation through arbitrary terrain. Stop and permission revocation release controls; they do not terminate the player's client.

AIRI's Mineflayer approach informed the extension boundary; this Fabric bridge is original code, not an AIRI port. Build/transport smoke results do not substitute for acceptance in the user's selected game world. Windows discovery and permissions remain separately unverified.

Gameplay uses the independent `game.modify` grant. The `play` command holds a bounded
input lease (1–10000 ms) and supports combined movement, camera, attack/mining,
use/place/eat, hotbar, inventory, container slots, offhand swap, drop and respawn.
Inventory slot IDs come from observation, including crafting output and equipment.
Normalized screen coordinates and limited screen text/navigation cover in-game
interfaces such as recipe books, trading and signs. Slash commands remain rejected.

The Python coordinator waits for the lease outside its dispatch lock. Home, focus,
plugin disable and Stop can revoke during that wait. A gameplay observation expires
after 30 seconds to allow model latency, and every action still checks world/account
and revocation epoch. Observation also reports position, view, hunger, inventory,
cursor stack and targeted block. The per-minute action budget recovers automatically.

The November 12 live test used the player's existing survival test world and ordinary
inputs to collect dirt, pillar with blocks, harvest an oak log, craft planks, craft
a crafting table, place it and open the 3×3 interface. This verifies the bridge.
Autonomous model planning, combat, food, respawn and the additional interface inputs
need their own end-to-end checks before claiming complete gameplay coverage.
