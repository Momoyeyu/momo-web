// 用户导入 Live2D 模型：.zip 检查 + pixi-live2d-display ZipLoader 接线。
//
// 加载链路：Live2DModel.from([zipFile]) → ZipLoader 解包出 settings 声明的
// 文件（File + webkitRelativePath）→ FileLoader 为每个文件建 blob URL、
// 按声明路径映射（settings.resolveURL）。模型运行时相对路径照常解析。
// ZipLoader 的 zipReader/getFilePaths/getFiles/readText 在库里是 stub，
// 这里用 jszip 补齐（只在浏览器加载链路调用，不在模块顶层接线）。

import JSZip from "jszip";
import type { AvatarMeta } from "../lib/types";

/** zip 内 manifest（*.model3.json）清单。按路径排序保证稳定。 */
export function listManifests(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((p) => !zip.files[p].dir && p.endsWith(".model3.json"))
    .sort();
}

/** POSIX 路径解析：manifest 目录 + 相对引用 → zip 内路径。 */
function resolvePath(baseDir: string, rel: string): string {
  const parts = `${baseDir}${rel}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** model3.json FileReferences 声明的全部资源路径（已解析到 zip 内路径）。 */
function referencedFiles(manifestDir: string, json: unknown): string[] {
  const refs = (json as { FileReferences?: Record<string, unknown> })
    .FileReferences;
  if (!refs || typeof refs !== "object") return [];
  const files: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) files.push(resolvePath(manifestDir, v));
  };
  push(refs.Moc);
  push(refs.Physics);
  push(refs.Pose);
  push(refs.UserData);
  push(refs.DisplayInfo);
  for (const t of (refs.Textures as string[] | undefined) ?? []) push(t);
  for (const e of (refs.Expressions as { File?: string }[] | undefined) ?? [])
    push(e?.File);
  const motions = refs.Motions as
    | Record<string, { File?: string }[]>
    | undefined;
  for (const group of Object.values(motions ?? {}))
    for (const m of group ?? []) push(m?.File);
  return files;
}

/** 读取并解析指定 manifest。 */
async function readManifest(
  zip: JSZip,
  manifestPath: string,
): Promise<{ dir: string; json: unknown } | { error: string }> {
  const file = zip.file(manifestPath);
  if (!file) return { error: `manifest not found: ${manifestPath}` };
  const text = await file.async("text");
  try {
    const dir = manifestPath.includes("/")
      ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1)
      : "";
    return { dir, json: JSON.parse(text) };
  } catch {
    return { error: `invalid manifest JSON: ${manifestPath}` };
  }
}

interface ManifestCheck {
  /** manifest 声明但 zip 内不存在的文件。 */
  missing: string[];
  /** manifest Name 字段（作为模型显示名候选）。 */
  name?: string;
  /** 第一张纹理的 zip 内路径（卡片缩略图用）。 */
  texture?: string;
}

/** 校验 manifest 引用的文件在 zip 内全部存在。 */
export async function checkManifest(
  zip: JSZip,
  manifestPath: string,
): Promise<ManifestCheck | { error: string }> {
  const m = await readManifest(zip, manifestPath);
  if ("error" in m) return m;
  const namelist = new Set(
    Object.keys(zip.files).filter((p) => !zip.files[p].dir),
  );
  const textures = (
    m.json as { FileReferences?: { Textures?: string[] } }
  ).FileReferences?.Textures;
  return {
    missing: referencedFiles(m.dir, m.json).filter((p) => !namelist.has(p)),
    texture:
      typeof textures?.[0] === "string"
        ? resolvePath(m.dir, textures[0])
        : undefined,
    name:
      typeof (m.json as { Name?: unknown }).Name === "string"
        ? ((m.json as { Name: string }).Name ?? undefined)
        : undefined,
  };
}

/**
 * 给 ZipLoader 接上 jszip 实现（库内 stub 抛 Not implemented）。
 * mod 是 pixi-live2d-display/cubism4 的动态导入结果。
 * 幂等：只赋值一次。
 */
export function wireZipLoader(mod: Record<string, any>): void {
  const zl = mod.ZipLoader;
  if (!zl || zl.__momoWired) return;
  zl.zipReader = (data: Blob) => JSZip.loadAsync(data);
  zl.getFilePaths = (reader: JSZip) =>
    Promise.resolve(
      Object.keys(reader.files).filter((p) => !reader.files[p].dir),
    );
  zl.getFiles = async (reader: JSZip, paths: string[]) =>
    Promise.all(
      paths.map(async (p) => {
        const entry = reader.file(p);
        if (!entry) throw new Error(`zip entry missing: ${p}`);
        const blob = await entry.async("blob");
        return new File([blob], p);
      }),
    );
  zl.readText = (reader: JSZip, path: string) => {
    const entry = reader.file(path);
    if (!entry) return Promise.reject(new Error(`zip entry missing: ${path}`));
    return entry.async("text");
  };
  zl.__momoWired = true;
}

/**
 * 构造导入模型的 Live2DModel.from() 输入：[zipFile] 且携带
 * settings 覆盖——指定用户选定的 manifest（ZipLoader 默认取
 * namelist 里第一个 model3.json，多 manifest 包会选错）。
 */
export async function makeAvatarSource(
  mod: Record<string, any>,
  blob: Blob,
  meta: AvatarMeta,
): Promise<File[]> {
  const zip = await JSZip.loadAsync(blob);
  const text = await zip.file(meta.manifest)?.async("text");
  if (!text) throw new Error(`manifest missing in zip: ${meta.manifest}`);
  const json = JSON.parse(text);
  json.url = meta.manifest;
  const runtime = mod.Live2DFactory.findRuntime(json);
  if (!runtime) throw new Error("unsupported model (not Cubism 3/4)");
  const settings = runtime.createModelSettings(json);
  const file = new File([blob], meta.fileName, { type: "application/zip" });
  const source = [file] as File[] & { settings?: unknown };
  source.settings = settings;
  // uid 静态不自增：手动推进避免新旧模型 filesMap 键碰撞。
  mod.ZipLoader.uid = (mod.ZipLoader.uid ?? 0) + 1;
  return source;
}
