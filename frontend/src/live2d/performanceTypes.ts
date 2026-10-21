export interface ExpressionRequest { name: string; intensity: number; duration?: number }
export interface PerformanceCue { id: string; offset: number; expression?: ExpressionRequest | null; motion?: string }
export interface ControlResource { name: string; desc: string; label?: string; context?: string; duration?: number; enabled?: boolean }
export interface PresentationSnapshot {
  avatarId: string; revision: string;
  expressions: ControlResource[]; motions: ControlResource[];
  expressionState: { name: string | null; intensity: number };
}
export interface ParameterOperation { id: string; value: number; blend: "Add" | "Multiply" | "Overwrite" }
export interface ExpressionDefinition { name: string; parameters: ParameterOperation[] }
export interface ParameterCore {
  getParameterValueById(id: string): number;
  setParameterValueById(id: string, value: number): void;
}
