import { describe, expect, it } from "vitest";
import { ProposalStore } from "../src/proposals/store.js";
import { fixedClock } from "../src/time/index.js";

function makeStore(at = "2026-01-14T12:00:00Z", ttlMs = 10 * 60_000) {
  let counter = 0;
  return new ProposalStore({
    ttlMs,
    clock: fixedClock(at),
    idFactory: () => `prop_${++counter}`,
  });
}

const input = {
  chatId: "111",
  profile: "romi" as const,
  tool: "turnos.cancelar",
  args: { appointmentId: "apt_today_0800", motivo: "viaje" },
  summary: "Cancelar el turno de Ana G. del 2026-01-14 08:00",
  diff: "- status: confirmed\n+ status: cancelled",
};

describe("ProposalStore", () => {
  it("creates a proposal with an id and an expiry", () => {
    const store = makeStore();
    const proposal = store.create(input);

    expect(proposal.id).toBe("prop_1");
    expect(proposal.status).toBe("pending");
    expect(proposal.chatId).toBe("111");
    expect(proposal.tool).toBe("turnos.cancelar");
    expect(proposal.createdAtMs).toBe(Date.parse("2026-01-14T12:00:00Z"));
    expect(proposal.expiresAtMs).toBe(Date.parse("2026-01-14T12:00:00Z") + 600_000);
  });

  it("consumes a pending proposal once, for the originating chat", () => {
    const store = makeStore();
    const proposal = store.create(input);

    const first = store.consume(proposal.id, "111");
    expect(first).toMatchObject({ ok: true });
    expect(store.get(proposal.id)?.status).toBe("consumed");
  });

  it("refuses a replayed callback", () => {
    const store = makeStore();
    const proposal = store.create(input);

    store.consume(proposal.id, "111");
    const replay = store.consume(proposal.id, "111");
    expect(replay).toEqual({ ok: false, reason: "already_used" });
  });

  it("refuses a callback from another chat without burning the proposal", () => {
    const store = makeStore();
    const proposal = store.create(input);

    const wrongChat = store.consume(proposal.id, "222");
    expect(wrongChat).toEqual({ ok: false, reason: "wrong_chat" });
    expect(store.get(proposal.id)?.status).toBe("pending");
    expect(store.consume(proposal.id, "111")).toMatchObject({ ok: true });
  });

  it("refuses an expired proposal", () => {
    let current = new Date("2026-01-14T12:00:00Z");
    const store = new ProposalStore({
      ttlMs: 10 * 60_000,
      clock: () => current,
      idFactory: () => "prop_x",
    });
    const proposal = store.create(input);

    current = new Date("2026-01-14T12:11:00Z");

    expect(store.consume(proposal.id, "111")).toEqual({ ok: false, reason: "expired" });
    expect(store.get(proposal.id)?.status).toBe("expired");
  });

  it("returns unknown for an id it never issued", () => {
    const store = makeStore();
    expect(store.consume("nope", "111")).toEqual({ ok: false, reason: "unknown" });
    expect(store.get("nope")).toBeUndefined();
  });
});
