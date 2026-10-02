import { describe, expect, it } from "vitest";
import {
  StockAuthError,
  StockConflictError,
  StockForbiddenError,
  StockHttpError,
  StockNetworkError,
  StockRequestError,
  StockResponseError,
  StockTimeoutError,
} from "../src/adapters/stock/client.js";
import { HttpStockClient, type HttpStockClientOptions } from "../src/adapters/stock/http.js";
import { ScriptedFetch, jsonResponse, textResponse, type FetchHandler } from "./helpers/fetch.js";

const BASE_URL = "http://api:8080";

const ENTRY = {
  itemId: 1,
  label: "City 22",
  quantityModel: "container",
  alertPolicy: "closed_container_reserve",
  alert: "okay",
  tipShape: null,
  tipSize: null,
  units: 6,
  closed: 6,
  openFraction: null,
  confirmedAt: "2026-01-13T11:00:00Z",
  version: 1,
  uncounted: false,
  movementUnits: 0,
  forecast: null,
};

const LOW_ENTRY = { ...ENTRY, itemId: 2, label: "Nude Glitter 118", units: 1, alert: "low" };

function makeClient(script: ScriptedFetch, overrides: Partial<HttpStockClientOptions> = {}) {
  return new HttpStockClient({
    baseUrl: `${BASE_URL}/`,
    token: "svc_test-token",
    timeoutMs: 50,
    retryDelayMs: 1,
    fetchImpl: script.fetch,
    ...overrides,
  });
}

describe("HttpStockClient reads", () => {
  it("GETs /stock with the service credential and validates the contract", async () => {
    const script = new ScriptedFetch([() => jsonResponse({ items: [ENTRY, LOW_ENTRY] })]);
    const items = await makeClient(script).actual();

    expect(items).toEqual([ENTRY, LOW_ENTRY]);
    const call = script.calls[0]!;
    expect(call.url).toBe(`${BASE_URL}/stock`);
    expect(call.init.method).toBe("GET");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer svc_test-token");
    expect(call.body).toBeUndefined();
  });

  it("filters alerts to low items", async () => {
    const script = new ScriptedFetch([() => jsonResponse({ items: [ENTRY, LOW_ENTRY] })]);
    const alerts = await makeClient(script).alertas();
    expect(alerts.map((item) => item.itemId)).toEqual([2]);
  });

  it("maps the remaining reads to their endpoints and clamps the limit", async () => {
    const script = new ScriptedFetch([
      () => jsonResponse({ logs: [] }),
      () => jsonResponse({ logs: [] }),
      () => jsonResponse({ logs: [] }),
      () => jsonResponse({ prices: [] }),
      () => jsonResponse([]),
    ]);
    const client = makeClient(script);

    await client.serviciosRecientes(5);
    await client.serviciosRecientes(0);
    await client.serviciosRecientes(500);
    await client.precios();
    await client.catalogo();

    expect(script.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/services?limit=5`,
      `${BASE_URL}/services?limit=1`,
      `${BASE_URL}/services?limit=100`,
      `${BASE_URL}/services/prices`,
      `${BASE_URL}/catalog/items`,
    ]);
  });
});

describe("HttpStockClient writes", () => {
  it("POSTs a service log with tips and the source appointment", async () => {
    const script = new ScriptedFetch([
      () =>
        jsonResponse({
          logId: 7,
          movements: [
            { itemId: 1, unitsDelta: -1 },
            { itemId: 10, unitsDelta: -10 },
          ],
          replayed: false,
        }),
    ]);
    const result = await makeClient(script).registrarServicio({
      serviceKey: "soft_gel",
      colorItemId: 1,
      tips: [{ itemId: 10, units: 10 }],
      sourceAppointmentId: "apt_today_0800",
    });

    expect(result).toEqual({
      logId: 7,
      movements: [
        { itemId: 1, unitsDelta: -1 },
        { itemId: 10, unitsDelta: -10 },
      ],
      replayed: false,
    });
    expect(script.calls[0]?.url).toBe(`${BASE_URL}/services`);
    expect(script.calls[0]?.init.method).toBe("POST");
    expect(script.calls[0]?.body).toEqual({
      serviceKey: "soft_gel",
      colorItemId: 1,
      tips: [{ itemId: 10, units: 10 }],
      sourceAppointmentId: "apt_today_0800",
    });
  });

  it("parses a replayed response", async () => {
    const script = new ScriptedFetch([
      () => jsonResponse({ logId: 7, movements: [], replayed: true }),
    ]);
    const result = await makeClient(script).registrarServicio({
      serviceKey: "capping",
      colorItemId: 1,
    });
    expect(result.replayed).toBe(true);
  });

  it("maps 409 to a conflict with clear copy and never retries", async () => {
    const script = new ScriptedFetch([
      () => textResponse("the source appointment already has a service log", 409),
    ]);
    const error = await makeClient(script)
      .registrarServicio({ serviceKey: "capping", colorItemId: 1, sourceAppointmentId: "apt_x" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockConflictError);
    expect((error as StockConflictError).userMessage).toContain("ya tenía un servicio registrado");
    expect(script.calls).toHaveLength(1);
  });

  it("never retries any write failure", async () => {
    const script = new ScriptedFetch([() => textResponse("boom", 500)]);
    const error = await makeClient(script)
      .registrarServicio({ serviceKey: "capping", colorItemId: 1 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockHttpError);
    expect(script.calls).toHaveLength(1);
  });
});

describe("HttpStockClient failures", () => {
  it("maps 401 to an auth error without retrying", async () => {
    const script = new ScriptedFetch([() => textResponse("unauthorized", 401)]);
    const error = await makeClient(script)
      .actual()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockAuthError);
    expect((error as StockAuthError).userMessage).toContain("no pudo autenticarse");
    expect(script.calls).toHaveLength(1);
  });

  it("explains the owner-only catalog route on 403", async () => {
    const script = new ScriptedFetch([() => textResponse("forbidden", 403)]);
    const error = await makeClient(script)
      .catalogo()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockForbiddenError);
    expect((error as StockForbiddenError).userMessage).toContain("no deja leer el catálogo");
    expect(script.calls).toHaveLength(1);
  });

  it("does not retry a 400", async () => {
    const script = new ScriptedFetch([() => textResponse("invalid tip allocation", 400)]);
    const error = await makeClient(script)
      .registrarServicio({
        serviceKey: "soft_gel",
        colorItemId: 1,
        tips: [{ itemId: 10, units: 1 }],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockRequestError);
    expect(script.calls).toHaveLength(1);
  });

  it("retries a 503 once and keeps a clear message", async () => {
    const script = new ScriptedFetch([
      () => textResponse("unavailable", 503),
      () => textResponse("unavailable", 503),
    ]);
    const error = await makeClient(script)
      .actual()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockHttpError);
    expect((error as StockHttpError).status).toBe(503);
    expect((error as StockHttpError).userMessage).toContain("no está disponible");
    expect(script.calls).toHaveLength(2);
  });

  it("retries a network failure once", async () => {
    const failing: FetchHandler = () => {
      throw new TypeError("fetch failed");
    };
    const script = new ScriptedFetch([failing, failing]);
    const error = await makeClient(script)
      .actual()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockNetworkError);
    expect(script.calls).toHaveLength(2);
  });

  it("timed out requests become a typed timeout", async () => {
    const hanging: FetchHandler = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const script = new ScriptedFetch([hanging, hanging]);
    const error = await makeClient(script)
      .actual()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockTimeoutError);
    expect(script.calls).toHaveLength(2);
  });

  it("rejects a response that does not match the contract", async () => {
    const script = new ScriptedFetch([() => jsonResponse({ items: [{ nope: true }] })]);
    await expect(makeClient(script).actual()).rejects.toBeInstanceOf(StockResponseError);
  });
});
