/** Audio owns mouth opening only while playing, then releases it over 150ms. */
export class SpeechMouth {
  private active = false;
  private value = 0;
  private releasedAt = -Infinity;
  set(value: number, active: boolean, now: number): void {
    if (!active && this.active) this.releasedAt = now;
    this.active = active;
    this.value = Math.max(0, Math.min(1, value));
  }
  sample(now: number): { value: number; weight: number } {
    return this.active ? { value: this.value, weight: 1 }
      : { value: 0, weight: Math.max(0, 1 - (now - this.releasedAt) / 150) };
  }
  clear(): void { this.active = false; this.value = 0; this.releasedAt = -Infinity; }
}
