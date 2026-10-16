// 由后端的契约文件生成前端接口类型，并记录本次所用的来源哈希。
//
//     pnpm gen:api
//
// 哈希由 src/api/schema.test.ts 校验：如果改了接口、重新导出了 openapi.json，
// 却忘了跑这条命令，测试会红并提示重新生成。
// （上游那半环由 backend/tests/test_openapi.py 保证 openapi.json 与后端代码一致。）
//
// 这里调用 openapi-typescript 的 CLI 而不是它的 JS API —— 两者输出格式不同
// （CLI 会写 auto-generated 头），用 CLI 才能保证生成结果与历史提交逐字一致。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const SCHEMA = path("../../backend/openapi.json");
const OUT = path("../src/api/schema.d.ts");
const HASH_OUT = path("../src/api/schema.sha256");

execFileSync(path("../node_modules/.bin/openapi-typescript"), [SCHEMA, "-o", OUT], {
  stdio: "inherit",
});
writeFileSync(
  HASH_OUT,
  createHash("sha256").update(readFileSync(SCHEMA)).digest("hex") + "\n",
);
console.log("已生成 src/api/schema.d.ts 与 schema.sha256");
