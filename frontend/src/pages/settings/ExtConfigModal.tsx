

// MCP server 配置弹窗：transport 下拉切换差分字段（stdio=命令/参数/环境变量，
// http=端点/请求头）；顶部「从 JSON 填入」粘贴标准 MCP 配置 —— 单条填表、
// 多条直接逐个导入列表；点遮罩或取消关闭（未保存丢弃）。
import { useState } from "react";
import type { McpExtension } from "../../lib/types";
import { useT } from "../../i18n";
import { parseMcpJson } from "../../lib/mcpJson";
import FieldRow from "../../ui/FieldRow";
import Modal from "../../ui/Modal";
import Switch from "../../ui/Switch";
import Button from "../../ui/Button";
import IconButton from "../../ui/IconButton";
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

/** 弹窗表单草稿：args/env/headers 用文本/键值对形态便于编辑，保存时归一。 */
interface ExtForm {
  name: string;
  transport: McpExtension["transport"];
  enabled: boolean;
  command: string;
  /** stdio 参数：空格分隔文本，保存时拆数组。 */
  argsText: string;
  envPairs: [string, string][];
  endpoint: string;
  headerPairs: [string, string][];
}

function extToForm(ext: McpExtension): ExtForm {
  return {
    name: ext.name,
    transport: ext.transport,
    enabled: ext.enabled,
    command: ext.command,
    argsText: ext.args.join(" "),
    envPairs: Object.entries(ext.env),
    endpoint: ext.endpoint,
    headerPairs: Object.entries(ext.headers),
  };
}

function formToExt(f: ExtForm): McpExtension {
  const dict = (pairs: [string, string][]): Record<string, string> =>
    Object.fromEntries(
      pairs.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]),
    );
  return {
    name: f.name.trim(),
    transport: f.transport,
    enabled: f.enabled,
    command: f.command.trim(),
    args: f.argsText.split(/\s+/).filter(Boolean),
    env: dict(f.envPairs),
    endpoint: f.endpoint.trim(),
    headers: dict(f.headerPairs),
  };
}

/** 校验：名称必填；stdio 命令必填；http 端点必填且 http(s)://。 */
function extFormValid(f: ExtForm): boolean {
  if (!f.name.trim()) return false;
  if (f.transport === "stdio") return f.command.trim() !== "";
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

/**
 * MCP server 配置弹窗：transport 下拉切换差分字段（stdio=命令/参数/环境变量，
 * http=端点/请求头）；顶部「从 JSON 填入」粘贴标准 MCP 配置——单条填表、
 * 多条直接逐个导入列表；点遮罩或取消关闭（未保存丢弃）。
 */
export default function ExtConfigModal({
  initial,
  onSave,
  onImport,
  onClose,
}: {
  initial: McpExtension;
  onSave: (ext: McpExtension) => void;
  /** JSON 多条导入：直接进列表并关弹窗（草稿丢弃）。 */
  onImport: (exts: McpExtension[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<ExtForm>(() => extToForm(initial));
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonErr, setJsonErr] = useState(false);
  const patch = (p: Partial<ExtForm>): void =>
    setForm((f) => ({ ...f, ...p }));

  const applyJson = (): void => {
    try {
      const exts = parseMcpJson(jsonText);
      if (exts.length === 1) {
        setForm(extToForm(exts[0]));
        setJsonText("");
        setJsonErr(false);
        setJsonOpen(false);
      } else {
        onImport(exts);
      }
    } catch {
      setJsonErr(true); // 解析失败：表单报错，不导入不污染
    }
  };

  const endpointErr = extEndpointError(form.endpoint);

  return (
    <Modal onClose={onClose} className="ext-modal">
        <div className="ext-modal-head">
          <h3 className="opt-group">{t("settings.extCfgTitle")}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setJsonOpen((o) => !o);
              setJsonErr(false);
            }}
          >
            {t("settings.extJsonBtn")}
          </Button>
        </div>
        {jsonOpen && (
          <div className="ext-json">
            <textarea
              rows={5}
              value={jsonText}
              placeholder={t("settings.extJsonPh")}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonErr(false);
              }}
            />
            <div className="ext-json-ops">
              {jsonErr && (
                <span className="probe-err">{t("settings.extJsonErr")}</span>
              )}
              <Button
                size="sm"
                disabled={!jsonText.trim()}
                onClick={applyJson}
              >
                {t("settings.extJsonApply")}
              </Button>
            </div>
          </div>
        )}
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
              <FieldRow label={t("settings.extArgs")}>
                <input
                  value={form.argsText}
                  placeholder={t("settings.extArgsPh")}
                  onChange={(e) => patch({ argsText: e.target.value })}
                />
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
        <div className="ext-actions">
          <Button variant="ghost" className="key-toggle" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            className="key-toggle"
            disabled={!extFormValid(form)}
            onClick={() => onSave(formToExt(form))}
          >
            {t("common.save")}
          </Button>
        </div>
      </Modal>
  );
}

