import {expect,it} from 'vitest';
import {minecraftFailureKey} from './minecraftFailure';
it('explains a local plan failure while keeping untrusted diagnostic text out of UI',()=>{
 expect(minecraftFailureKey('step_2:target_not_visible')).toBe('minecraft.reason.target');
 expect(minecraftFailureKey('<script>secret</script>')).toBe('minecraft.blockedHint');
});
