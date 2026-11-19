// The bundled CJK families have hundreds of unicode-range shards. Embed only
// rendered families and characters present in the captured scene.
type FontShard = {family: string; css: string; url: string; ranges: [number, number][]};
let catalog: Promise<FontShard[]> | undefined;
const embedded = new Map<string, Promise<string>>();
const family = (value: string) => value.replace(/^['"]|['"]$/g, '').toLowerCase();

async function loadCatalog(): Promise<FontShard[]> {
  const response = await fetch('/fonts/fonts.css');
  if (!response.ok) throw Error('Font catalog unavailable');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(await response.text());
  return Array.from(sheet.cssRules).flatMap(rule => {
    if (!(rule instanceof CSSFontFaceRule)) return [];
    const url = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue('src'))?.[1];
    if (!url) return [];
    const ranges: [number, number][] = [];
    for (const match of rule.style.getPropertyValue('unicode-range').matchAll(/U\+([\da-f]+)(?:-([\da-f]+))?/gi)) {
      ranges.push([parseInt(match[1],16),parseInt(match[2] ?? match[1],16)]);
    }
    return [{family: family(rule.style.fontFamily), css: rule.cssText, url, ranges}];
  });
}

async function embed(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw Error('Font shard unavailable');
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function captureFonts(node: HTMLElement): Promise<string> {
  catalog ??= loadCatalog().catch(error => {catalog=undefined; throw error;});
  const available = new Set(Array.from(document.fonts)
    .filter(face => face.status === 'loaded' || face.status === 'loading').map(face => family(face.family)));
  let text = node.innerText;
  for (const field of node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) {
    if (field.getClientRects().length && field.type !== 'password') text += field.value || field.placeholder;
  }
  const points = Array.from(new Set(text), char => char.codePointAt(0)!);
  const shards = (await catalog).filter(shard => available.has(shard.family) && (!shard.ranges.length ||
    shard.ranges.some(([start,end]) => points.some(point => point >= start && point <= end))));
  const css = await Promise.all(shards.map(shard => {
    let pending = embedded.get(shard.url);
    if (!pending) {
      pending = embed(shard.url).catch(error => {embedded.delete(shard.url); throw error;});
      embedded.set(shard.url, pending);
    }
    return pending.then(dataUrl => shard.css.replace(shard.url, dataUrl));
  }));
  return css.join('\n');
}
