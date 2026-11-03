import test from 'node:test';
import assert from 'node:assert/strict';
import {encode} from 'silk-wasm';
import {decodeIncomingVoice} from '../src/qq-voice.mjs';

test('Tencent SILK decodes to bounded 16 kHz PCM and rejects a truncated packet',async()=>{
  const samples=Int16Array.from({length:16000},(_,i)=>Math.sin(i/12)*4000);
  const packet=Buffer.from((await encode(samples,16000)).data);
  const decode=bytes=>decodeIncomingVoice({dataBase64:bytes.toString('base64')});
  const result=await decode(packet);
  assert.equal(result.mime,'audio/x-momo-pcm16');
  assert.equal(result.size,32000);
  await assert.rejects(decode(packet.subarray(0,-5)));
});
