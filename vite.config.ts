import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// dev 代理：浏览器直连遇到无 CORS 头的服务（如本地 momo-svc）时，
// 设置页填 http://localhost:<devPort>/proxy/<llm|asr|tts> 即可绕过。
// 上游可用 env 覆盖：MOMO_DEMO_LLM_UPSTREAM / _ASR_ / _TTS_。
const env = (k: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[k];
const UPSTREAM = {
  llm: env("MOMO_DEMO_LLM_UPSTREAM") ?? "http://127.0.0.1:7820",
  asr: env("MOMO_DEMO_ASR_UPSTREAM") ?? "http://127.0.0.1:17810",
  tts: env("MOMO_DEMO_TTS_UPSTREAM") ?? "http://127.0.0.1:17811",
};

const strip = (name: string) => (path: string) =>
  path.replace(new RegExp(`^/proxy/${name}`), "") || "/";

// 配置持久化：GET/PUT /api/state ↔ 项目根 .momo-state.json，
// 让设置（含 key）不依赖 localStorage（换端口/清缓存不丢）。
const STATE_FILE = fileURLToPath(new URL(".momo-state.json", import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: "momo-state",
      configureServer(server) {
        server.middlewares.use("/api/state", (req, res) => {
          if (req.method === "GET") {
            let body = "";
            try {
              body = readFileSync(STATE_FILE, "utf8");
            } catch {
              body = "";
            }
            res.setHeader("content-type", "application/json");
            res.end(body);
            return;
          }
          if (req.method === "PUT") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              try {
                // 只接受 JSON 对象；落盘前校验避免半截写入。
                JSON.parse(body);
                writeFileSync(STATE_FILE, body);
                res.statusCode = 204;
              } catch {
                res.statusCode = 400;
              }
              res.end();
            });
            return;
          }
          res.statusCode = 405;
          res.end();
        });
      },
    },
  ],
  server: {
    proxy: {
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
