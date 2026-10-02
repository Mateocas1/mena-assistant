import { MockStockBackend } from "../../src/adapters/stock/mock.js";
import { MockTurnosBackend } from "../../src/adapters/turnos/mock.js";
import { createTurnosFixtures } from "../../src/adapters/turnos/fixtures.js";
import { ProposalStore } from "../../src/proposals/store.js";
import type { ToolHandlerContext } from "../../src/mcp/registry.js";
import { fixedClock } from "../../src/time/index.js";

/** ART day used by every test: 2026-01-15T01:30Z is 2026-01-14 22:30 in Buenos Aires. */
export const TEST_ART_DATE = "2026-01-14";
export const TEST_INSTANT = "2026-01-15T01:30:00Z";
export const TEST_CHAT_ID = "111";

export class SpyTurnosBackend extends MockTurnosBackend {
  readonly cancelCalls: string[] = [];
  readonly delDiaCalls: string[] = [];
  readonly rangoCalls: Array<[string, string]> = [];
  readonly disponibilidadCalls: string[] = [];
  servicioCalls = 0;

  override async delDia(date: string) {
    this.delDiaCalls.push(date);
    return super.delDia(date);
  }

  override async rango(from: string, to: string) {
    this.rangoCalls.push([from, to]);
    return super.rango(from, to);
  }

  override async disponibilidad(date: string) {
    this.disponibilidadCalls.push(date);
    return super.disponibilidad(date);
  }

  override async servicios() {
    this.servicioCalls += 1;
    return super.servicios();
  }

  override async cancelar(appointmentId: string, motivo?: string) {
    this.cancelCalls.push(appointmentId);
    return super.cancelar(appointmentId, motivo);
  }
}

export interface TestContext {
  readonly context: ToolHandlerContext;
  readonly backend: SpyTurnosBackend;
  readonly proposals: ProposalStore;
}

export function makeTestContext(
  overrides: Partial<Pick<ToolHandlerContext, "profile" | "chatId">> = {},
): TestContext {
  const backend = new SpyTurnosBackend(createTurnosFixtures(TEST_ART_DATE), {
    clock: fixedClock(TEST_INSTANT),
  });
  const proposals = new ProposalStore({
    ttlMs: 10 * 60_000,
    clock: fixedClock(TEST_INSTANT),
  });

  return {
    backend,
    proposals,
    context: {
      backend,
      proposals,
      clock: fixedClock(TEST_INSTANT),
      profile: overrides.profile ?? "romi",
      chatId: overrides.chatId ?? TEST_CHAT_ID,
    },
  };
}

export interface StockTestContext {
  readonly context: ToolHandlerContext;
  readonly stock: MockStockBackend;
  readonly proposals: ProposalStore;
}

/** Turnos + stock context with the in-memory stock backend. */
export function makeStockTestContext(): StockTestContext {
  const base = makeTestContext();
  const stock = new MockStockBackend();
  return {
    stock,
    proposals: base.proposals,
    context: { ...base.context, stock },
  };
}
