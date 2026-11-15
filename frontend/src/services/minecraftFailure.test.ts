import {expect,it} from 'vitest';
import {minecraftFailureKey} from './minecraftFailure';
it('explains a local plan failure while keeping untrusted diagnostic text out of UI',()=>{
 expect(minecraftFailureKey('step_2:target_not_visible')).toBe('minecraft.reason.target');
 expect(minecraftFailureKey('<script>secret</script>')).toBe('minecraft.blockedHint');
 expect(minecraftFailureKey('step_1:build_blocked')).toBe('minecraft.reason.build');
 expect(minecraftFailureKey('materials_missing')).toBe('minecraft.reason.materials');
});
