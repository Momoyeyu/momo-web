// 人格面板（设置页 tab）：人设卡编辑。受控组件——
// 草稿与保存由设置页统一管理（底部统一保存 + 离开确认）。
// schema 按人设设计：名称/身份/年龄/性格/偏好（system prompt 由 backend 组装）。

import type { PersonaCard } from "../lib/types";
import { DEFAULT_PERSONA } from "../lib/store";
import { useT } from "../i18n";
import "../styles/persona.css";

/** 保存前清洗：trim、偏好去空行、年龄非法值回退默认。 */
export function cleanPersona(p: PersonaCard): PersonaCard {
  return {
    name: p.name.trim(),
    identity: p.identity.trim(),
    age:
      typeof p.age === "number" && Number.isFinite(p.age)
        ? Math.trunc(p.age)
        : 16,
    personality: p.personality.trim(),
    preferences: p.preferences.map((s) => s.trim()).filter(Boolean),
  };
}

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
        <h2>{t("persona.card")}</h2>
        <div className="fields-grid">
          <label className="field">
            <span className="field-label">{t("persona.name")}</span>
            <input
              value={value.name}
              placeholder={DEFAULT_PERSONA.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("persona.age")}</span>
            <input
              type="number"
              placeholder={String(DEFAULT_PERSONA.age)}
              value={Number.isFinite(value.age) ? value.age : ""}
              onChange={(e) => patch({ age: e.target.valueAsNumber })}
            />
          </label>
          <label className="field span2">
            <span className="field-label">{t("persona.identity")}</span>
            <input
              value={value.identity}
              placeholder={DEFAULT_PERSONA.identity}
              onChange={(e) => patch({ identity: e.target.value })}
            />
          </label>
          <label className="field span2">
            <span className="field-label">{t("persona.personality")}</span>
            <textarea
              rows={4}
              value={value.personality}
              placeholder={DEFAULT_PERSONA.personality}
              onChange={(e) => patch({ personality: e.target.value })}
            />
          </label>
          <label className="field span2">
            <span className="field-label">{t("persona.preferences")}</span>
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
                        preferences: value.preferences.filter(
                          (_, j) => j !== i,
                        ),
                      })
                    }
                  >
                    {t("common.del")}
                  </button>
                </div>
              ))}
              <button
                className="ghost small"
                onClick={() =>
                  patch({ preferences: [...value.preferences, ""] })
                }
              >
                {t("persona.prefAdd")}
              </button>
            </div>
          </label>
        </div>
      </section>
    </div>
  );
}
