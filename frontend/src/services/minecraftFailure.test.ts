import {expect,it} from 'vitest';
import {minecraftFailureKey,minecraftTaskVisible,minecraftTaskStateKey} from './minecraftFailure';
it('explains an unobservable condition separately from a condition timeout',()=>{
 expect(minecraftFailureKey('condition_unobservable')).toBe('minecraft.reason.condition');
 expect(minecraftFailureKey('step_1:condition_timeout')).toBe('minecraft.reason.timeout');
});
it('explains a local plan failure while keeping untrusted diagnostic text out of UI',()=>{
 expect(minecraftFailureKey('step_2:target_not_visible')).toBe('minecraft.reason.target');
 expect(minecraftFailureKey('target_absent')).toBe('minecraft.reason.target');
 expect(minecraftFailureKey('<script>secret</script>')).toBe('minecraft.blockedHint');
 expect(minecraftFailureKey('step_1:build_blocked')).toBe('minecraft.reason.build');
 expect(minecraftFailureKey('materials_missing')).toBe('minecraft.reason.materials');
});
it('keeps a queued retreat visible and distinguishes it from an ordinary user cancellation',()=>{
 expect(minecraftFailureKey('retreated_low_health')).toBe('minecraft.reason.retreat');
 expect(minecraftTaskVisible('cancelled','retreated_low_health')).toBe(true);
 expect(minecraftTaskVisible('cancelled','requested')).toBe(false);
 expect(minecraftTaskVisible('cancelled','retreated_low_health','control')).toBe(false);
 expect(minecraftTaskVisible('failed','step_2:retreated_low_health')).toBe(true);
 expect(minecraftTaskStateKey('cancelled','retreated_low_health')).toBe('minecraft.taskState.retreated');
 expect(minecraftTaskStateKey('failed','step_2:retreated_low_health')).toBe('minecraft.taskState.retreated');
 expect(minecraftTaskStateKey('paused','paused')).toBe('minecraft.taskState.paused');
});

it('explains an unavailable surface as a route problem without exposing bridge text',()=>{
 expect(minecraftFailureKey('surface_unavailable')).toBe('minecraft.reason.path');
 expect(minecraftFailureKey('step_1:surface_unavailable')).toBe('minecraft.reason.path');
});
