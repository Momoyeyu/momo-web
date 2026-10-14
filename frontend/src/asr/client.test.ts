import { describe, expect, it } from "vitest";
import { asrUrl } from "./client";

const KEYLESS = { key: "" };

describe("asrUrl", () => {
  it("appends /v1/listen and default query when url has no path", () => {
    expect(asrUrl({ url: "ws://127.0.0.1:7810", ...KEYLESS })).toBe(
      "ws://127.0.0.1:7810/v1/listen?encoding=linear16&sample_rate=16000&channels=1&vad_events=true",
    );
  });

  it("treats a bare '/' path as missing", () => {
    const u = new URL(asrUrl({ url: "ws://127.0.0.1:7810/", ...KEYLESS }));
    expect(u.pathname).toBe("/v1/listen");
  });

  it("keeps an existing /v1/listen path", () => {
    const u = new URL(asrUrl({ url: "ws://127.0.0.1:7810/v1/listen", ...KEYLESS }));
    expect(u.pathname).toBe("/v1/listen");
  });

  it("appends /v1/listen under a custom base path", () => {
    const u = new URL(asrUrl({ url: "wss://asr.example.com/custom/ws", ...KEYLESS }));
    expect(u.pathname).toBe("/custom/ws/v1/listen");
    expect(u.searchParams.get("encoding")).toBe("linear16");
  });

  it("does not override query params already present in the url", () => {
    const u = new URL(
      asrUrl({ url: "ws://127.0.0.1:7810/v1/listen?sample_rate=8000", ...KEYLESS }),
    );
    expect(u.searchParams.get("sample_rate")).toBe("8000");
    expect(u.searchParams.getAll("sample_rate")).toHaveLength(1);
    expect(u.searchParams.get("encoding")).toBe("linear16");
  });

  it("adds token query when key is non-empty", () => {
    const u = new URL(asrUrl({ url: "ws://127.0.0.1:7810", key: "secret-key" }));
    expect(u.searchParams.get("token")).toBe("secret-key");
  });

  it("omits token when key is empty", () => {
    const u = new URL(asrUrl({ url: "ws://127.0.0.1:7810", ...KEYLESS }));
    expect(u.searchParams.has("token")).toBe(false);
  });

  it("preserves existing user query params", () => {
    const u = new URL(
      asrUrl({ url: "ws://127.0.0.1:7810/v1/listen?model=nova-3", ...KEYLESS }),
    );
    expect(u.searchParams.get("model")).toBe("nova-3");
  });
});
