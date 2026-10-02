import { describe, expect, it } from "vitest";
import {
  TurnosAuthError,
  TurnosHttpError,
  TurnosNetworkError,
  TurnosNotConfiguredError,
  TurnosRequestError,
  TurnosResponseError,
  TurnosTimeoutError,
} from "../src/adapters/turnos/client.js";
import { HttpTurnosClient, type HttpTurnosClientOptions } from "../src/adapters/turnos/http.js";
import { fixedClock } from "../src/time/index.js";

// 01:30 UTC is 22:30 on 2026-01-14 in Buenos Aires.
const CLOCK = fixedClock("2026-01-15T01:30:00Z");
const BASE_URL = "https://demo.convex.site";
const ART_TODAY = "2026-01-14";

const APPOINTMENT = {
  id: "apt_1",
  date: "2026-01-20",
  timeSlot: "08:00",
  status: "confirmed",
  serviceName: "Servicio Soft Gel",
  clientName: "Ana G.",
};

const VERIFICATION = {
  id: "ver_1",
  status: "pending",
  reason: "amount_mismatch",
  amount: 12500,
  date: "2026-01-20",
  timeSlot: "08:00",
  clientName: "Ana G.",
};

import { ScriptedFetch, jsonResponse, type FetchHandler } from "./helpers/fetch.js";

/** The turnos backend answers with `{error: message}` JSON. */
function errorBody(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function makeClient(script: ScriptedFetch, overrides: Partial<HttpTurnosClientOptions> = {}) {
  return new HttpTurnosClient({
    baseUrl: `${BASE_URL}/`,
    token: "service-token",
    clock: CLOCK,
    retryDelayMs: 1,
    requestIdFactory: () => "req_test",
    fetchImpl: script.fetch,
    ...overrides,
  });
}

describe("HttpTurnosClient request shape", () => {
  it("POSTs JSON with the bearer token and validates the response", async () => {
    const script = new ScriptedFetch([() => jsonResponse([APPOINTMENT])]);
    const appointments = await makeClient(script).delDia("2026-01-20");

    expect(appointments).toEqual([APPOINTMENT]);

    const call = script.calls[0]!;
    expect(call.url).toBe(`${BASE_URL}/assistant/appointments/day`);
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer service-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-id")).toBe("req_test");
    expect(call.body).toEqual({ date: "2026-01-20" });
  });

  it("uses /today for the ART today and /day otherwise", async () => {
    const script = new ScriptedFetch([() => jsonResponse([]), () => jsonResponse([])]);
    const client = makeClient(script);

    await client.delDia(ART_TODAY);
    await client.delDia("2026-01-15");

    expect(script.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/assistant/appointments/today`,
      `${BASE_URL}/assistant/appointments/day`,
    ]);
    expect(script.calls[0]?.body).toEqual({});
    expect(script.calls[1]?.body).toEqual({ date: "2026-01-15" });
  });

  it("maps every read tool to its endpoint and body", async () => {
    const script = new ScriptedFetch([
      () => jsonResponse([APPOINTMENT]),
      () => jsonResponse([{ time: "08:00", available: true }]),
      () =>
        jsonResponse([
          {
            slug: "servicio-softgel",
            name: "Servicio Soft Gel",
            price: 25000,
            durationMinutes: 120,
          },
        ]),
      () => jsonResponse([VERIFICATION]),
      () => jsonResponse({ count: 1, totalAmount: 5000, byReason: { admin_cancellation: 1 } }),
      () =>
        jsonResponse({
          date: "2026-01-20",
          totalAppointments: 1,
          counts: { confirmed: 1 },
          revenue: 12500,
          pendingVerifications: 1,
          refundsPending: 1,
        }),
    ]);
    const client = makeClient(script);

    await client.rango("2026-01-14", "2026-01-20");
    await client.disponibilidad("2026-01-20");
    await client.servicios();
    const pending = await client.pagosPendientes();
    await client.resumen("2026-01-20");

    expect(script.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/assistant/appointments/range`,
      `${BASE_URL}/assistant/availability`,
      `${BASE_URL}/assistant/services`,
      `${BASE_URL}/assistant/verifications/pending`,
      `${BASE_URL}/assistant/refunds/summary`,
      `${BASE_URL}/assistant/summary`,
    ]);
    expect(script.calls[0]?.body).toEqual({ from: "2026-01-14", to: "2026-01-20" });
    expect(script.calls[1]?.body).toEqual({ date: "2026-01-20" });
    expect(script.calls[2]?.body).toEqual({});
    expect(script.calls[3]?.body).toEqual({});
    expect(script.calls[4]?.body).toEqual({});
    expect(script.calls[5]?.body).toEqual({ date: "2026-01-20" });

    expect(pending.verificaciones).toEqual([VERIFICATION]);
    expect(pending.reintegros).toEqual({
      count: 1,
      totalAmount: 5000,
      byReason: { admin_cancellation: 1 },
    });
  });

  it("sends a write with motivo mapped to reason", async () => {
    const script = new ScriptedFetch([
      () =>
        jsonResponse({
          success: true,
          refunded: false,
          refundRequired: true,
          refundReason: "admin_cancellation",
          depositRetained: false,
        }),
    ]);
    const result = await makeClient(script).cancelar("apt_1", "viaje");

    expect(result.refundRequired).toBe(true);
    expect(script.calls[0]?.url).toBe(`${BASE_URL}/assistant/appointments/cancel`);
    expect(script.calls[0]?.body).toEqual({ appointmentId: "apt_1", reason: "viaje" });
  });
});

describe("HttpTurnosClient retry policy", () => {
  it("retries once on a 5xx and then succeeds", async () => {
    const script = new ScriptedFetch([
      () => errorBody("boom", 500),
      () => jsonResponse([APPOINTMENT]),
    ]);

    const appointments = await makeClient(script).delDia("2026-01-20");

    expect(appointments).toHaveLength(1);
    expect(script.calls).toHaveLength(2);
  });

  it("retries once on a network failure", async () => {
    const script = new ScriptedFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      () => jsonResponse([APPOINTMENT]),
    ]);

    await expect(makeClient(script).delDia("2026-01-20")).resolves.toHaveLength(1);
    expect(script.calls).toHaveLength(2);
  });

  it("does not retry a 4xx and keeps the backend message", async () => {
    const script = new ScriptedFetch([() => errorBody("date is required", 400)]);

    const error = await makeClient(script)
      .delDia("2026-01-20")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosRequestError);
    expect((error as Error).message).toBe("date is required");
    expect(script.calls).toHaveLength(1);
  });

  it("does not retry a 401 and surfaces the auth message", async () => {
    const script = new ScriptedFetch([() => errorBody("Unauthorized", 401)]);

    const error = await makeClient(script)
      .servicios()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosAuthError);
    expect((error as TurnosAuthError).status).toBe(401);
    expect((error as TurnosAuthError).userMessage).toContain("no pudo autenticarse");
    expect(script.calls).toHaveLength(1);
  });

  it("does not retry a static not-configured 503 and reports it with clear copy", async () => {
    const script = new ScriptedFetch([
      () => errorBody("Assistant endpoints are not configured", 503),
    ]);

    const error = await makeClient(script)
      .servicios()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosNotConfiguredError);
    expect((error as TurnosNotConfiguredError).status).toBe(503);
    expect((error as TurnosNotConfiguredError).userMessage).toContain("no está habilitado");
    expect(script.calls).toHaveLength(1);
  });

  it("still retries a 503 that is not the not-configured state", async () => {
    const script = new ScriptedFetch([
      () => errorBody("upstream unavailable", 503),
      () => errorBody("upstream unavailable", 503),
    ]);

    const error = await makeClient(script)
      .servicios()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosHttpError);
    expect(error).not.toBeInstanceOf(TurnosNotConfiguredError);
    expect((error as TurnosHttpError).status).toBe(503);
    expect(script.calls).toHaveLength(2);
  });

  it("never retries a write", async () => {
    const script = new ScriptedFetch([() => errorBody("slot taken", 500)]);

    const error = await makeClient(script)
      .cancelar("apt_1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosHttpError);
    expect((error as TurnosHttpError).status).toBe(500);
    expect(script.calls).toHaveLength(1);
  });
});

describe("HttpTurnosClient response validation", () => {
  it("rejects a schema mismatch with a typed error", async () => {
    const script = new ScriptedFetch([() => jsonResponse({ nope: true })]); // array expected

    const error = await makeClient(script)
      .servicios()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosResponseError);
    expect(script.calls).toHaveLength(1);
  });

  it("rejects an invalid JSON body with a typed error", async () => {
    const script = new ScriptedFetch([() => new Response("not json", { status: 200 })]);

    await expect(makeClient(script).servicios()).rejects.toBeInstanceOf(TurnosResponseError);
  });

  it("times out after the configured budget and retries once", async () => {
    const hanging: FetchHandler = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const script = new ScriptedFetch([hanging, hanging]);

    const error = await makeClient(script, { timeoutMs: 5 })
      .servicios()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosTimeoutError);
    expect(script.calls).toHaveLength(2);
  });

  it("classifies a non-timeout abort as a network error", async () => {
    const aborting: FetchHandler = () => {
      throw new DOMException("aborted", "AbortError");
    };
    const script = new ScriptedFetch([aborting, aborting]);

    const error = await makeClient(script)
      .servicios()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosNetworkError);
    expect(error).not.toBeInstanceOf(TurnosTimeoutError);
    expect(script.calls).toHaveLength(2);
  });
});

describe("HttpTurnosClient network errors", () => {
  it("wraps a permanent network failure as a typed error", async () => {
    const failing: FetchHandler = () => {
      throw new TypeError("fetch failed");
    };
    const script = new ScriptedFetch([failing, failing]);

    const error = await makeClient(script)
      .servicios()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosNetworkError);
    expect(script.calls).toHaveLength(2);
  });
});

describe("HttpTurnosClient writes", () => {
  it("maps every write to its endpoint and body", async () => {
    const script = new ScriptedFetch([
      () => jsonResponse({ success: true }),
      () => jsonResponse({ success: true, blockedSlotId: "blk_1" }),
      () => jsonResponse({ success: true }),
      () => jsonResponse({ success: true, appointmentId: "apt_new_1" }),
      () =>
        jsonResponse({
          success: true,
          appointmentId: "apt_1",
          date: "2026-01-20",
          timeSlot: "11:00",
        }),
      () => jsonResponse({ success: true }),
      () => jsonResponse({ success: true }),
    ]);
    const client = makeClient(script);

    await client.marcarCompletado("apt_1");
    await client.bloquear({
      date: "2026-01-20",
      timeSlot: "11:00",
      isFullDay: false,
      reason: "curso",
    });
    await client.desbloquear("blk_1");
    await client.crearParaClienta({
      clientName: "Ana Gomez",
      clientPhone: "1145556666",
      serviceSlug: "servicio-softgel",
      date: "2026-01-20",
      timeSlot: "16:30",
      removalAddOn: true,
    });
    await client.reprogramar("apt_1", "2026-01-20", "11:00");
    await client.confirmarTransferencia("pay_1", "ver_1");
    await client.rechazarTransferencia("pay_1", "ver_1", "no coincide");

    expect(script.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/assistant/appointments/complete`,
      `${BASE_URL}/assistant/blocks/create`,
      `${BASE_URL}/assistant/blocks/remove`,
      `${BASE_URL}/assistant/appointments/create`,
      `${BASE_URL}/assistant/appointments/reschedule`,
      `${BASE_URL}/assistant/transfers/confirm`,
      `${BASE_URL}/assistant/transfers/reject`,
    ]);
    expect(script.calls.map((call) => call.init.method)).toEqual(Array(7).fill("POST"));
    expect(script.calls[0]?.body).toEqual({ appointmentId: "apt_1" });
    expect(script.calls[1]?.body).toEqual({
      date: "2026-01-20",
      isFullDay: false,
      timeSlot: "11:00",
      reason: "curso",
    });
    expect(script.calls[2]?.body).toEqual({ blockedSlotId: "blk_1" });
    expect(script.calls[3]?.body).toEqual({
      clientName: "Ana Gomez",
      clientPhone: "1145556666",
      serviceSlug: "servicio-softgel",
      date: "2026-01-20",
      timeSlot: "16:30",
      removalAddOn: true,
    });
    expect(script.calls[4]?.body).toEqual({
      appointmentId: "apt_1",
      date: "2026-01-20",
      timeSlot: "11:00",
    });
    expect(script.calls[5]?.body).toEqual({ paymentId: "pay_1", verificationId: "ver_1" });
    expect(script.calls[6]?.body).toEqual({
      paymentId: "pay_1",
      verificationId: "ver_1",
      reason: "no coincide",
    });
  });

  it("does not retry a write that fails with a domain 500", async () => {
    const script = new ScriptedFetch([
      () => errorBody("Este horario ya está ocupado. Por favor seleccioná otro.", 500),
    ]);

    const error = await makeClient(script)
      .reprogramar("apt_1", "2026-01-20", "11:00")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnosHttpError);
    expect((error as TurnosHttpError).status).toBe(500);
    expect((error as Error).message).toContain("ya está ocupado");
    expect(script.calls).toHaveLength(1);
  });
});
