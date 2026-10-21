import type { AvatarResources } from "../lib/types";
import type { ExpressionDefinition, ParameterOperation } from "./performanceTypes";

export { BUILTIN_RESOURCES, mergeBuiltinResources } from './resourceProfiles';

export interface RuntimeResource {
  name: string; fileName: string; aliases: string[];
  group?: string; index?: number; duration?: number; parameterIds: string[];
}
export interface ResourceCatalog { expressions: RuntimeResource[]; motions: RuntimeResource[] }
export function reconcileResources(catalog: ResourceCatalog, old?: AvatarResources): AvatarResources {
  return Object.fromEntries(Object.entries(catalog).map(([kind, entries]) => [kind, entries.map((entry: RuntimeResource) => {
    const previous = old?.[kind as keyof AvatarResources].find(r => r.name === entry.name || entry.aliases.includes(r.name));
    return { ...previous, name: entry.name, desc: previous?.desc ?? '' };
  })])) as unknown as AvatarResources;
}

/** Parse model-owned exp3 operations. No cross-model parameter guessing. */
export function parseExpression(name: string, value: unknown, ids: Set<string>): ExpressionDefinition {
  if (!value || typeof value !== "object" || !("Parameters" in value) || !Array.isArray(value.Parameters)) throw new Error("Invalid exp3");
  const parameters: ParameterOperation[] = value.Parameters.map((p: { Id?: unknown; Value?: unknown; Blend?: unknown }) => {
    if (typeof p.Id !== "string" || !ids.has(p.Id) || typeof p.Value !== "number" || !Number.isFinite(p.Value)) throw new Error("Unknown expression parameter");
    return { id: p.Id, value: p.Value, blend: p.Blend === "Add" || p.Blend === "Multiply" ? p.Blend : "Overwrite" };
  });
  return { name, parameters };
}

/** MotionManager creates per-group storage at construction; synthesized groups need it too. */
export function ensureIdleGroup(definitions: Record<string, unknown[]>, slots: Record<string, unknown[]>, neutralFile?: string): void {
  if (!definitions.MomoIdle) definitions.MomoIdle = neutralFile ? Object.values(definitions).flat().filter((entry: any) => entry.File === neutralFile).slice(0, 1) : [];
  slots.MomoIdle ??= [];
}
