

import { useRef, useState } from "react";
import type { McpExtension } from "../../lib/types";
import { useT } from "../../i18n";
import { parseMcpArguments } from "../../lib/mcpArguments";
import { parseMcpJson } from "../../lib/mcpJson";
import {extToForm,formToExt,type ExtForm} from "../../lib/mcpForm";
import FieldRow from "../../ui/FieldRow";
import Modal from "../../ui/Modal";
import Switch from "../../ui/Switch";
import Button from "../../ui/Button";
import IconButton from "../../ui/IconButton";
import DialogBackButton from "../../ui/DialogBackButton";
import Select from "../../ui/Select";
/** http 端点合法性：空=未填（由必填另行提示），非空必须 http(s)://。 */
function extEndpointError(url: string): boolean {
  const v = url.trim();
  if (!v) return false;
  try {
    return !["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return true;
  }
}

/** 校验：名称必填；stdio 命令必填；http 端点必填且 http(s)://。 */
function extFormValid(f: ExtForm, validArgs: boolean): boolean {
  if (!f.name.trim()) return false;
  if (f.transport === "stdio") return f.command.trim() !== "" && validArgs;
  return f.endpoint.trim() !== "" && !extEndpointError(f.endpoint);
}

/** KEY = value 键值对编辑器：行可增删（env / headers 共用）。 */
function KvEditor({
  pairs,
  onChange,
  addLabel,
}: {
  pairs: [string, string][];
  onChange: (pairs: [string, string][]) => void;
  addLabel: string;
}) {
  const t = useT();
  const setPair = (i: number, k: string, v: string): void =>
    onChange(pairs.map((p, j) => (j === i ? ([k, v] as [string, string]) : p)));
  return (
    <div className="kv-list">
      {pairs.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input
            className="kv-key"
            value={k}
            placeholder={t("settings.extKvKey")}
            onChange={(e) => setPair(i, e.target.value, v)}
          />
          <span className="kv-eq">=</span>
          <input
            className="kv-val"
            value={v}
            placeholder={t("settings.extKvVal")}
            onChange={(e) => setPair(i, k, e.target.value)}
          />
<IconButton
              icon="trash"
              size="sm"
              danger
              label={t("common.del")}
              tip={t("common.del")}
              onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            />
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="kv-add"
        onClick={() => onChange([...pairs, ["", ""]])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

export default function ExtConfigModal({
  initial,
  onRemove,
  status,
  onSave,
  onImport,
  onClose,
}: {
  initial: McpExtension;
  onRemove?: () => void;
  status?: string;
  onSave: (ext: McpExtension) => void;
  onImport: (exts: McpExtension[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<ExtForm>(() => extToForm(initial));
  const [view, setView] = useState<"form" | "import">("form");
  const [batch, setBatch] = useState<McpExtension[]>([]);
  const [jsonText, setJsonText] = useState("");
  const [jsonErr, setJsonErr] = useState(false);
  const patch = (p: Partial<ExtForm>): void =>
    setForm((f) => ({ ...f, ...p }));

  const file = useRef<HTMLInputElement>(null);
  const fileRead = useRef(0);
  const applyJson = (text: string): void => {
    try {
      const exts = parseMcpJson(text);
      setJsonErr(false);
      if (exts.length === 1) {
        // A connection snippet must not silently erase an adapter's reviewed scopes.
        setForm(previous => extToForm(exts[0], previous));
        setJsonText("");
        setBatch([]);
        setView("form");
      } else {
        setBatch(exts);
      }
    } catch {
      setJsonErr(true); // 解析失败：表单报错，不导入不污染
    }
  };

  async function importFile(selected: File) {
    const revision = ++fileRead.current;
    try {
      const text = await selected.text();
      if (revision !== fileRead.current) return;
      setJsonText(text);
      setBatch([]);
      applyJson(text);
    } catch {
      if (revision === fileRead.current) setJsonErr(true);
    }
  }

  const validArgs = parseMcpArguments(form.argsText) !== null;
  const endpointErr = extEndpointError(form.endpoint);

  return (
    <Modal onClose={onClose} className="ext-modal" label={t("settings.extCfgTitle")}>
        <header className="ext-modal-head settings-dialog-heading">
          <DialogBackButton onClick={onClose}/>
          <h3 className="opt-group">{t("settings.extCfgTitle")}</h3>
        </header>
        <div className="settings-view-tabs" role="group" aria-label={t("settings.extCfgTitle")}>
          <Button aria-pressed={view === "form"} onClick={() => {fileRead.current++; setView("form");}}>{t("settings.extManual")}</Button>
          <Button aria-pressed={view === "import"} onClick={() => setView("import")}>{t("settings.extJsonBtn")}</Button>
        </div>
        {view === "import" ? <div className="ext-json">
          <input hidden type="file" ref={file} accept=".json,application/json" onChange={event => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (selected) void importFile(selected);
          }}/>
          <textarea rows={5} value={jsonText} placeholder={t("settings.extJsonPh")}
            aria-label={t("settings.extJsonPh")} aria-invalid={jsonErr}
            onChange={event => {
              fileRead.current++;
              setJsonText(event.target.value);
              setJsonErr(false);
              setBatch([]);
            }}/>
          {jsonErr && <p role="alert" className="probe-err">{t("settings.extJsonErr")}</p>}
          {!!batch.length && <ul className="ext-json-preview">{batch.map((ext, index) => <li key={index}>{ext.name}</li>)}</ul>}
          <div className="ext-json-ops">
            <Button size="sm" variant="ghost" onClick={() => file.current?.click()}>{t("settings.extImportFile")}</Button>
            {batch.length
              ? <Button size="sm" onClick={() => onImport(batch)}>{t("settings.extJsonBatch", {count: String(batch.length)})}</Button>
              : <Button size="sm" disabled={!jsonText.trim()} onClick={() => {fileRead.current++; applyJson(jsonText);}}>
                {t("settings.extJsonApply")}
              </Button>}
          </div>
        </div> : <>
        <div className="opt-list">
          <FieldRow label={t("settings.extName")} required>
            <input
              value={form.name}
              placeholder={t("settings.extNamePh")}
              onChange={(e) => patch({ name: e.target.value })}
            />
            {!form.name.trim() && (
              <span className="probe-err">{t("settings.required")}</span>
            )}
          </FieldRow>
          <FieldRow label={t("settings.extTransport")}>
            <Select
              value={form.transport}
              options={[
                {
                  value: "http",
                  label: t("settings.extTransports.http"),
                },
                {
                  value: "sse",
                  label: "SSE",
                },
                {
                  value: "stdio",
                  label: t("settings.extTransports.stdio"),
                },
              ]}
              onChange={(v) =>
                patch({ transport: v as McpExtension["transport"] })
              }
            />
          </FieldRow>
          {form.transport === "stdio" ? (
            <>
              <FieldRow label={t("settings.extCommand")} required>
                <input
                  className={form.command.trim() ? undefined : "invalid"}
                  value={form.command}
                  placeholder={t("settings.extCommandPh")}
                  onChange={(e) => patch({ command: e.target.value })}
                />
                {!form.command.trim() && (
                  <span className="probe-err">{t("settings.required")}</span>
                )}
              </FieldRow>
              <FieldRow label={t("settings.extArgs")} hint={t("settings.extArgsHint")}>
                <input
                  aria-invalid={!validArgs}
                  value={form.argsText}
                  placeholder={t("settings.extArgsPh")}
                  onChange={(e) => patch({ argsText: e.target.value })}
                />
                {!validArgs && <span className="probe-err" role="alert">{t("settings.extArgsInvalid")}</span>}
              </FieldRow>
              <FieldRow label={t("settings.extEnv")} top>
                <KvEditor
                  pairs={form.envPairs}
                  onChange={(envPairs) => patch({ envPairs })}
                  addLabel={t("settings.extEnvAdd")}
                />
              </FieldRow>
            </>
          ) : (
            <>
              <FieldRow label={t("settings.extEndpoint")} required>
                <input
                  className={endpointErr ? "invalid" : undefined}
                  value={form.endpoint}
                  placeholder={t("settings.extEndpointPh")}
                  onChange={(e) => patch({ endpoint: e.target.value })}
                />
                {endpointErr ? (
                  <span className="probe-err">{t("settings.invalidUrl")}</span>
                ) : (
                  !form.endpoint.trim() && (
                    <span className="probe-err">{t("settings.required")}</span>
                  )
                )}
              </FieldRow>
              <FieldRow label={t("settings.extHeaders")} top>
                <KvEditor
                  pairs={form.headerPairs}
                  onChange={(headerPairs) => patch({ headerPairs })}
                  addLabel={t("settings.extHeaderAdd")}
                />
              </FieldRow>
            </>
          )}
          <FieldRow label={t("settings.extEnabled")}>
            <Switch
              on={form.enabled}
              onChange={(v) => patch({ enabled: v })}
            />
          </FieldRow>
        </div>
        {status && <p className="muted" role="status">{status}</p>}
        <div className="ext-actions">
          {onRemove && <Button variant="ghost" className="mcp-remove" onClick={onRemove}>{t("common.del")}</Button>}
          <Button variant="ghost" className="key-toggle" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            className="key-toggle"
            disabled={!extFormValid(form, validArgs)}
            onClick={() => onSave(formToExt(form))}
          >
            {t("common.save")}
          </Button>
        </div>
        </>}
      </Modal>
  );
}
