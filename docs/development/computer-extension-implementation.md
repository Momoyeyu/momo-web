# Computer extensions implementation ledger

Status: in progress; not accepted or complete. Updated 2026-11-05.

## Approved scope

One Cordis extension model and one Python coordinator. Desktop observation and computer interaction share grants, attention and cancellation. Minecraft is a specialized game adapter, with Fabric as an implementation resource, not a second plugin system. Browser automation remains a thin executor. Web first; no desktop repository promotion.

## Implemented and checked

- Versioned JSON package contract, strict paths/size/manifest checks, atomic disabled-by-default installation, explicit trust review, disk reconstruction, enable/disable/removal and retryable unconfirmed stop. Portable example included in `plugin-host/examples/hello-plugin.json`.
- Imported plugins are out-of-process MCP tool providers owned by Cordis. They run with the local user's permissions after explicit trust; capability labels are **not** sandbox enforcement. V1 does not yet support third-party phone views, channels or arbitrary frontend code. See `plugin-host/PLUGIN-FORMAT.md`.
- Registry-backed imported-plugin list, search and four-item paginated grid. Existing MCP pagination reused. Browser tests cover 11 plugins and 17 MCP entries, search and deletion of the correct underlying record.
- Selected screen capture and optional reactions. Normal chat consumes transient actual pixels; proactive output uses normal sentence/TTS/display acknowledgement without a fabricated player row.
- Existing application native broker replaces the retired Docker renderer. Browser and desktop share selected-window control; no independent browser session is created.
- Existing Minecraft instance discovery/attach replaces the mistaken independent account/client workflow. Fixed Fabric actions include bounded obstacle navigation; no account credentials are read.
- Native window observation and bounded input share grant/version checks; DOM semantic attachment to existing browser sessions is not implemented.
- Application approval supports once/always/deny, scoped capabilities and editable revocable allowlist. It is authorization, not an OS sandbox.
- Shared card layout, one Chat extension entry and three-language filled-list tests at720p/1080p are implemented.

## Additional decisions and corrections

1. Failed-stop plugin ownership remains visible and retryable.
2. Imported code remains an explicitly trusted local process; capability metadata does not sandbox arbitrary code.
3. Screen evidence is transient and rechecked before provider submission.
4. Proactive reactions use the ordinary chat presentation path.
5. User corrected the architecture: operate existing applications. Docker renderer, independent game login/client/resource provisioning are removed, not release prerequisites.
6. Application permissions are separate from plugin enablement and current activity; permanent approval never implies unattended start.
7. Native helper uses AIRI's local executor approach with fixed actions and target identity checks, no new reasoning loop.

## Remaining acceptance requirements

- Native desktop overlay and general computer interaction; background Web capture limitations.
- Existing-application input smoke requires macOS Accessibility permission; no Docker prerequisite remains.
- Actual existing-browser interaction smoke and optional DOM semantic fast path.
- Existing Minecraft Fabric instance attachment and gameplay smoke; no new account or client registration required.
- Full final review, CI and user acceptance. Do not archive 006/007/008 as done.
