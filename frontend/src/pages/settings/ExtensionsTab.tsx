// Live2D、MCP 与官方插件各自使用完整宽度；二级滑块与内容同步横移。
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

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
import OfficialPlugins from "./OfficialPlugins";

const SECTIONS = ["avatar", "mcp", "plugins"] as const;
type ExtensionSection = (typeof SECTIONS)[number];

export default function ExtensionsTab({ active = true }: { active?: boolean }) {
  const t = useT();
  const settings = useSyncExternalStore(subscribe, getState).settings;
  const [section, setSection] = useState<ExtensionSection>("avatar");
  const sectionButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const sectionIndex = SECTIONS.indexOf(section);
  const navigateSection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % SECTIONS.length;
    else if (event.key === "ArrowLeft") next = (index + SECTIONS.length - 1) % SECTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    else return;
    event.preventDefault();
    setSection(SECTIONS[next]!);
    sectionButtons.current[next]?.focus();
  };

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
    if (!active || section !== "mcp") return;
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
  }, [active, section, settings.extensions]);

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
    <div className="extension-settings">
      <nav className="extension-tabs" role="tablist" aria-label={t("settings.extensionTabsLabel")}>
        <span className="extension-tab-thumb" aria-hidden="true" style={{ transform: `translateX(${sectionIndex * 100}%)` }} />
        {SECTIONS.map((id, index) => <button
          key={id}
          type="button"
          ref={element => { sectionButtons.current[index] = element; }}
          id={`extension-tab-${id}`}
          role="tab"
          aria-selected={section === id}
          aria-controls={`extension-panel-${id}`}
          tabIndex={section === id ? 0 : -1}
          className={section === id ? "active" : ""}
          onClick={() => setSection(id)}
          onKeyDown={event => navigateSection(event, index)}
        >{t(`settings.extensionTabs.${id}`)}</button>)}
      </nav>
      <div className="extension-viewport">
        <div className="extension-track" style={{ transform: `translateX(${-sectionIndex * 100}%)` }}>
          <section className="extension-pane" id="extension-panel-avatar" role="tabpanel" aria-labelledby="extension-tab-avatar" aria-hidden={section !== "avatar"} inert={!active || section !== "avatar"}>
        <section className="panel panel-stack extension-panel">
          <h3 className="opt-group">
            {t("settings.groups.avatar")}
            <span className="req">*</span>
          </h3>
          <AvatarPanel />
        </section>
          </section>
          <section className="extension-pane" id="extension-panel-mcp" role="tabpanel" aria-labelledby="extension-tab-mcp" aria-hidden={section !== "mcp"} inert={!active || section !== "mcp"}>
        <section className="panel panel-stack settings-col ext-panel extension-panel">
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
          </section>
          <section className="extension-pane" id="extension-panel-plugins" role="tabpanel" aria-labelledby="extension-tab-plugins" aria-hidden={section !== "plugins"} inert={!active || section !== "plugins"}>
            <OfficialPlugins active={active && section === "plugins"} />
          </section>
        </div>
      </div>
      {/* 拓展配置弹窗：背景变暗，点背景/取消丢弃未保存内容 */}
      {active && section === "mcp" && extEditing !== null && (
        <ExtConfigModal
          initial={
            extEditing >= 0 ? settings.extensions[extEditing] : blankExt()
          }
          onSave={saveExt}
          onImport={importExts}
          onClose={() => setExtEditing(null)}
        />
      )}
    </div>
  );
}
