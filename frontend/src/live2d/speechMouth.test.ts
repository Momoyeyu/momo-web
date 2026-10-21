import { expect, it } from 'vitest';
import { SpeechMouth } from './speechMouth';
it('releases the channel after audio, including silent phonemes and repeat stop events', () => {
  const mouth = new SpeechMouth();
  expect(mouth.sample(0).weight).toBe(0);
  mouth.set(0, true, 10); expect(mouth.sample(10)).toEqual({ value: 0, weight: 1 });
  mouth.set(0.7, true, 20); expect(mouth.sample(20).value).toBe(0.7);
  mouth.set(0, false, 30); mouth.set(0, false, 60);
  expect(mouth.sample(105).weight).toBe(0.5);
  expect(mouth.sample(181).weight).toBe(0);
});
