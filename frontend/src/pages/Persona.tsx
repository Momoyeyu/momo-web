// 人格面板（设置页 tab）：人设卡编辑。受控组件——
// 每次修改直接写 store 落盘（设置页即改即生效）。
// 布局按 prototype/setting：「基本信息」整行面板内左右两列，
// 「偏好」独立整行面板。

import { useState } from "react";
import type { PersonaCard } from "../lib/types";
import { DEFAULT_PERSONA } from "../lib/store";
import { LIST_PAGE_SIZE, clampPage } from "../lib/paging";
import Pager from "../ui/Pager";
import { useT } from "../i18n";
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
                placeholder={DEFAULT_PERSONA.identity}
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
                placeholder={DEFAULT_PERSONA.personality}
                onChange={(e) => patch({ personality: e.target.value })}
              />
            </label>
          </div>
        </div>
      </section>
      <section className="panel persona-section">
        <h2>{t("persona.preferences")}</h2>
        <input
          className="mem-search"
          placeholder={t("persona.prefSearchPh")}
          value={prefQuery}
          onChange={(e) => {
            setPrefQuery(e.target.value);
            setPrefPage(0);
          }}
        />
        <div className="field col-grow">
          {prefSlice.map(({ text: p, i }) => (
            <div className="pin-row" key={i}>
              <input
                value={p}
                placeholder={t("persona.preferencesPh")}
                onChange={(e) =>
                  patch({
                    preferences: value.preferences.map((x, j) =>
                      j === i ? e.target.value : x,
                    ),
                  })
                }
              />
              <button
                className="ghost small"
                onClick={() =>
                  patch({
                    preferences: value.preferences.filter((_, j) => j !== i),
                  })
                }
              >
                {t("common.del")}
              </button>
            </div>
          ))}
          {prefHits.length === 0 && (
            <p className="muted">{t("persona.prefEmpty")}</p>
          )}
        </div>
        <div className="list-foot">
          <button
            className="ghost small"
            onClick={() => patch({ preferences: [...value.preferences, ""] })}
          >
            {t("persona.prefAdd")}
          </button>
          <Pager
            page={pref.page}
            pages={pref.pages}
            onChange={setPrefPage}
          />
        </div>
      </section>
    </div>
  );
}
