// 人格面板（设置页 tab）：人设卡编辑。受控组件——
// 每次修改直接写 store 落盘（设置页即改即生效）。
// 布局按 prototype/setting：「基本信息」整行面板内左右两列，
// 「偏好」独立整行面板。

import type { PersonaCard } from "../lib/types";
import { DEFAULT_PERSONA } from "../lib/store";
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
              <textarea
                rows={3}
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
        <div className="field">
          {value.preferences.map((p, i) => (
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
          <button
            className="ghost small"
            onClick={() => patch({ preferences: [...value.preferences, ""] })}
          >
            {t("persona.prefAdd")}
          </button>
        </div>
      </section>
    </div>
  );
}
