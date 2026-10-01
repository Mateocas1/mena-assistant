import { randomUUID } from "node:crypto";
import type { ProfileName } from "../config.js";
import { systemClock, type Clock } from "../time/index.js";

export type ProposalStatus = "pending" | "consumed" | "expired";

/**
 * A structured, evidence-bearing action the LLM proposed but is not allowed to
 * execute. Only a verified Telegram callback consumes it.
 */
export interface Proposal {
  readonly id: string;
  /** Chat that produced the proposal; only that chat may confirm it. */
  readonly chatId: string;
  readonly profile: ProfileName;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly diff: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  status: ProposalStatus;
}

export interface CreateProposalInput {
  readonly chatId: string;
  readonly profile: ProfileName;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly diff: string;
}

export type ConsumeFailureReason = "unknown" | "wrong_chat" | "expired" | "already_used";

export type ConsumeResult =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly reason: ConsumeFailureReason };

export interface ProposalStoreOptions {
  readonly ttlMs: number;
  readonly clock?: Clock;
  readonly idFactory?: () => string;
}

/**
 * In-memory, single-process proposal registry. Expiry plus single use is what
 * keeps "the LLM never writes" true even under a crafted callback.
 */
export class ProposalStore {
  private readonly proposals = new Map<string, Proposal>();
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly idFactory: () => string;

  constructor(options: ProposalStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  create(input: CreateProposalInput): Proposal {
    const createdAtMs = this.clock().getTime();
    const proposal: Proposal = {
      id: this.idFactory(),
      chatId: input.chatId,
      profile: input.profile,
      tool: input.tool,
      args: input.args,
      summary: input.summary,
      diff: input.diff,
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs,
      status: "pending",
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * Validates chat ownership, expiry and single use, then marks the proposal used.
   * A wrong chat never burns the proposal; a replay always fails.
   */
  consume(id: string, chatId: number | string): ConsumeResult {
    const proposal = this.proposals.get(id);
    if (!proposal) return { ok: false, reason: "unknown" };
    if (proposal.status === "consumed") return { ok: false, reason: "already_used" };
    if (proposal.status === "expired") return { ok: false, reason: "expired" };
    if (this.clock().getTime() >= proposal.expiresAtMs) {
      proposal.status = "expired";
      return { ok: false, reason: "expired" };
    }
    if (String(chatId) !== proposal.chatId) return { ok: false, reason: "wrong_chat" };

    proposal.status = "consumed";
    return { ok: true, proposal };
  }
}
