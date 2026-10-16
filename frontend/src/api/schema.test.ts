// 生成物不能漂移：schema.d.ts 必须是当前 openapi.json 的产物。
//
// 上游那半环由 backend/tests/test_openapi.py 保证（openapi.json 与后端代码一致），
// 这里补上「JSON → TS」这一环 —— 改了接口、也重新导出了 JSON，却忘了跑
// `pnpm gen:api` 时，这条会红并直接给出命令。
// tsc 未必能发现这种过期：新增的可选字段不会让前端报错。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("生成的接口类型", () => {
  it("schema.d.ts 与当前 openapi.json 的哈希一致", () => {
    const digest = createHash("sha256")
      .update(read("../../../backend/openapi.json"))
      .digest("hex");
    expect(
      read("./schema.sha256").trim(),
      "接口类型已过期：cd frontend && pnpm gen:api",
    ).toBe(digest);
  });
});
