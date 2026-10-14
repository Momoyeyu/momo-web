// 形象面板（设置页「模型」内分块）：Live2D 模型导入/切换/删除。
// 与记忆条目同级——导入/切换/删除是即时操作，不走设置草稿。
// zip 本体与纹理缩略图存 IndexedDB，元信息进 PersistedState；
// 加载失败回退内置模型，不阻断聊天。

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import JSZip from "jszip";
import {
  AVATAR_BUILTIN,
  getAvatarId,
  getAvatars,
  newId,
  subscribe,
  update,
} from "../lib/store";
import type { AvatarMeta } from "../lib/types";
import { deleteBlob, getBlob, putBlob } from "../lib/idb";
import { checkManifest, listManifests } from "../live2d/avatarZip";
import { getStage } from "../live2d/stage";
import { useT } from "../i18n";
import Select from "../ui/Select";

const BUILTIN_NAME = "Hiyori";
/** 内置模型的缩略图（静态资源直出）。 */
const BUILTIN_THUMB = "/live2d/hiyori/Hiyori.2048/texture_00.png";

function reloadStage(): void {
  void getStage().loadAvatar().catch(() => {});
}

function fmtSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 缩略图 objectURL 缓存（模块级，跨渲染复用）。
const thumbCache = new Map<string, Promise<string | null>>();

/** 取缩略图：优先 IDB 里存好的；老数据缺图则从 zip 里按
 * manifest 第一张纹理现抽并落库（懒回填）。 */
function thumbUrl(meta: AvatarMeta): Promise<string | null> {
  let p = thumbCache.get(meta.id);
  if (!p) {
    p = getBlob(`${meta.id}:thumb`).then(async (b) => {
      if (!b) {
        const zip = await getBlob(meta.id);
        if (!zip) return null;
        const z = await JSZip.loadAsync(zip);
        const check = await checkManifest(z, meta.manifest);
        if ("error" in check || !check.texture) return null;
        const tex = z.file(check.texture);
        if (!tex) return null;
        b = await tex.async("blob");
        void putBlob(`${meta.id}:thumb`, b);
      }
      return URL.createObjectURL(b);
    });
    thumbCache.set(meta.id, p);
  }
  return p;
}

/** 导入模型缩略图：IDB 里的纹理 blob → objectURL。 */
function AvatarThumb({ meta }: { meta: AvatarMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void thumbUrl(meta).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [meta]);
  return url ? (
    <img className="avatar-thumb" src={url} alt="" draggable={false} />
  ) : (
    <div className="avatar-thumb avatar-thumb-empty" />
  );
}

export default function AvatarPanel() {
  const t = useT();
  const avatars = useSyncExternalStore(subscribe, getAvatars);
  const activeId = useSyncExternalStore(subscribe, getAvatarId);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 多 manifest zip 待确认导入
  const [pending, setPending] = useState<{
    zip: JSZip;
    file: File;
    manifests: string[];
  } | null>(null);
  const [manifest, setManifest] = useState("");

  const activate = (id: string): void => {
    if (id === activeId) return;
    update({ avatarId: id });
    reloadStage();
  };

  const doImport = async (
    zip: JSZip,
    file: File,
    manifestPath: string,
  ): Promise<void> => {
    const check = await checkManifest(zip, manifestPath);
    if ("error" in check) {
      setError(t("avatar.errManifest"));
      return;
    }
    if (check.missing.length > 0) {
      setError(
        `${t("avatar.errMissing")}：${check.missing.slice(0, 5).join("、")}${check.missing.length > 5 ? "…" : ""}`,
      );
      return;
    }
    const meta: AvatarMeta = {
      id: newId("av"),
      name: check.name?.trim() || file.name.replace(/\.zip$/i, ""),
      fileName: file.name,
      manifest: manifestPath,
      size: file.size,
      addedAt: new Date().toISOString(),
    };
    try {
      await putBlob(meta.id, file);
      // 缩略图：manifest 的第一张纹理（失败不阻断导入）。
      if (check.texture) {
        const tex = zip.file(check.texture);
        if (tex) await putBlob(`${meta.id}:thumb`, await tex.async("blob"));
      }
    } catch {
      setError(t("avatar.errStore"));
      return;
    }
    update({
      avatars: [...getAvatars(), meta],
      avatarId: meta.id,
    });
    setPending(null);
    setError(null);
    reloadStage();
  };

  const onPick = async (file: File | undefined): Promise<void> => {
    setError(null);
    setPending(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError(t("avatar.errZip"));
      return;
    }
    setBusy(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const manifests = listManifests(zip);
      if (manifests.length === 0) {
        setError(t("avatar.errNoManifest"));
        return;
      }
      if (manifests.length === 1) {
        await doImport(zip, file, manifests[0]);
      } else {
        setPending({ zip, file, manifests });
        setManifest(manifests[0]);
      }
    } catch {
      setError(t("avatar.errZip"));
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string): void => {
    update({
      avatars: getAvatars().filter((a) => a.id !== id),
      ...(activeId === id ? { avatarId: AVATAR_BUILTIN } : {}),
    });
    void thumbCache.get(id)?.then((u) => u && URL.revokeObjectURL(u));
    thumbCache.delete(id);
    void deleteBlob(id);
    void deleteBlob(`${id}:thumb`);
    if (activeId === id) reloadStage();
  };

  const cardOps = (id: string): React.ReactNode => (
    <span className="avatar-ops">
      {activeId !== id && (
        <button className="ghost" onClick={() => activate(id)}>
          {t("avatar.use")}
        </button>
      )}
      {id !== AVATAR_BUILTIN && (
        <button className="ghost danger" onClick={() => remove(id)}>
          {t("avatar.delete")}
        </button>
      )}
    </span>
  );

  return (
    <div className="avatar-panel">
      <div className="avatar-grid">
        {/* 内置模型 */}
        <div
          className={`avatar-card${activeId === AVATAR_BUILTIN ? " active" : ""}`}
        >
          <img
            className="avatar-thumb"
            src={BUILTIN_THUMB}
            alt=""
            draggable={false}
          />
          <div className="avatar-info">
            <div className="avatar-title">
              <span className="avatar-name">{BUILTIN_NAME}</span>
              <span className="badge">{t("avatar.builtin")}</span>
            </div>
            <div className="avatar-meta muted">Hiyori.model3.json</div>
          </div>
          {activeId === AVATAR_BUILTIN ? (
            <span className="badge badge-active">{t("avatar.inUse")}</span>
          ) : (
            cardOps(AVATAR_BUILTIN)
          )}
        </div>

        {/* 导入模型 */}
        {avatars.map((a) => (
          <div
            key={a.id}
            className={`avatar-card${activeId === a.id ? " active" : ""}`}
          >
            <AvatarThumb meta={a} />
            <div className="avatar-info">
              <div className="avatar-title">
                <span className="avatar-name">{a.name}</span>
              </div>
              <div className="avatar-meta muted">
                {a.manifest} · {fmtSize(a.size)}
              </div>
            </div>
            {activeId === a.id ? (
              <span className="badge badge-active">{t("avatar.inUse")}</span>
            ) : (
              cardOps(a.id)
            )}
          </div>
        ))}

        {/* 导入入口卡片 */}
        <button
          type="button"
          className="avatar-card avatar-add"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <span className="avatar-add-plus">＋</span>
          <span className="avatar-add-label">
            {busy ? t("avatar.importing") : t("avatar.importBtn")}
          </span>
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          void onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {/* 多 manifest 选择 */}
      {pending && (
        <div className="avatar-pending panel">
          <span className="muted">{t("avatar.pickManifest")}</span>
          <Select
            value={manifest}
            options={pending.manifests.map((m) => ({ value: m, label: m }))}
            onChange={setManifest}
          />
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void doImport(pending.zip, pending.file, manifest).finally(() =>
                setBusy(false),
              );
            }}
          >
            {t("avatar.confirmImport")}
          </button>
        </div>
      )}

      <p className="muted avatar-hint">{t("avatar.importHint")}</p>
      {error && <p className="avatar-error">{error}</p>}
    </div>
  );
}
