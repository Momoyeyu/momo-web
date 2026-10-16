// 人格面板（设置页 tab）：人设卡编辑。受控组件——
// 每次修改直接写 store 落盘（设置页即改即生效）。
// 布局按 prototype/setting：「基本信息」整行面板内左右两列，
// 「偏好」独立整行面板（卡片走 ui/EditableItem，与记忆页同一形态：
// 正文单行截断、点击出详情弹窗，编辑/删除在卡片上操作）。

import { useState } from "react";
import type { PersonaCard } from "../lib/types";
import { DEFAULT_PERSONA } from "../lib/store";
import { LIST_PAGE_SIZE, clampPage } from "../lib/paging";
import Pager from "../ui/Pager";
import DetailModal from "../components/DetailModal";
import EditableItem from "../ui/EditableItem";
import IconButton from "../ui/IconButton";
import Button from "../ui/Button";
import { useT, tFor, promptLang } from "../i18n";
import "../styles/persona.css";

export default function PersonaPanel({
  value,
  onChange,
}: {
  value: PersonaCard;
  onChange: (patch: Partial<PersonaCard>) => void;
}) {
  const t = useT();
  const patch = (p: Partial<PersonaCard>): void => onChange(p);

  // 偏好列表：检索 + 分页（过滤后命中集分页，索引映射回原列表）。
  const [prefQuery, setPrefQuery] = useState("");
  const [prefPage, setPrefPage] = useState(0);
  // 卡片内联编辑（原列表索引）与详情弹窗内容。
  const [editingPref, setEditingPref] = useState<number | null>(null);
  const [prefDraft, setPrefDraft] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  const prefHits = value.preferences
    .map((text, i) => ({ text, i }))
    .filter((x) =>
      x.text.toLowerCase().includes(prefQuery.trim().toLowerCase()),
    );
  const pref = clampPage(prefPage, prefHits.length);
  const prefSlice = prefHits.slice(
    pref.page * LIST_PAGE_SIZE,
    (pref.page + 1) * LIST_PAGE_SIZE,
  );

  /** 「+ 添加」：追加空条目并立即进入编辑态（清检索、跳末页保证可见）。 */
  const addPref = (): void => {
    const next = [...value.preferences, ""];
    patch({ preferences: next });
    setPrefQuery("");
    setPrefPage(Math.max(0, Math.ceil(next.length / LIST_PAGE_SIZE) - 1));
    setEditingPref(next.length - 1);
    setPrefDraft("");
  };

  /** 保存卡片编辑：空内容视为放弃该条（直接移除）。 */
  const commitPref = (): void => {
    const i = editingPref;
    const text = prefDraft.trim();
    setEditingPref(null);
    setPrefDraft("");
    if (i === null) return;
    patch({
      preferences: text
        ? value.preferences.map((x, j) => (j === i ? text : x))
        : value.preferences.filter((_, j) => j !== i),
    });
  };

  /** 取消编辑：新增的空白条目一并撤掉。 */
  const cancelPref = (orig: string): void => {
    const i = editingPref;
    setEditingPref(null);
    setPrefDraft("");
    if (i !== null && orig === "") {
      patch({ preferences: value.preferences.filter((_, j) => j !== i) });
    }
  };

  return (
    <div className="persona-tab">
      <section className="panel persona-section">
        <h2>{t("persona.basic")}</h2>
        <div className="fields-grid">
          <div className="fields-col">
            <label className="field">
              <span className="field-label">{t("persona.name")}</span>
              <input
                value={value.name}
                placeholder={DEFAULT_PERSONA.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">{t("persona.identity")}</span>
              <input
                value={value.identity}
                placeholder={tFor(promptLang(), "persona.defaults.identity")}
                onChange={(e) => patch({ identity: e.target.value })}
              />
            </label>
          </div>
          <div className="fields-col">
            <label className="field">
              <span className="field-label">{t("persona.age")}</span>
              <input
                type="number"
                placeholder={String(DEFAULT_PERSONA.age)}
                value={Number.isFinite(value.age) ? value.age : ""}
                onChange={(e) => patch({ age: e.target.valueAsNumber })}
              />
            </label>
            <label className="field">
              <span className="field-label">{t("persona.personality")}</span>
              <input
                value={value.personality}
                placeholder={tFor(promptLang(), "persona.defaults.personality")}
                onChange={(e) => patch({ personality: e.target.value })}
              />
            </label>
          </div>
        </div>
      </section>
      <section className="panel persona-section">
        <h2>{t("persona.preferences")}</h2>
        <div className="mem-toolbar">
          <input
            className="mem-search"
            placeholder={t("persona.prefSearchPh")}
            value={prefQuery}
            onChange={(e) => {
              setPrefQuery(e.target.value);
              setPrefPage(0);
            }}
          />
          <IconButton
            icon="plus"
            label={t("persona.prefAdd")}
            onClick={addPref}
            disabled={editingPref !== null}
          />
        </div>
        <div className="field col-grow">
          {prefSlice.map(({ text: p, i }) => (
            <EditableItem
              key={i}
              editing={editingPref === i}
              onOpen={() => setDetail(p)}
              onStartEdit={() => {
                setEditingPref(i);
                setPrefDraft(p);
              }}
              onDelete={() =>
                patch({
                  preferences: value.preferences.filter((_, j) => j !== i),
                })
              }
              edit={
                <div className="list-edit">
                  <input
                    autoFocus
                    value={prefDraft}
                    placeholder={t("persona.preferencesPh")}
                    onChange={(e) => setPrefDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        commitPref();
                      } else if (e.key === "Escape") {
                        cancelPref(p);
                      }
                    }}
                  />
                  <div className="row">
                    <Button size="sm" onClick={() => commitPref()}>
                      {t("common.save")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => cancelPref(p)}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              }
            >
              {p}
            </EditableItem>
          ))}
          {prefHits.length === 0 && (
            <p className="muted">{t("persona.prefEmpty")}</p>
          )}
        </div>
        <div className="col-foot">
          <div className="mem-foot">
            <Pager
              page={pref.page}
              pages={pref.pages}
              onChange={setPrefPage}
            />
          </div>
        </div>
      </section>
      {detail !== null && (
        <DetailModal text={detail} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}
