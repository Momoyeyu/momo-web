import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import {guardWebProxy} from './dev/web-origin.ts';

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
const devToken = env('MOMO_DESKTOP_TOKEN');
const devOrigin = env('MOMO_WEB_ORIGIN');

const strip = (name: string) => (path: string) =>
  path.replace(new RegExp(`^/proxy/${name}`), "") || "/";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: UPSTREAM.api,
        changeOrigin: true,
        // 内置 ASR 走 /api/asr/stream（WS）
        ws: true,
        // Capability stays in the Vite process, never in the client bundle.
        headers: devToken ? {'x-momo-token': devToken} : undefined,
        configure(proxy) {
          const check=guardWebProxy(devOrigin);
          // Change the actual outgoing request: removing an incoming header
          // after the proxy has constructed its request does not revoke it.
          proxy.on('proxyReq', check);
          proxy.on('proxyReqWs', check);
        },
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
    // e2e/ 是 Playwright 的 spec（要真浏览器 + 跑着的实例），不归 vitest 收集；
    // 否则 pnpm test 会去执行 playwright 的 test.beforeEach 并整批报错。
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
