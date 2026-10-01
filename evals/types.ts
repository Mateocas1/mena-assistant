import type { ProfileName } from "../src/config.js";

/** One eval case: a real Romi question → the tool and args it must produce. */
export interface EvalCase {
  readonly id: string;
  readonly question: string;
  readonly profile: ProfileName;
  /** `null` means the assistant must answer without calling a tool. */
  readonly expectedTool: string | null;
  readonly expectedArgs?: Readonly<Record<string, unknown>>;
}

export interface EvalCaseResult {
  readonly id: string;
  readonly question: string;
  readonly ok: boolean;
  readonly toolMatched: boolean;
  readonly argsMatched: boolean;
  readonly expectedTool: string | null;
  readonly actualTool: string | null;
  readonly actualArgs?: unknown;
  readonly reply: string;
}

export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly toolAccuracy: number;
  readonly argsAccuracy: number;
  readonly results: readonly EvalCaseResult[];
}
