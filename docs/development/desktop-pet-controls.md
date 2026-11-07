# Desktop companion controls (2026-11-07)

## Behavior

- Reuse chat's right-hand rail, icon paths, centered buttons and progressive tooltips. Test both the 360×520 desktop window and 320×440 compact layout.
- Default to a folded text dialogue. Folding moves/fades the existing drawer without remounting chat, suspending the microphone, stopping TTS or creating another engine. The rail exposes framing, microphone, dialogue, click-through and return to chat.
- Full-body and waist-up framing reserve rail clearance. Returning restores chat's framing. Pointer capture on the body region forwards drag start/move/end; blur and cancellation end it. Native dragging moves only this pet window and clamps it to the work area.
- Portal the rail into the app shell, outside chat's inert boundary. Waiting/error gates cannot disable recovery controls.

## Click-through

The preference and the native ignore-mouse flag are separate states:

1. The renderer reports normalized rail/dialogue/help/modal rectangles every 100ms, with an 8px margin.
2. While enabled, the host checks the native cursor against current window bounds every 16ms. Protected regions accept input; other areas pass clicks through. Native state changes only when necessary.
3. Missing/empty geometry or a report older than one second restores input. Exit stops the timer and clears ignore. Non-finite/out-of-bounds rectangles and more than 64 rectangles are rejected.
4. Existing trusted-main-frame IPC checks apply. No shell commands, system permission grants or target-app input are introduced. Older hosts without the protected-region API cannot enable this preference through the new renderer.
5. Existing Tray/shortcut recovery remains an additional fallback.

## Reference

Inspected AIRI's website and local desktop source: `apps/stage-tamagotchi/src/main/windows/main/index.ts` and `renderer/components/stage-islands/controls-island/index.vue`. AIRI explicitly works around macOS draggable-region cursor issues. momo retains its own visual system and uses an own-window pointer/native-delta bridge without adding AIRI's native drag dependency. No source/assets were copied.

## Validation and remaining installation work

- 29 shell tests passed: protected regions, moved windows, stale geometry, malformed payloads, drag limits/cancellation and recovery.
- Browser regression covers three languages, two pet sizes, centered icons, non-overlapping expanded dialogue, full/half body, folding, drag event routing, region reports, and escape while chat is inert. Screenshots inspected; isolated data only.
- Temporary Electron window with the production WindowModeController verified enabling/disabling click-through, underlying test-window input and recovery after stopping region reports. This is not the installed package.
- The computer-use driver's synthetic drag left Electron's native cursor unchanged. Actual drag distance therefore remains an installed/manual smoke item; browser event routing and host movement/clamping were verified separately.
- Do not reinstall for each visual edit. Consolidate this source with pending observation/input fixes. 006/017 remain open until the installed candidate passes remaining smoke checks.

## Desktop scene actions (2026-11-07)

Chat has a scene switch to desktop and a phone for QQ; it no longer duplicates the plugin directory in an Extensions modal. The pet rail adds one Observe action with a live active state. Opening it discovers eligible windows; selecting a target and starting uses the existing per-application approval contract. Current window and stop remain available on reopening. Application interaction and proactive reactions are secondary disclosures. Browser and Minecraft activity controls are accessible inside this desktop context; plugin installation, enablement and persistent grants remain in Settings.

The compact observation panel scrolls within the pet viewport, participates in protected click-through regions, and does not create a renderer or conversation. Closing it does not stop observation; the pet's status poll resumes the existing scheduler after delayed authorization. Stopping is explicit. The underlying system recording permission and vision capability requirements remain enforced.

Regression covers three locales, 360×520 and 320×440, observation selection/start/stop/reopen, both secondary activity entries, no duplicate chat menu, protected regions and dialog/rail separation. Native real screen interpretation still requires the separately tracked authorized smoke; UI fixtures are not that evidence.
