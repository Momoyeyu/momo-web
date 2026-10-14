import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { checkManifest, listManifests } from "./avatarZip";

const MANIFEST = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: "M.moc3",
    Textures: ["M.2048/texture_00.png"],
    Physics: "M.physics3.json",
    Motions: {
      Idle: [{ File: "motions/idle.motion3.json" }],
    },
  },
  Name: "TestModel",
});

async function zipOf(files: Record<string, string>): Promise<JSZip> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  await zip.generateAsync({ type: "arraybuffer" }); // 规范化结构
  return JSZip.loadAsync(await zip.generateAsync({ type: "arraybuffer" }));
}

describe("listManifests", () => {
  it("找出全部 .model3.json，忽略目录与非 manifest 文件", async () => {
    const zip = await zipOf({
      "m/M.model3.json": MANIFEST,
      "m/M.moc3": "x",
      "m/extra.model3.json": MANIFEST,
      "m/readme.txt": "hi",
    });
    expect(listManifests(zip)).toEqual([
      "m/M.model3.json",
      "m/extra.model3.json",
    ]);
  });

  it("无 manifest 返回空数组", async () => {
    const zip = await zipOf({ "a.txt": "x" });
    expect(listManifests(zip)).toEqual([]);
  });
});

describe("checkManifest", () => {
  const files = {
    "m/M.model3.json": MANIFEST,
    "m/M.moc3": "bin",
    "m/M.2048/texture_00.png": "png",
    "m/M.physics3.json": "{}",
    "m/motions/idle.motion3.json": "{}",
  };

  it("引用齐全 → missing 为空，hasMotions/Name 正确", async () => {
    const zip = await zipOf(files);
    const r = await checkManifest(zip, "m/M.model3.json");
    expect(r).toMatchObject({
      missing: [],
      hasMotions: true,
      name: "TestModel",
    });
  });

  it("引用缺失 → 列出 zip 内路径", async () => {
    const zip = await zipOf({
      "m/M.model3.json": MANIFEST,
      "m/M.moc3": "bin",
      // 缺 texture / physics / motion
    });
    const r = await checkManifest(zip, "m/M.model3.json");
    expect("missing" in r && r.missing.sort()).toEqual([
      "m/M.2048/texture_00.png",
      "m/M.physics3.json",
      "m/motions/idle.motion3.json",
    ]);
  });

  it("manifest 路径不存在 → error", async () => {
    const zip = await zipOf(files);
    const r = await checkManifest(zip, "m/nope.model3.json");
    expect("error" in r).toBe(true);
  });

  it("无 Motions 组 → hasMotions=false", async () => {
    const zip = await zipOf({
      "m/M.model3.json": JSON.stringify({
        Version: 3,
        FileReferences: { Moc: "M.moc3", Textures: ["t.png"] },
      }),
      "m/M.moc3": "bin",
      "m/t.png": "png",
    });
    const r = await checkManifest(zip, "m/M.model3.json");
    expect(r).toMatchObject({ missing: [], hasMotions: false });
  });
});
