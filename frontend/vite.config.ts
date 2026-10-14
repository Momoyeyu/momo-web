import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// dev 代理：浏览器直连遇到无 CORS 头的服务（如本地 momo-svc）时，
// 设置页填 http://localhost:<devPort>/proxy/<llm|asr|tts> 即可绕过。
// 上游可用 env 覆盖：MOMO_WEB_LLM_UPSTREAM / _ASR_ / _TTS_。
// /api/* 走 FastAPI backend（state 存储 / chat SSE / 记忆 REST），
// 上游可用 MOMO_WEB_API_UPSTREAM 覆盖。
const env = (k: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[k];
const UPSTREAM = {
  api: env("MOMO_WEB_API_UPSTREAM") ?? "http://127.0.0.1:7821",
  llm: env("MOMO_WEB_LLM_UPSTREAM") ?? "http://127.0.0.1:7820",
  asr: env("MOMO_WEB_ASR_UPSTREAM") ?? "http://127.0.0.1:17810",
  tts: env("MOMO_WEB_TTS_UPSTREAM") ?? "http://127.0.0.1:17811",
};

const strip = (name: string) => (path: string) =>
  path.replace(new RegExp(`^/proxy/${name}`), "") || "/";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: UPSTREAM.api,
        changeOrigin: true,
      },
      "/proxy/llm": {
        target: UPSTREAM.llm,
        changeOrigin: true,
        rewrite: strip("llm"),
      },
      "/proxy/asr": {
        target: UPSTREAM.asr,
        changeOrigin: true,
        ws: true,
        rewrite: strip("asr"),
      },
      "/proxy/tts": {
        target: UPSTREAM.tts,
        changeOrigin: true,
        rewrite: strip("tts"),
      },
    },
  },
  test: {
    environment: "node",
  },
});
