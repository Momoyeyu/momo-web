import { describe, it, expect } from "vitest";
import { ensureIdleGroup, mergeBuiltinResources, parseExpression } from "./controlCatalog";

describe('runtime catalog', () => {
  it('initializes both definitions and manager slots for imported models', () => {
    const definitions = { Idle: [{ File: 'neutral.motion3.json' }, { File: 'angry.motion3.json' }] };
    const slots = { Idle: [] };
    ensureIdleGroup(definitions, slots, 'neutral.motion3.json');
    expect(definitions).toMatchObject({ MomoIdle: [{ File: 'neutral.motion3.json' }] });
    expect(slots).toMatchObject({ MomoIdle: [] });
  });
  it('upgrades old builtin lists without losing user labels or disabled controls', () => {
    const next = mergeBuiltinResources({ expressions: [], motions: [{ name: 'Idle/2', desc: '我的标签', enabled: false }] });
    expect(next.expressions.map((e) => e.name)).toEqual(['happy','curious','surprised','shy']);
    expect(next.motions.find((m) => m.name === 'motions/Hiyori_m03.motion3.json')).toMatchObject({ desc: '我的标签', enabled: false });
  });
  it('rejects unknown parameters but permits authored mouth opening without audio', () => {
    expect(() => parseExpression('x', { Parameters: [{Id:'Missing',Value:1}] }, new Set(['eye']))).toThrow();
    expect(parseExpression('x', { Parameters: [{Id:'ParamMouthOpenY',Value:1}] }, new Set(['ParamMouthOpenY'])).parameters).toHaveLength(1);
  });
});

it('uses file IDs, separates observations from context, and migrates legacy custom settings', () => {
  const next = mergeBuiltinResources({ expressions: [], motions: [
    { name: 'Idle/4', desc: '我的自定义说明', enabled: false },
    { name: 'Idle/6', desc: '失落地垂下目光' },
  ] });
  expect(next.motions.find(m => m.name === 'motions/Hiyori_m06.motion3.json')).toMatchObject({ desc: '我的自定义说明', enabled: false });
  expect(next.motions.find(m => m.name === 'motions/Hiyori_m08.motion3.json')).toMatchObject({ label: '抬手笑', context: expect.stringContaining('开心') });
  expect(next.motions.some(m => m.name.startsWith('Idle/'))).toBe(false);
});

it('does not guess that the first imported Idle motion is neutral', () => {
  const groups = { Idle: [{File:'angry.motion3.json'}] }; const slots = {};
  ensureIdleGroup(groups, slots); expect(groups).toMatchObject({MomoIdle:[]});
});
