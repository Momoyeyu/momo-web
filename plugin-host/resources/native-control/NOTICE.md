Native observation/input uses AIRI's NSWorkspace + CGWindowList + paced Quartz Unicode event approach.
Source: https://github.com/moeru-ai/airi/blob/3ecb515de13d70fe67b74a7fa5a80b9c4e59149e/services/computer-use-mcp/src/executors/macos-local.ts
MIT license retained. momo changes: fixed action vocabulary, no launch/focus/shell/hotkeys, selected window + PID + foreground check before events, local coordinates and bounded inputs.
