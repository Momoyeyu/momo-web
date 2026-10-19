// 「拓展」tab：左 Live2D 模型、右 MCP 拓展（搜索 + 加号 + 卡片 + 翻页），
// 以及 MCP 配置弹窗。这些原先都挤在 Settings.tsx 里，状态与辅助一并搬过来。
import { useEffect, useState, useSyncExternalStore } from "react";

import { useT } from "../../i18n";
import { CARD_PAGE_SIZE, clampPage } from "../../lib/paging";
import { getState, subscribe, update } from "../../lib/store";
import type { McpExtension } from "../../lib/types";
import { probeExtension } from "../../services/extClient";
import type { ExtProbeResult } from "../../services/extClient";
import Hint from "../../ui/Hint";
import IconButton from "../../ui/IconButton";
import Pager from "../../ui/Pager";
import Switch from "../../ui/Switch";
import AvatarPanel from "../panels/Avatar";
import ExtConfigModal from "./ExtConfigModal";

export default function ExtensionsTab() {
  const t = useT();
  const settings = useSyncExternalStore(subscribe, getState).settings;

  const [extEditing, setExtEditing] = useState<number | null>(null);
  const [extQuery, setExtQuery] = useState("");
  const [extPage, setExtPage] = useState(0);
  // 连接状态点：下标 → 探测结果（"running" = 进行中）。
  const [extProbes, setExtProbes] = useState<
    Record<number, ExtProbeResult | "running">
  >({});

  const patchExtensions = (list: McpExtension[]): void => {
    update({ settings: { ...settings, extensions: list } });
  };

  // 连接状态：清单变化时对 enabled 记录各探测一次，结果只影响状态点、失败不阻塞 UI。
  useEffect(() => {
    let alive = true;
    setExtProbes({});
    settings.extensions.forEach((ext, i) => {
      if (!ext.enabled) return;
      setExtProbes((p) => ({ ...p, [i]: "running" }));
      void probeExtension(ext).then((r) => {
        if (alive) setExtProbes((p) => ({ ...p, [i]: r }));
      });
    });
    return () => {
      alive = false;
    };
  }, [settings.extensions]);

  // 检索 + 分页（与 Live2D 面板同构：过滤命中集分页，索引映射回原清单）
  const extHits = settings.extensions
    .map((ext, i) => ({ ext, i }))
    .filter(({ ext }) =>
      (ext.name || "").toLowerCase().includes(extQuery.trim().toLowerCase()),
    );
  const extPg = clampPage(extPage, extHits.length, CARD_PAGE_SIZE);
  const extSlice = extHits.slice(
  extPg.page * CARD_PAGE_SIZE,
  (extPg.page + 1) * CARD_PAGE_SIZE,
  );

  const blankExt = (): McpExtension => ({
    name: "",
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: {},
    endpoint: "",
    headers: {},
  });

  const saveExt = (ext: McpExtension): void => {
    if (extEditing === null) return;
    const list = [...settings.extensions];
    if (extEditing >= 0) list[extEditing] = ext;
    else list.push(ext);
    patchExtensions(list);
    setExtEditing(null);
  };

  /** JSON 多条导入：逐条追加进列表（弹窗内草稿随之丢弃）。 */
  const importExts = (exts: McpExtension[]): void => {
    patchExtensions([...settings.extensions, ...exts]);
    setExtEditing(null);
  };

  /** 行内状态点：未启用灰点 / 探测中 / ●成功(n tools) / ✗失败。 */
  const extDot = (i: number, ext: McpExtension): React.ReactNode => {
    if (!ext.enabled) {
      return (
        <span className="ext-dot off" title={t("settings.extStOff")}>
          ○
        </span>
      );
    }
    const r = extProbes[i];
    if (!r || r === "running") {
      return (
        <span className="ext-dot wait" title={t("settings.extStRun")}>
          …
        </span>
      );
    }
    if (r.ok) {
      const label = t("settings.extStOk", { n: String(r.tools) });
      return (
        <span className="ext-dot ok" title={label}>
          ● {label}
        </span>
      );
    }
    return (
      <span
        className="ext-dot err"
        title={r.error || t("settings.extStFail")}
      >
        ✗ {t("settings.extStFail")}
      </span>
    );
  };

  return (
    <>
      {/* 双栏：左 Live2D（原「形象」tab 唯一剩下的配置）、右 MCP 拓展 */}
      <div className="settings-cols">
        <section className="panel panel-stack">
          <h3 className="opt-group">
            {t("settings.groups.avatar")}
            <span className="req">*</span>
          </h3>
          <AvatarPanel />
        </section>
        <section className="panel panel-stack settings-col ext-panel">
          <div className="panel-title-row">
            <h3 className="opt-group">{t("settings.groups.extensions")}</h3>
            <Hint text={t("settings.extHint")} side="down" />
          </div>
          <div className="list-toolbar">
            <input
              className="list-search"
              placeholder={t("settings.extSearchPh")}
              value={extQuery}
              onChange={(e) => {
                setExtQuery(e.target.value);
                setExtPage(0);
              }}
            />
            <IconButton
              icon="plus"
              label={t("settings.extAdd")}
              tip={t("settings.extAdd")}
              onClick={() => setExtEditing(-1)}
            />
          </div>
          <div className="list-body">
            {extSlice.length === 0 && (
              <p className="muted">{t("settings.extEmpty")}</p>
            )}
            {extSlice.map(({ ext, i }) => (
              <div className="list-item ext-row" key={i}>
                <span className="ext-name">
                  {ext.name || t("settings.extUnnamed")}
                </span>
                <span className="ext-badge">{ext.transport}</span>
                <Switch
                  on={ext.enabled}
                  onChange={(v) =>
                    patchExtensions(
                      settings.extensions.map((x, j) =>
                        j === i ? { ...x, enabled: v } : x,
                      ),
                    )
                  }
                />
                {extDot(i, ext)}
                <IconButton
                  icon="edit"
                  size="sm"
                  label={t("common.edit")}
                  tip={t("common.edit")}
                  onClick={() => setExtEditing(i)}
                />
                <IconButton
                  icon="trash"
                  size="sm"
                  danger
                  label={t("common.del")}
                  tip={t("common.del")}
                  onClick={() =>
                    patchExtensions(
                      settings.extensions.filter((_, j) => j !== i),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <div className="col-foot">
            <div className="list-foot">
              <Pager page={extPg.page} pages={extPg.pages} onChange={setExtPage} />
            </div>
          </div>
        </section>
      </div>
      {/* 拓展配置弹窗：背景变暗，点背景/取消丢弃未保存内容 */}
      {extEditing !== null && (
        <ExtConfigModal
          initial={
            extEditing >= 0 ? settings.extensions[extEditing] : blankExt()
          }
          onSave={saveExt}
          onImport={importExts}
          onClose={() => setExtEditing(null)}
        />
      )}
    </>
  );
}
