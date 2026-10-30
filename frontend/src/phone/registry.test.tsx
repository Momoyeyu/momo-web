import {describe,it,expect} from 'vitest';
import {phoneApps,registerPhoneApp} from './registry';
import {autoPhone} from './visibility';
describe('platform phone',()=>{
 it('exists without apps, supports another app and disposes independently',()=>{
  expect(phoneApps()).toHaveLength(0);
  const dispose=registerPhoneApp({id:'synthetic',source:'test',icon:'T'});
  expect(phoneApps()[0]?.render).toBeUndefined();
  expect(()=>registerPhoneApp({id:'synthetic',source:'test',icon:'T'})).toThrow();
  dispose();expect(phoneApps()).toHaveLength(0);
 });
 it('only actual work opens it; focus and explicit close suppress auto',()=>{
  expect(autoPhone(false,false,false,false)).toBe(false);
  expect(autoPhone(false,false,true,false)).toBe(true);
  expect(autoPhone(false,true,true,false)).toBe(false);
  expect(autoPhone(false,false,true,true)).toBe(false);
  expect(autoPhone(true,false,false,true)).toBe(true);
 });
});
