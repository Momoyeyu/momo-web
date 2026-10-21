import { reconcileResources } from "../../live2d/controlCatalog";
// 形象面板（「拓展」tab 左栏）：Live2D 模型导入/切换/删除。
//
// 形态与 MCP 面板同一套：检索框 + 右侧加号 → 卡片列表 → 底部翻页器；
// 两个动作各自走弹窗，列表本身保持紧凑：
//   - 加号 → 导入弹窗（选 zip、多 manifest 时选入口）
//   - 点卡片 → 该模型的「表情与动作」弹窗（描述供 momo 理解何时使用）
//
// zip 本体与纹理缩略图存 IndexedDB，元信息进 PersistedState；
// 加载失败回退内置模型，不阻断聊天。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import JSZip from "jszip";
import {
  AVATAR_BUILTIN,
  getAvatarId,
  getAvatars,
  newId,
  subscribe,
  update,
} from "../../lib/store";
import type { AvatarMeta, AvatarResources } from "../../lib/types";
import { CARD_PAGE_SIZE, clampPage } from "../../lib/paging";
import { deleteBlob, getBlob, putBlob } from "../../lib/idb";
import { checkManifest, listManifests } from "../../live2d/avatarZip";
import { getStage } from "../../live2d/stage";
import { useT } from "../../i18n";
import Button from "../../ui/Button";
import IconButton from "../../ui/IconButton";
import Modal from "../../ui/Modal";
import Pager from "../../ui/Pager";
import Select from "../../ui/Select";
import Checkbox from "../../ui/Checkbox";
import ResourcePreview, { type ResourceSelection } from "../../components/ResourcePreview";
import type { PresentationSnapshot } from "../../live2d/performanceTypes";
import "../../styles/persona.css";
import "../../styles/controls.css";

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
  // 两个弹窗：导入 / 表情与动作（后者记录目标模型 id）
  const [importOpen, setImportOpen] = useState(false);
  const [resId, setResId] = useState<string | null>(null);
  const [resKind, setResKind] = useState<keyof AvatarResources>("expressions");
  const [previewCatalog, setPreviewCatalog] = useState<PresentationSnapshot | null>(null);
  const onPreviewReady = useCallback((snapshot: PresentationSnapshot | null) => {
    setPreviewCatalog(snapshot);
    const catalog = getStage().getResourceCatalog();
    if (!snapshot || !catalog) return;
    const avatar = getAvatars().find(a => a.id === snapshot.avatarId);
    if (!avatar) return;
    const resources = reconcileResources(catalog, avatar.resources);
    if (JSON.stringify(resources) !== JSON.stringify(avatar.resources)) {
      update({ avatars: getAvatars().map(a => a.id === avatar.id ? { ...a, resources } : a) });
    }
  }, []);
  const [selection, setSelection] = useState<ResourceSelection | null>(null);
  useEffect(() => { setSelection(null); setPreviewCatalog(null); }, [resId]);
  /** 拖放区高亮（拖入中）。 */
  const [dragging, setDragging] = useState(false);

  // 列表检索 + 分页（与 MCP 面板同一套）
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const hits = avatars.filter((a) => {
    const q = query.trim().toLowerCase();
    return !q || `${a.name} ${a.manifest}`.toLowerCase().includes(q);
  });
  const pg = clampPage(page, hits.length, CARD_PAGE_SIZE);
  const slice = hits.slice(
    pg.page * CARD_PAGE_SIZE,
    (pg.page + 1) * CARD_PAGE_SIZE,
  );
  const resAvatar = resId ? (avatars.find((a) => a.id === resId) ?? null) : null;

  const activate = (id: string): void => {
    if (id === activeId) return;
    update({ avatarId: id });
    reloadStage();
  };

  /** 旧数据懒回填：导入模型还没解析过 resources 时，从 IndexedDB 的 zip
   * 里读 manifest 补清单（desc 留空）。当前形象与弹窗打开的那个都走这里。 */
  const backfillResources = (id: string): void => {
    const a = getAvatars().find((x) => x.id === id);
    if (!a || a.builtin || a.resources) return;
    void (async () => {
      const blob = await getBlob(a.id);
      if (!blob) return;
      const zip = await JSZip.loadAsync(blob);
      const check = await checkManifest(zip, a.manifest);
      if ("error" in check) return;
      update({
        avatars: getAvatars().map((x) =>
          x.id === a.id
            ? {
                ...x,
                resources: {
                  expressions: check.resources.expressions.map((name) => ({
                    name,
                    desc: "",
                  })),
                  motions: check.resources.motions.map((name) => ({
                    name,
                    desc: "",
                  })),
                },
              }
            : x,
        ),
      });
    })();
  };

  useEffect(() => {
    backfillResources(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    if (resId) backfillResources(resId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resId]);

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
      // 导入即解析资源清单；desc 留空待用户在「表情与动作」弹窗里编辑。
      resources: {
        expressions: check.resources.expressions.map((name) => ({
          name,
          desc: "",
        })),
        motions: check.resources.motions.map((name) => ({ name, desc: "" })),
      },
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
    setImportOpen(false);
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
    if (resId === id) setResId(null);
  };

  const setResourceField = (
    avatarId: string,
    kind: keyof AvatarResources,
    name: string,
    field: "label" | "desc" | "context",
    value: string,
  ): void => {
    update({
      avatars: getAvatars().map((a) =>
        a.id === avatarId && a.resources
          ? {
              ...a,
              resources: {
                ...a.resources,
                [kind]: a.resources[kind].map((r) =>
                  r.name === name ? { ...r, [field]: value } : r,
                ),
              },
            }
          : a,
      ),
    });
  };

  const resGroup = (
    avatar: AvatarMeta,
    kind: keyof AvatarResources,
    label: string,
  ): React.ReactNode => {
    const items = avatar.resources?.[kind] ?? [];
    if (!items.length) return null;
    return (
      <div className="avatar-res-group">
        <div className="avatar-res-group-title muted">{label}</div>
        {items.map((r) => (
          <div key={r.name} data-resource-id={r.name} className={`avatar-res-row${selection?.kind === kind && selection.name === r.name ? " is-selected" : ""}`}>
            <Checkbox checked={r.enabled !== false} aria-label={`${r.label || r.name} · ${t("performance.enabled")}`}
              onChange={(e) => update({ avatars: getAvatars().map((a) => a.id === avatar.id && a.resources ? {
                ...a, resources: { ...a.resources, [kind]: a.resources[kind].map((item) => item.name === r.name ? { ...item, enabled: e.target.checked } : item) }
              } : a) })} />
            <span className="avatar-res-name">{r.label || r.name.split('/').pop()}
              <small>{r.name.split('/').pop()}{previewCatalog?.[kind].find(item => item.name === r.name)?.duration ? ` · ${previewCatalog[kind].find(item => item.name === r.name)!.duration!.toFixed(2)}s` : ''}</small>
            </span>
            <div className="resource-fields">
              {(["label", "desc", "context"] as const).map(field => <label key={field}>
                <span>{t(`performance.${field}`)}</span>
                <input aria-label={`${r.name} · ${t(`performance.${field}`)}`} maxLength={field === "label" ? 80 : 500}
                  value={r[field] ?? ""} placeholder={t(`performance.${field}`)}
                  onChange={e => setResourceField(avatar.id, kind, r.name, field, e.target.value)} />
              </label>)}
            </div>
            <IconButton
              icon="play"
              className="resource-play"
              size="sm"
              label={t("performance.previewItem", { name: r.label || r.name })}
              disabled={previewCatalog?.avatarId !== avatar.id || !previewCatalog[kind].some(item => item.name === r.name)}
              active={selection?.kind === kind && selection.name === r.name}
              onClick={() => setSelection(previous => ({ kind, name: r.name, request: (previous?.request ?? 0) + 1 }))}
            />
          </div>
        ))}
      </div>
    );
  };

  const hasRes = (avatar: AvatarMeta): boolean =>
    !!avatar.resources &&
    (avatar.resources.expressions.length > 0 ||
      avatar.resources.motions.length > 0);

  const closeImport = (): void => {
    setImportOpen(false);
    setPending(null);
    setError(null);
  };

  return (
    <>
      <div className="list-toolbar">
        <input
          className="list-search"
          placeholder={t("avatar.searchPh")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <IconButton
          icon="plus"
          label={t("avatar.importLabel")}
          onClick={() => {
            setError(null);
            setPending(null);
            setImportOpen(true);
          }}
        />
      </div>

      <div className="list-body">
        {slice.map((a) => (
          <div
            key={a.id}
            className={`list-item list-open${
              a.id === activeId ? " avatar-current" : ""
            }`}
            onClick={() => setResId(a.id)}
          >
            <div className="list-content avatar-row">
              {a.builtin ? (
                <img
                  className="avatar-thumb"
                  src={BUILTIN_THUMB}
                  alt=""
                  draggable={false}
                />
              ) : (
                <AvatarThumb meta={a} />
              )}
              <div className="avatar-info">
                <div className="avatar-title">
                  <span className="avatar-name">{a.name || BUILTIN_NAME}</span>
                  {a.builtin && (
                    <span className="badge">{t("avatar.builtin")}</span>
                  )}
                  {a.id === activeId && (
                    <span className="badge badge-active">
                      {t("avatar.inUse")}
                    </span>
                  )}
                </div>
                <div className="avatar-meta muted">
                  {a.manifest}
                  {a.builtin ? "" : ` · ${fmtSize(a.size)}`}
                </div>
              </div>
            </div>
            <div className="list-ops">
{/* 「使用」常驻并按激活态点亮：按钮消失会让后面的删除钮左移 */}
              <IconButton
                icon="check"
                size="sm"
                label={t("avatar.use")}
                tip={t("avatar.use")}
                active={a.id === activeId}
                onClick={(e) => {
                  e.stopPropagation();
                  activate(a.id);
                }}
              />
              {!a.builtin && (
                <IconButton
                  icon="trash"
                  size="sm"
                  danger
                  label={t("avatar.delete")}
                  tip={t("avatar.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(a.id);
                  }}
                />
              )}
            </div>
          </div>
        ))}
        {hits.length === 0 && <p className="muted">{t("avatar.empty")}</p>}
      </div>

      <div className="col-foot">
        <div className="list-foot">
          <Pager page={pg.page} pages={pg.pages} onChange={setPage} />
        </div>
      </div>

      {/* 导入走弹窗：加号不再是列表里的一格 */}
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
      {importOpen && (
        <Modal onClose={closeImport}>
          <div className="modal-meta muted">{t("avatar.importBtn")}</div>
          <p className="muted avatar-hint">{t("avatar.importHint")}</p>
          {pending && (
            <div className="avatar-pending">
              <span className="muted">{t("avatar.pickManifest")}</span>
              <Select
                value={manifest}
                options={pending.manifests.map((m) => ({
                  value: m,
                  label: m,
                }))}
                onChange={setManifest}
              />
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void doImport(pending.zip, pending.file, manifest).finally(
                    () => setBusy(false),
                  );
                }}
              >
                {t("avatar.confirmImport")}
              </Button>
            </div>
          )}
          {error && <p className="avatar-error">{error}</p>}
          {/* 拖放区：拖入 zip 或点击选文件（原来那格虚线「导入模型」的观感） */}
          <div
            className={`avatar-drop${dragging ? " dragging" : ""}`}
            onClick={() => {
              if (!busy) fileRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void onPick(e.dataTransfer.files?.[0]);
            }}
          >
            <span className="avatar-drop-plus">＋</span>
            <span className="avatar-drop-label">
              {busy ? t("avatar.importing") : t("avatar.dropHint")}
            </span>
          </div>
          <div className="modal-foot">
            <Button variant="ghost" onClick={closeImport}>
              {t("common.cancel")}
            </Button>
          </div>
        </Modal>
      )}

      {/* 表情与动作：点卡片才弹，描述写回该模型 */}
      {resAvatar && (
        <Modal
          className="avatar-res-modal"
          label={`${t("avatar.resources")} · ${resAvatar.name || BUILTIN_NAME}`}
          onClose={() => setResId(null)}
        >
          <h2 className="modal-meta">
            {t("avatar.resources")} · {resAvatar.name || BUILTIN_NAME}
          </h2>
          <p className="muted avatar-hint">{t("avatar.resHint")}</p>
          <div className="resource-layout">
          <section className="resource-editor">
          {hasRes(resAvatar) ? (
            <>
              <div className="resource-sections" role="group" aria-label={t("avatar.resources")}>
                {(["expressions", "motions"] as const).map((kind) => <Button variant="ghost" key={kind} aria-pressed={resKind === kind} onClick={() => setResKind(kind)}>
                  {t(kind === "expressions" ? "avatar.expList" : "avatar.motionList")}
                  <span>{resAvatar.resources?.[kind].length ?? 0}</span>
                </Button>)}
              </div>
              <div className="avatar-res-scroll">
                {resGroup(resAvatar, resKind, t(resKind === "expressions" ? "avatar.expList" : "avatar.motionList"))}
              </div>
            </>
          ) : (
            <p className="muted">{t("avatar.resEmpty")}</p>
          )}
          </section>
          <ResourcePreview key={resAvatar.id} avatarId={resAvatar.id} selection={selection} onReady={onPreviewReady} />
          </div>
          <div className="modal-foot">
            <Button onClick={() => setResId(null)}>{t("common.close")}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
