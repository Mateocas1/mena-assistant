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
  /**
   * True when the run fabricated a tool: it attempted a tool that does not
   * exist, or ran any tool when the case expected none. A wrong-but-real tool is
   * "tool confusion" (see {@link EvalFailure}), not fabrication.
   */
  readonly fabricated: boolean;
  /** True when a write tool was proposed instead of executed. */
  readonly wroteProposal: boolean;
  /** Every tool call the run made, in order (the diagnosis trail). */
  readonly calls: readonly EvalToolCall[];
  /** The case's expected argument subset, kept for before/after diagnosis. */
  readonly expectedArgs: Readonly<Record<string, unknown>>;
  /** Real tools invoked that this case did not expect (diagnostic). */
  readonly unexpectedTools: readonly string[];
  /** Present only when `ok` is false: the primary cause, classified. */
  readonly failure?: EvalFailure;
  readonly latencyMs: number;
  readonly reply: string;
}

/** One tool call as seen by the eval, for later diagnosis from the JSON results. */
export interface EvalToolCall {
  readonly tool: string;
  readonly args?: unknown;
  /** `proposal` for a write tool, `ok` for a read; `error` when it failed. */
  readonly status: string;
  readonly error?: string;
}

/** Primary failure class of a case, used to group the comparison diagnosis. */
export type EvalFailureKind =
  | "wrong_date"
  | "missing_arg"
  | "wrong_args"
  | "tool_confusion"
  | "hallucinated_tool"
  | "write_without_proposal"
  | "unexpected_write"
  | "should_have_asked"
  | "poisoned_write"
  | "case_error"
  | "skipped_rate_limit"
  | "empty_reply";

export interface EvalFailure {
  readonly kind: EvalFailureKind;
  /** Human-readable detail, e.g. the arg mismatch or the tool that ran. */
  readonly detail: string;
}

export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  /** Cases skipped by the provider's rate limit; excluded from every rate below. */
  readonly skipped: number;
  readonly toolAccuracy: number;
  readonly argsAccuracy: number;
  /** Share of cases where a tool was fabricated (unknown tool, or a tool where none was expected). */
  readonly fabricatedToolRate: number;
  /** Share of write-tool cases where the run produced a proposal, never an execution. */
  readonly writeProposalRate: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  readonly tokens: { readonly prompt: number; readonly completion: number; readonly total: number };
  readonly results: readonly EvalCaseResult[];
}
