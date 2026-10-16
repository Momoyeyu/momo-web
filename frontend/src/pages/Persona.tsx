// 人格面板（设置页 tab）：人设卡编辑。受控组件——
// 每次修改直接写 store 落盘（设置页即改即生效）。
// 布局按 prototype/setting：「基本信息」整行面板内左右两列，
// 「偏好」独立整行面板（卡片走 ui/EditableItem，与记忆页同一形态：
// 正文单行截断、点击出详情弹窗，编辑/删除在卡片上操作；
// 添加走 ui/AddItemModal 弹窗，与工具栏的「+」软绑定）。

import { useState } from "react";
import type { PersonaCard } from "../lib/types";
import { DEFAULT_PERSONA } from "../lib/store";
import { CARD_PAGE_SIZE, clampPage } from "../lib/paging";
import Pager from "../ui/Pager";
import AvatarPanel from "./Avatar";
import AddItemModal from "../ui/AddItemModal";
import DetailModal from "../components/DetailModal";
import EditableItem from "../ui/EditableItem";
import FieldRow from "../ui/FieldRow";
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
  // 「+ 添加」走 ui/AddItemModal（与加号软绑定）
  const [addOpen, setAddOpen] = useState(false);
  const prefHits = value.preferences
    .map((text, i) => ({ text, i }))
    .filter((x) =>
      x.text.toLowerCase().includes(prefQuery.trim().toLowerCase()),
    );
  const pref = clampPage(prefPage, prefHits.length, CARD_PAGE_SIZE);
  const prefSlice = prefHits.slice(
    pref.page * CARD_PAGE_SIZE,
    (pref.page + 1) * CARD_PAGE_SIZE,
  );

  /** 弹窗保存：追加新条目（清检索、跳末页保证可见）。 */
  const addPref = (text: string): void => {
    const next = [...value.preferences, text];
    patch({ preferences: next });
    setPrefQuery("");
    setPrefPage(Math.max(0, Math.ceil(next.length / CARD_PAGE_SIZE) - 1));
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

  /** 取消编辑：改动不落盘（添加改走弹窗，不再有待撤的空条目）。 */
  const cancelPref = (): void => {
    setEditingPref(null);
    setPrefDraft("");
  };

  return (
    <div className="persona-tab">
      <section className="panel persona-section">
        <h3 className="opt-group">{t("persona.basic")}</h3>
        {/* 与设置页一致：左标签 + 右控件（ui/FieldRow），不再用「标签在上」的竖排。
            仍是两列网格（名称/年龄 一行、身份/性格 一行），列内行距交给 .opt-row
            自己的 padding 与分隔线。 */}
        <div className="fields-grid">
          <div className="fields-col">
            <FieldRow label={t("persona.name")}>
              <input
                value={value.name}
                placeholder={DEFAULT_PERSONA.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </FieldRow>
            <FieldRow label={t("persona.identity")}>
              <input
                value={value.identity}
                placeholder={tFor(promptLang(), "persona.defaults.identity")}
                onChange={(e) => patch({ identity: e.target.value })}
              />
            </FieldRow>
          </div>
          <div className="fields-col">
            <FieldRow label={t("persona.age")}>
              <input
                type="number"
                placeholder={String(DEFAULT_PERSONA.age)}
                value={Number.isFinite(value.age) ? value.age : ""}
                onChange={(e) => patch({ age: e.target.valueAsNumber })}
              />
            </FieldRow>
            <FieldRow label={t("persona.personality")}>
              <input
                value={value.personality}
                placeholder={tFor(promptLang(), "persona.defaults.personality")}
                onChange={(e) => patch({ personality: e.target.value })}
              />
            </FieldRow>
          </div>
        </div>
      </section>
      {/* 形象与偏好并排：两者都是「列表 + 底部翻页/留白」的形态，等宽成一栏后
          高度自然对齐（.settings-cols 的 align-items: stretch）。 */}
      <div className="settings-cols">
        <section className="panel persona-section">
        <h3 className="opt-group">{t("persona.preferences")}</h3>
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
            onClick={() => setAddOpen(true)}
          />
        </div>
        <div className="list-body">
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
                        cancelPref();
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
                      onClick={() => cancelPref()}
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
        <section className="panel persona-section">
          <h3 className="opt-group">
            {t("settings.groups.avatar")}
            <span className="req">*</span>
          </h3>
          <AvatarPanel />
        </section>
      </div>
      {detail !== null && (
        <DetailModal text={detail} onClose={() => setDetail(null)} />
      )}

      {/* 添加走弹窗：与工具栏的「+」软绑定（见 ui/AddItemModal 顶部注释） */}
      {addOpen && (
        <AddItemModal
          title={t("persona.prefAdd")}
          placeholder={t("persona.preferencesPh")}
          onSave={(text) => {
            setAddOpen(false);
            addPref(text);
          }}
          onCancel={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}
