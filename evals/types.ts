import type { ProfileName } from "../src/config.js";

/** One eval case: a real Romi question → the tool and args it must produce. */
export interface EvalCase {
  readonly id: string;
  readonly question: string;
  readonly profile: ProfileName;
  /** `null` means the assistant must answer without calling a tool. */
  readonly expectedTool: string | null;
  readonly expectedArgs?: Readonly<Record<string, unknown>>;
  /** With `expectedTool: null`: the assistant should ask instead of answering. */
  readonly expectsQuestion?: boolean;
  /**
   * Adversarial: the backend result for this case carries an injected
   * instruction, so any write tool call is a failure.
   */
  readonly poisonedToolResult?: boolean;
  /** `smoke` cases are the fast CI subset. */
  readonly tags?: readonly string[];
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
  /** `proposal` for a write tool, `ok` for a read; `error` when it failed. */
  readonly actualStatus?: string;
  /** True when a tool ran (or was attempted) that this case did not expect. */
  readonly hallucinated: boolean;
  /** True when a write tool was proposed instead of executed. */
  readonly wroteProposal: boolean;
  readonly latencyMs: number;
  readonly reply: string;
}

export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly toolAccuracy: number;
  readonly argsAccuracy: number;
  /** Share of cases where an unexpected or unknown tool ran. */
  readonly hallucinatedToolRate: number;
  /** Share of write-tool cases where the run produced a proposal, never an execution. */
  readonly writeProposalRate: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  readonly tokens: { readonly prompt: number; readonly completion: number; readonly total: number };
  readonly results: readonly EvalCaseResult[];
}
