// MCP connections use a single registry, regardless of transport.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useT } from "../../i18n";
import { MCP_PAGE_SIZE, clampPage } from "../../lib/paging";
import { getState, subscribe, update } from "../../lib/store";
import type { McpExtension } from "../../lib/types";
import { probeExtension } from "../../services/extClient";
import type { ExtProbeResult } from "../../services/extClient";
import Hint from "../../ui/Hint";
import IconButton from "../../ui/IconButton";
import Pager from "../../ui/Pager";
import Switch from "../../ui/Switch";
import ExtConfigModal from "./ExtConfigModal";

export default function McpSettings() {
  const t = useT();
  const settings = useSyncExternalStore(subscribe, getState).settings;
  const panel = useRef<HTMLDivElement>(null);
  const [viewed, setViewed] = useState(false);
  const [extEditing, setExtEditing] = useState<number | null>(null);
  const [extQuery, setExtQuery] = useState("");
  const [extPage, setExtPage] = useState(0);
  // 连接状态点：下标 → 探测结果（"running" = 进行中）。
  const [extProbes, setExtProbes] = useState<
    Record<number, ExtProbeResult | "running">
  >({});

  const patchExtensions = (list: McpExtension[]): void => {
    update({ settings: { ...getState().settings, extensions: list } });
  };

  useEffect(() => {
    if (!panel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setViewed(true);
      observer.disconnect();
    });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, []);

  // 连接状态：清单变化时对 enabled 记录各探测一次，结果只影响状态点、失败不阻塞 UI。
  useEffect(() => {
    if (!viewed) return;
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
  }, [settings.extensions, viewed]);

  // 检索 + 分页（与 Live2D 面板同构：过滤命中集分页，索引映射回原清单）
  const extHits = settings.extensions
    .map((ext, i) => ({ ext, i }))
    .filter(({ ext }) =>
      (ext.name || "").toLowerCase().includes(extQuery.trim().toLowerCase()),
    );
  const extPg = clampPage(extPage, extHits.length, MCP_PAGE_SIZE);
  const extSlice = extHits.slice(
    extPg.page * MCP_PAGE_SIZE,
    (extPg.page + 1) * MCP_PAGE_SIZE,
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

  function statusLabel(i: number, ext: McpExtension) {
    const probe = extProbes[i];
    if (!ext.enabled) return t("settings.extStOff");
    if (!probe || probe === "running") return t("settings.extStRun");
    return probe.ok ? t("settings.extStOk", { n: String(probe.tools) })
      : probe.error || t("settings.extStFail");
  }

  return (
    <div className="extension-settings" ref={panel}>
      <section className="ext-panel mcp-section">
        <header className="mcp-heading">
          <h3>{t("settings.extConnections")}</h3>
          <Hint text={t("settings.extHint")} side="down" />
          <input className="list-search" type="search" aria-label={t("settings.extSearchPh")}
            placeholder={t("settings.extSearchPh")} value={extQuery}
            onChange={e => { setExtQuery(e.target.value); setExtPage(0); }} />
          <IconButton icon="plus" label={t("settings.extAdd")} onClick={() => setExtEditing(-1)} />
        </header>
        <div className="list-body mcp-items">
          {!extSlice.length && <p className="muted">{t("settings.extEmpty")}</p>}
          {extSlice.map(({ ext, i }) => (
            <div className="mcp-row ext-row" key={i}>
              <strong className="ext-name" title={statusLabel(i, ext)}>{ext.name || t("settings.extUnnamed")}</strong>
              <Switch title={ext.name || t("settings.extUnnamed")} on={ext.enabled}
                onChange={enabled => patchExtensions(settings.extensions.map((item, index) =>
                  index === i ? { ...item, enabled } : item))} />
              <IconButton icon="edit" size="sm" label={t("common.edit")} tip={t("common.edit")}
                onClick={() => setExtEditing(i)} />
            </div>
          ))}
        </div>
        {extPg.pages > 1 && <Pager page={extPg.page} pages={extPg.pages} onChange={setExtPage} />}
      </section>
      {extEditing !== null && (
        <ExtConfigModal
          initial={
            extEditing >= 0 ? settings.extensions[extEditing] : blankExt()
          }
          status={extEditing >= 0 ? statusLabel(extEditing, settings.extensions[extEditing]) : undefined}
          onRemove={extEditing >= 0 ? () => {
            patchExtensions(settings.extensions.filter((_, index) => index !== extEditing));
            setExtEditing(null);
          } : undefined}
          onSave={saveExt}
          onImport={importExts}
          onClose={() => setExtEditing(null)}
        />
      )}
    </div>
  );
}
