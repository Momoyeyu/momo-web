/** Only verified provider protocols receive a native thinking parameter. */
export function supportsThinking(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}
