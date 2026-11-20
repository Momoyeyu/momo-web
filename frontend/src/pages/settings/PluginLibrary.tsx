import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { clampPage, MCP_PAGE_SIZE } from "../../lib/paging";
import { apiJson, jsonInit } from "../../services/http";
import Button from "../../ui/Button";
import Hint from "../../ui/Hint";
import IconButton from "../../ui/IconButton";
import Modal from "../../ui/Modal";
import Pager from "../../ui/Pager";
import Switch from "../../ui/Switch";
import "../../styles/plugin-library.css";

interface Installed {
  manifest: { id: string; name: string; description: string; version: string; capabilities: string[] };
  enabled: boolean;
  runtimeStatus?: string;
}
type Dialog = { kind: "add" } | { kind: "review" | "remove"; id: string };
const endpoint = "/api/extensions/plugins";

export default function PluginLibrary({ active }: { active: boolean }) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const [plugins, setPlugins] = useState<Installed[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void apiJson<{plugins: Installed[]}>(endpoint, {signal: controller.signal})
      .then(result => {
        if (!controller.signal.aborted) { setPlugins(result.plugins); setLoaded(true); }
      }).catch(() => { if (!controller.signal.aborted) setError("plugins.error"); });
    return () => controller.abort();
  }, [active]);

  const refresh = async () => {
    const result = await apiJson<{plugins: Installed[]}>(endpoint);
    setPlugins(result.plugins);
    setLoaded(true);
  };

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      setDialog(null);
    } catch {
      setError("plugins.error");
      try { await refresh(); } catch { /* Keep the action error visible. */ }
    } finally {
      setBusy(false);
    }
  }

  function open(next: Dialog) {
    setError("");
    setDialog(next);
  }
  function importFile(selected: File) {
    if (selected.size > 2 * 1024 * 1024) { setError("plugins.fileLarge"); return; }
    void run(async () => apiJson(endpoint, jsonInit("POST", JSON.parse(await selected.text()))));
  }
  function changeEnabled(plugin: Installed, enabled: boolean) {
    // Trust acceptance is sent only by the confirmation inside the details dialog.
    const patch = enabled ? { enabled, trustAccepted: true } : { enabled };
    void run(() => apiJson(endpoint + "/" + encodeURIComponent(plugin.manifest.id), jsonInit("PATCH", patch)));
  }

  const needle = query.trim().toLocaleLowerCase();
  const matches = plugins.filter(({manifest}) =>
    (manifest.name + " " + manifest.id).toLocaleLowerCase().includes(needle));
  const paging = clampPage(page, matches.length, MCP_PAGE_SIZE);
  const shown = matches.slice(paging.page * MCP_PAGE_SIZE, (paging.page + 1) * MCP_PAGE_SIZE);
  const selected = dialog && dialog.kind !== "add" ? plugins.find(p => p.manifest.id === dialog.id) : undefined;
  const close = () => { if (!busy) setDialog(null); };
  const alert = error && <p role="alert">{t(error)}</p>;

  return <section className="plugin-library mcp-section">
    <header className="mcp-heading">
      <h3>{t("settings.extLocalTools")}</h3>
      <Hint text={t("plugins.importHint")} side="down" />
      <IconButton icon="plus" label={t("settings.extAddLocal")} disabled={busy} onClick={() => open({kind:"add"})} />
    </header>
    <input className="list-search" type="search" aria-label={t("plugins.search")} placeholder={t("plugins.search")}
      value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} />
    {!dialog && alert}
    {!loaded && !error && <p role="status">{t("plugins.loading")}</p>}
    <div className="mcp-items">
      {shown.map(item => <div className="mcp-row" key={item.manifest.id}>
        <strong className="ext-name" title={item.manifest.name}>{item.manifest.name}</strong>
        <Switch title={item.manifest.name} on={item.enabled} disabled={busy || item.runtimeStatus === "stop-unconfirmed"}
          onChange={enabled => enabled ? open({kind:"review", id:item.manifest.id}) : changeEnabled(item, false)} />
        <IconButton icon="edit" size="sm" label={t("plugins.details")} tip={t("plugins.details")}
          disabled={busy} onClick={() => open({kind:"review", id:item.manifest.id})} />
        {item.runtimeStatus === "stop-unconfirmed" && <small role="alert">{t("plugins.stopUnknown")}</small>}
      </div>)}
      {loaded && !matches.length && <p className="muted">{t("plugins.empty")}</p>}
    </div>
    {paging.pages > 1 && <Pager page={paging.page} pages={paging.pages} onChange={setPage} />}
    {active && dialog?.kind === "add" &&
      <Modal className="extension-modal" label={t("settings.extAddLocal")} onClose={close}>
        <h3>{t("settings.extAddLocal")}</h3><p>{t("plugins.importHint")}</p>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => {
          const selectedFile = e.target.files?.[0];
          e.target.value = "";
          if (selectedFile) importFile(selectedFile);
        }} />
        {alert}
        <div className="plugin-library-actions">
          <Button disabled={busy} variant="ghost" onClick={close}>{t("plugins.cancel")}</Button>
          <Button disabled={busy} onClick={() => file.current?.click()}>{t("plugins.importFile")}</Button>
        </div>
      </Modal>}
    {active && selected && dialog?.kind === "review" &&
      <Modal className="extension-modal" label={t("plugins.details")} onClose={close}>
        <h3>{selected.manifest.name}</h3><span className="muted">{selected.manifest.version}</span>
        <p>{selected.manifest.description}</p><p>{t("plugins.trust")}</p>
        <ul>{selected.manifest.capabilities.map(cap => <li key={cap}>{cap}</li>)}</ul>
        {selected.runtimeStatus === "stop-unconfirmed" && <p role="alert">{t("plugins.stopUnknown")}</p>}
        {alert}
        <div className="plugin-library-actions">
          <Button className="mcp-remove" variant="ghost" disabled={busy} onClick={() => open({kind:"remove",id:selected.manifest.id})}>{t("plugins.remove")}</Button>
          <Button disabled={busy} variant="ghost" onClick={close}>{t("plugins.cancel")}</Button>
          {selected.runtimeStatus === "stop-unconfirmed" ?
            <Button disabled={busy} onClick={() => changeEnabled(selected, false)}>{t("plugins.retryStop")}</Button> :
            !selected.enabled && <Button disabled={busy} onClick={() => changeEnabled(selected, true)}>{t("plugins.enable")}</Button>}
        </div>
      </Modal>}
    {active && selected && dialog?.kind === "remove" &&
      <Modal className="extension-modal" label={t("plugins.remove")} onClose={close}>
        <h3>{selected.manifest.name}</h3><p>{t("plugins.removeAsk")}</p>
        {alert}
        <div className="plugin-library-actions">
          <Button disabled={busy} variant="ghost" onClick={close}>{t("plugins.cancel")}</Button>
          <Button disabled={busy} onClick={() => void run(() => apiJson(endpoint + "/" + encodeURIComponent(selected.manifest.id), {method:"DELETE"}))}>{t("plugins.remove")}</Button>
        </div>
      </Modal>}
  </section>;
}
