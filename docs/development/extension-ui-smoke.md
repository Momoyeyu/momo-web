# Extension UI smoke (2026-11-05)

- Settings uses four cards per page, 2×2 grid, matching outer card geometry for QQ, screen, browser and Minecraft. Desktop controls moved into its detail modal.
- Backend `/api/extensions/activities` owns enable state. Enabling does not start capture or execution. Failed disable refreshes authoritative state.
- Chat right rail has one Extensions button. Its modal reuses enabled plugin components; activity/configuration state is read from the same backend. No additional model loop.
- Removed `scrollIntoView` on plugin page/tab changes: it scrolled the horizontal animated extension viewport, clipping the first card column. Captured settled screenshots after the fix.
- Smoke35 pagination/trust passes. Smoke41 passes at 1280×720 and1920×1080; inspected1280 screenshot, cards and pager visible with no overlap. Evidence under ignored `target/browser-e2e/momo-browser-e2e-uEoynV`.
- Minecraft detail now attaches an existing game session via mod discovery. No managed client, account login or launcher in UI. New smoke40 covers this flow with synthetic session.
- Remaining verification: filled Live2D/MCP pages in all languages; browser detail adaptation to existing-browser attachment; real native activity integration smoke. Do not call these complete based on mocked UI checks.

## Continued checks

- Filled Live2D/MCP fixtures exposed footer occlusion at1280×720. Reduced thumbnail/padding (font unchanged); five rows and pager now fit. Smoke42 all6 language/sizecases passed (zh/en/ja ×1280/1920). Inspected Englishavatar andJapaneseMCP screenshots in `momo-browser-e2e-9ObNvx`.
- NativeCompanion now attaches an existing window for both desktop/browser. Independent browser URL/domain/snapshot controls removed.
- Global application permission modal provides explicit once/always/deny, reason and capabilities; close denies. Native start retries only the same captured request after explicit grant. Desktop detail lists and revokes durable grants.
- Smoke38 three decision branches passed; screenshot inspected (`momo-browser-e2e-uFNNjU`). Smoke39 now covers native frame scheduler across settings/Chat plus explicitstop, passed (`momo-browser-e2e-v2lIdM`). Both use synthetic transport fixtures, not proof of OS capture.
- Native frame scheduling is module-owned and uses existing computer status/reaction flow. Proactive/reaction switches remain; no extra reasoning loop. Parent must verify actual native host/APIs end-to-end.
