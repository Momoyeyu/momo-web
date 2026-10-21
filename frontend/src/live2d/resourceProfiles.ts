import type { AvatarResources, AvatarResource } from '../lib/types';

const motion = (no: number, label: string, desc: string, context: string): AvatarResource => ({
  name: `motions/Hiyori_m${String(no).padStart(2, '0')}.motion3.json`, label, desc, context,
});
/** Calibrated against this repository's full Hiyori package, not another model version. */
export const BUILTIN_RESOURCES: AvatarResources = {
  expressions: [
    { name: 'happy', label: '笑眼', desc: '眼睛略眯，眉毛轻抬，嘴角上扬；不改变身体姿态', context: '开心、欢迎、感谢、被认可；认真安慰或坏消息时避免笑脸' },
    { name: 'curious', label: '挑眉疑问', desc: '左右眉毛不对称上扬，眼睛开度不同，嘴角回到平直', context: '好奇、追问、轻微怀疑、没听懂；不是愤怒或强烈惊吓' },
    { name: 'surprised', label: '扬眉惊讶', desc: '双眉上抬，眼睛睁大，嘴角收起', context: '意外消息、突然发现、出乎预料；普通提问优先用 curious' },
    { name: 'shy', label: '脸红微笑', desc: '脸颊泛红，眼睛柔和眯起，嘴角轻扬', context: '亲近的夸奖、被温柔逗弄、有些不好意思；不是难过或恐惧' },
  ],
  motions: [
    motion(1, '自然轻晃', '双手垂放，身体和头部轻微摆动，面部变化较小', '平静聊天、倾听、自然待机；不要当作强烈情绪反应'),
    motion(2, '侧头微笑', '头部侧倾后回正，动作后段闭眼微笑，手臂略向两侧展开', '轻松回应、温和认可、俏皮地接话；不适合严肃坏消息'),
    motion(3, '转身笑', '头和身体向一侧倾转，过程中闭眼微笑，随后回正', '轻松、得意、带笑的回应；不要仅因低头就用作失落或害羞'),
    motion(4, '微微脸红', '双手保持垂放，面颊短暂泛红，头和身体轻微偏转', '被亲近地夸奖、有些不好意思；不是大幅欢迎或挥手'),
    motion(5, '轻转站姿', '双手垂放，缓慢转动头部与身体，再回到自然站姿', '平静叙述、稍作思考或倾听；没有明显欢呼或生气动作'),
    motion(6, '双手合拢微笑', '双手抬到胸前靠拢，头部倾斜，后段闭眼微笑', '期待、感谢、温柔请求、开心的认可；不是单纯歪头思考'),
    motion(7, '侧身反应', '身体短暂偏向一侧并回正，伴随眉眼变化，双手没有抬起', '短促的意外、轻微吃惊或俏皮反应；不是抬手庆祝'),
    motion(8, '抬手笑', '双手抬到肩旁，闭眼笑，身体轻轻晃动', '开心、庆祝、得意、活泼地回应好消息；不适合失落和严肃安慰'),
    motion(9, '摊手皱眉', '双臂向身体两侧打开，眉眼收拢，随后收回双手', '轻微不满、抗议、无奈或吐槽；避免搭配羞涩的笑脸'),
    motion(10, '垂眼皱眉', '双手垂放，眼睑压低、眉毛收拢，头部略低', '不高兴、委屈、认真表达不满；不能仅凭垂眼就解释为困倦'),
  ],
};

export const LEGACY_MOTIONS: Record<string, string> = Object.fromEntries(
  [1,2,3,5,6,7,8,9,10,4].map((n,i) => [i === 9 ? 'TapBody/0' : `Idle/${i}`, `motions/Hiyori_m${String(n).padStart(2,'0')}.motion3.json`]),
);
// Only known defaults for the same resource are upgraded. Other edits survive.
const oldDefaults: Record<string, string[]> = {
  happy: ['开心、欢迎、被夸奖时，笑眼和上扬嘴角'],
  curious: ['好奇、疑惑、反问时，一侧扬眉'],
  surprised: ['意外、惊讶、不可思议时，睁大眼睛并扬眉'],
  shy: ['害羞、被逗弄、亲昵又有些不好意思时，脸红和柔和笑眼'],
};
const previousMotions = [
  ['轻晃身体，轻松地继续说话', '待机轻晃'],
  ['自然的站姿变化', '待机动作'],
  ['低头侧身，有些不好意思或犹豫', '害羞地低头'],
  ['轻微身体转动', '待机动作'],
  ['歪头思考，适合认真想一想', '思考的样子', '抬手微笑'],
  ['惊讶的身体反应', '惊讶', '惊讶眨眼'],
  ['失落地垂下目光', '难过', '抬手笑'],
  ['有些不服气的身体反应', '生气'],
  ['困倦的身体反应', '困倦', '失落'],
  ['受到关注时轻快回应，开心或欢迎时使用', '开心地蹦一下', '害羞'],
];
Object.values(LEGACY_MOTIONS).forEach((name, i) => { oldDefaults[name] = previousMotions[i]; });
export function mergeBuiltinResources(old?: AvatarResources): AvatarResources {
  return Object.fromEntries(Object.entries(BUILTIN_RESOURCES).map(([kind, defaults]) => [kind, defaults.map((base: AvatarResource) => {
    const previous = old?.[kind as keyof AvatarResources].find(r => (LEGACY_MOTIONS[r.name] ?? r.name) === base.name);
    if (!previous) return { ...base };
    const migrated = { ...base, ...previous, name: base.name };
    if (oldDefaults[base.name]?.includes(previous.desc)) migrated.desc = base.desc;
    return migrated;
  })])) as unknown as AvatarResources;
}
