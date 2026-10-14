// 人格面板（设置页 tab）：人设卡编辑。受控组件——
// 草稿与保存由设置页统一管理（底部统一保存 + 离开确认）。

import type { PersonaCard } from "../lib/types";
import { useT } from "../i18n";
import "../styles/persona.css";

/** 保存前清洗：trim、去空行、去全空例子。 */
export function cleanPersona(p: PersonaCard): PersonaCard {
  return {
    name: p.name.trim(),
    oneLiner: p.oneLiner.trim(),
    identity: p.identity.trim(),
    tone: p.tone.trim(),
    likes: p.likes.map((s) => s.trim()).filter(Boolean),
    dislikes: p.dislikes.map((s) => s.trim()).filter(Boolean),
    traits: p.traits.map((s) => s.trim()).filter(Boolean),
    taboos: p.taboos.map((s) => s.trim()).filter(Boolean),
    examples: p.examples
      .filter((e) => e.user.trim() || e.assistant.trim())
      .map((e) => ({ user: e.user.trim(), assistant: e.assistant.trim() })),
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
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("persona.oneLiner")}</span>
            <input
              value={value.oneLiner}
              onChange={(e) => patch({ oneLiner: e.target.value })}
            />
          </label>
          <label className="field span2">
            <span className="field-label">{t("persona.identity")}</span>
            <textarea
              rows={2}
              value={value.identity}
              onChange={(e) => patch({ identity: e.target.value })}
            />
          </label>
          <label className="field span2">
            <span className="field-label">{t("persona.tone")}</span>
            <input
              value={value.tone}
              onChange={(e) => patch({ tone: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("persona.likes")}</span>
            <textarea
              rows={4}
              value={value.likes.join("\n")}
              onChange={(e) => patch({ likes: e.target.value.split("\n") })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("persona.dislikes")}</span>
            <textarea
              rows={4}
              value={value.dislikes.join("\n")}
              onChange={(e) => patch({ dislikes: e.target.value.split("\n") })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("persona.traits")}</span>
            <textarea
              rows={5}
              value={value.traits.join("\n")}
              onChange={(e) => patch({ traits: e.target.value.split("\n") })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("persona.taboos")}</span>
            <textarea
              rows={5}
              value={value.taboos.join("\n")}
              onChange={(e) => patch({ taboos: e.target.value.split("\n") })}
            />
          </label>
        </div>
        <div className="field">
          <span className="field-label">{t("persona.examples")}</span>
          {value.examples.map((ex, i) => (
            <div className="example-row" key={i}>
              <input
                placeholder={t("persona.exUserPh")}
                value={ex.user}
                onChange={(e) =>
                  patch({
                    examples: value.examples.map((x, j) =>
                      j === i ? { ...x, user: e.target.value } : x,
                    ),
                  })
                }
              />
              <input
                placeholder={t("persona.exAsstPh")}
                value={ex.assistant}
                onChange={(e) =>
                  patch({
                    examples: value.examples.map((x, j) =>
                      j === i ? { ...x, assistant: e.target.value } : x,
                    ),
                  })
                }
              />
              <button
                className="ghost small"
                onClick={() =>
                  patch({
                    examples: value.examples.filter((_, j) => j !== i),
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
              patch({
                examples: [...value.examples, { user: "", assistant: "" }],
              })
            }
          >
            {t("persona.exAdd")}
          </button>
        </div>
      </section>
    </div>
  );
}
