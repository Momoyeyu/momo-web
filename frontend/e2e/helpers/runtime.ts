import type { Page } from '@playwright/test';
import type { PresentationSnapshot } from '../../src/live2d/performanceTypes';

/** Read the module actually loaded by Vite, including its HMR version query. */
export async function presentation(page: Page, includeDisabled = false): Promise<PresentationSnapshot | null> {
  return page.evaluate(async (all) => {
    const entry = performance.getEntriesByType('resource').find(item => new URL(item.name).pathname === '/src/live2d/stage.ts');
    if (!entry) return null;
    return (await import(entry.name)).getStage().getPresentation(all);
  }, includeDisabled);
}

export async function activeAvatar(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').find(item => new URL(item.name).pathname === '/src/lib/store.ts');
    return entry ? (await import(entry.name)).getAvatarId() : null;
  });
}
