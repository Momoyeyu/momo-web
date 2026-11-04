# Computer extensions implementation ledger

Status: in progress; not accepted or complete. Updated 2026-11-05.

## Approved scope

One Cordis extension model and one Python coordinator. Desktop observation and computer interaction share grants, attention and cancellation. Minecraft is a specialized game adapter, with Fabric as an implementation resource, not a second plugin system. Browser automation remains a thin executor. Web first; no desktop repository promotion.

## Implemented and checked

- Versioned JSON package contract, strict paths/size/manifest checks, atomic disabled-by-default installation, explicit trust review, disk reconstruction, enable/disable/removal and retryable unconfirmed stop. Portable example included in `plugin-host/examples/hello-plugin.json`.
- Imported plugins are out-of-process MCP tool providers owned by Cordis. They run with the local user's permissions after explicit trust; capability labels are **not** sandbox enforcement. V1 does not yet support third-party phone views, channels or arbitrary frontend code. See `plugin-host/PLUGIN-FORMAT.md`.
- Registry-backed imported-plugin list, search and five-item pagination. Existing MCP pagination reused. Browser tests cover 11 plugins and 17 MCP entries, search and deletion of the correct underlying record.
- Selected screen capture and optional reactions. Normal chat consumes transient actual pixels; proactive output uses normal sentence/TTS/display acknowledgement without a fabricated player row.
- Restricted browser execution, exact-host public HTTPS reads, current-run local-owner tools and transient screenshots. Real Docker fixture and Cordis revoke tests pass.
- Fabric component builds; bounded adapter, API, model tool and resource qualification tests pass. No live account or world modified.

## Additional design decisions and reasons

1. Preserve a failed-stop plugin record and offer retry instead of deleting it: otherwise a surviving process becomes invisible.
2. Keep imported code out of the trusted Cordis process and document the trust boundary: package validation cannot sandbox arbitrary Node code.
3. Inject screen pixels only into a single provider request, with TTL and a second authorization check: avoids durable capture and stale permission reuse during compact/revoke races.
4. Use normal chat presentation for screen reactions: preserves one personality, history and actual-display accounting.
5. Use a network-disabled renderer plus narrowly scoped fetch for the first browser slice: a separate Chromium profile alone does not isolate host files or private-network access.
6. Do not add another MCP list implementation; verify the existing pagination and index mapping.

## Remaining acceptance requirements

- Native desktop overlay and general computer interaction; background Web capture limitations.
- Product-managed isolated environment preparation; current development Docker prerequisite is not a release UX.
- Full browser site behavior beyond read-only snapshots, if retained in the accepted scope.
- Minecraft assets/native closure, legitimate account provider and managed launch, robust following, real private-world acceptance.
- Full final review, CI and user acceptance. Do not archive 006/007/008 as done.
