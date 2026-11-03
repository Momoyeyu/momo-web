// NT voice messages normally contain Tencent SILK. Decode locally; only mono
// 16 kHz PCM crosses the host boundary into the same ASR used by the microphone.
export async function decodeIncomingVoice(result) {
  if (!result?.dataBase64) return result;
  const bytes = Buffer.from(result.dataBase64, 'base64');
  if (!bytes.subarray(0, 10).includes(Buffer.from('#!SILK_V3'))) return result;
  const {decode} = await import('silk-wasm');
  let offset = bytes[0] === 2 ? 10 : 9;
  let frames = 0;
  while (offset + 2 <= bytes.length) {
    const length = bytes.readInt16LE(offset);
    offset += 2;
    if (length === -1 && offset === bytes.length) break;
    if (length <= 0 || offset + length > bytes.length || ++frames > 6000)
      throw new Error('Invalid or oversized QQ voice packet');
    offset += length;
  }
  if (!frames || offset !== bytes.length) throw new Error('Incomplete QQ voice packet');
  const pcm = (await decode(bytes, 16000)).data;
  if (!pcm.length || pcm.length > 120 * 32000) throw new Error('Invalid QQ voice duration');
  return {...result, mime:'audio/x-momo-pcm16', dataBase64:Buffer.from(pcm).toString('base64'),size:pcm.length};
}
