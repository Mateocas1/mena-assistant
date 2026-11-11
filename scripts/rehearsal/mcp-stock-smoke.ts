#!/usr/bin/env tsx
/**
 * Smoke: the *assistant's* stock write against the local mena-nails stack,
 * driven through a real MCP client session.
 *
 * It connects to the same MCP server the operator's agent uses
 * (`createMcpServer`), calls `stock.registrar_servicio` twice for the SAME
 * appointment, then runs both proposals through the write tool's
 * `executeProposal` (the exact call the bot's confirm button makes) and asserts
 * that stock moved once and the retry replayed.
 *
 * The shipped `pnpm mcp` entrypoint builds its context without a stock backend
 * (`src/mcp/main.ts`), so `stock.*` there fails with "the stock backend is not
 * configured". This script wires the stock backend the way `createBotDeps`
 * does, which is what the bot actually runs; see docs/rehearsal.md.
 *
 * Usage: scripts/rehearsal/mcp-stock-smoke.ts        (with the rehearsal up)
 *   MENA_NAILS_API_URL / MENA_NAILS_TOKEN  are required (STOCK_BACKEND=http)
 *   REHEARSAL_OWNER_PASSWORD               read from ~/.config/mena/rehearsal.env
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createStockBackend } from "../../src/adapters/index.js";
import type { StockEntry } from "../../src/adapters/stock/client.js";
import { parseConfig } from "../../src/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createToolRegistry } from "../../src/mcp/tools/index.js";
import type { WriteToolDefinition } from "../../src/mcp/registry.js";
import { ProposalStore } from "../../src/proposals/store.js";
import { systemClock } from "../../src/time/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const API = process.env.MENA_NAILS_API_URL ?? "";
const SERVICE_TOKEN = process.env.MENA_NAILS_TOKEN ?? "";
const OWNER_PASSWORD =
  process.env.REHEARSAL_OWNER_PASSWORD ?? readSecret("REHEARSAL_OWNER_PASSWORD");
const ORIGIN = process.env.API_ALLOWED_ORIGIN ?? "http://localhost:5173";
const SOURCE_APPOINTMENT_ID = `rehearsal-smoke-${Date.now()}`;

const failures: string[] = [];
function check(condition: boolean, label: string): void {
  console.log(`${condition ? "[ok]" : "[FAIL]"} ${label}`);
  if (!condition) failures.push(label);
}

/** Reads one value from the mode-600 rehearsal secret file without echoing it. */
function readSecret(key: string): string {
  const path = process.env.MENA_REHEARSAL_ENV ?? `${homedir()}/.config/mena/rehearsal.env`;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${key}=`));
  if (!line) throw new Error(`missing ${key} in ${path}`);
  return line
    .slice(key.length + 1)
    .replace(/^'|'$/g, "")
    .replace(/'\\''/g, "'");
}

async function api<T>(
  method: "GET" | "POST",
  path: string,
  options: { token: string; csrf?: string; origin?: boolean; body?: unknown } = { token: "" },
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.token}`,
      // Owner writes need the exact browser origin; service credentials are
      // refused outright when they carry one (mena-nails access.go), so it is
      // only sent together with the CSRF token.
      ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
      ...(options.csrf || options.origin ? { Origin: ORIGIN } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.trim()}`);
  return (text.trim() === "" ? undefined : JSON.parse(text)) as T;
}

interface CatalogItem {
  readonly id: number;
  readonly displayLabel: string;
  readonly quantityModel: "tip" | "pieces" | "pots" | "container";
  readonly isColor: boolean;
}

async function stockSnapshot(): Promise<Map<number, number | null>> {
  const { items } = await api<{ items: StockEntry[] }>("GET", "/stock", { token: SERVICE_TOKEN });
  return new Map(items.map((item) => [item.itemId, item.units]));
}

async function main(): Promise<void> {
  if (!API) throw new Error("MENA_NAILS_API_URL is required");
  if (!SERVICE_TOKEN) throw new Error("MENA_NAILS_TOKEN is required");

  // ── MCP server with the stock backend the bot wires ────────────────────────
  // The Telegram token and LLM key are only required by parseConfig, not used.
  const config = parseConfig({
    ...process.env,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "rehearsal-placeholder",
    TELEGRAM_ALLOWLIST: process.env.TELEGRAM_ALLOWLIST ?? "1:romi",
    LLM_API_KEY: process.env.LLM_API_KEY ?? "rehearsal-placeholder",
    FEATURE_STOCK: "true",
    STOCK_BACKEND: "http",
    MENA_NAILS_API_URL: API,
    MENA_NAILS_TOKEN: SERVICE_TOKEN,
  } as NodeJS.ProcessEnv);

  const stock = createStockBackend(config);
  const registry = createToolRegistry(config.features);
  const proposals = new ProposalStore({ ttlMs: config.proposalTtlMs, clock: systemClock });
  const context = {
    // A turnos backend is not exercised here; the MCP tool context requires one.
    backend: {
      servicios: async () => [],
      turnosDelDia: async () => [],
    } as unknown as Parameters<typeof createMcpServer>[0]["context"]["backend"],
    stock,
    proposals,
    clock: systemClock,
    profile: config.mcp.profile,
    chatId: `mcp:${config.mcp.profile}`,
  };

  const server = createMcpServer({ registry, profile: config.mcp.profile, context });
  const client = new Client({ name: "rehearsal-smoke", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    check(names.includes("stock.registrar_servicio"), "MCP exposes stock.registrar_servicio");
    check(names.includes("stock.catalogo"), "MCP exposes stock.catalogo");

    // ── baseline: a confirmed stocktake so /stock is not uncounted ───────────
    const session = await api<{ accessToken: string; csrfToken: string }>("POST", "/auth/login", {
      token: "",
      origin: true,
      body: { password: OWNER_PASSWORD },
    });
    const catalog = await api<CatalogItem[]>("GET", "/catalog/items", {
      token: session.accessToken,
    });
    const color = catalog.find((item) => item.isColor && item.quantityModel === "container");
    const tips = catalog.find((item) => item.quantityModel === "tip");
    if (!color || !tips) throw new Error("the seeded catalog has no colour or tip item");
    console.log(`[info] catalog ${catalog.length} items · colour ${color.id} · tip ${tips.id}`);

    const run = await api<{ runId: number; version: number }>("POST", "/stocktake/runs", {
      token: session.accessToken,
      csrf: session.csrfToken,
    });
    for (const item of catalog) {
      const exact = item.quantityModel !== "container";
      await api("POST", "/stocktake/observations", {
        token: session.accessToken,
        csrf: session.csrfToken,
        body: {
          runId: run.runId,
          version: run.version,
          itemId: item.id,
          status: "observed",
          quantityModel: item.quantityModel,
          ...(exact ? { units: 100 } : { closed: 5, openFraction: 0 }),
        },
      });
    }
    await api("POST", "/stocktake/confirm", {
      token: session.accessToken,
      csrf: session.csrfToken,
      body: { runId: run.runId, version: run.version },
    });
    console.log(`[info] stocktake ${run.runId}/${run.version} confirmed`);

    // ── two MCP calls for the same appointment ───────────────────────────────
    const args = {
      servicio: "soft_gel" as const,
      colorItemId: color.id,
      tips: [{ itemId: tips.id, units: 10 }],
      sourceAppointmentId: SOURCE_APPOINTMENT_ID,
    };
    const before = await stockSnapshot();

    const proposalIds: string[] = [];
    for (const attempt of [1, 2]) {
      const result = await client.callTool({ name: "stock.registrar_servicio", arguments: args });
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      const parsed = JSON.parse(text) as { proposal_id: string; requires_confirmation: boolean };
      check(parsed.requires_confirmation === true, `MCP call ${attempt} returns a proposal`);
      proposalIds.push(parsed.proposal_id);
    }
    check(new Set(proposalIds).size === 2, "the two MCP calls propose two independent writes");
    check(
      JSON.stringify(await stockSnapshot()) === JSON.stringify(before),
      "no MCP call wrote anything before confirmation",
    );

    // ── confirm both, exactly like the bot's Confirmar button ────────────────
    const tool = registry.get("stock.registrar_servicio");
    if (!tool || tool.kind !== "write")
      throw new Error("stock.registrar_servicio is not a write tool");
    const writeTool: WriteToolDefinition = tool;

    const executed: Array<{ replayed: boolean; logId: number }> = [];
    for (const id of proposalIds) {
      const proposal = proposals.get(id);
      if (!proposal) throw new Error(`proposal ${id} disappeared`);
      const result = await writeTool.executeProposal(proposal.args, context);
      executed.push(JSON.parse(result.content) as { replayed: boolean; logId: number });
    }
    const afterFirst = executed[0];
    const afterSecond = executed[1];
    check(afterFirst?.replayed === false, "the first confirmation is a real write");
    check(afterSecond?.replayed === true, "the retry is reported as replayed");
    check(afterFirst?.logId === afterSecond?.logId, "the retry returns the original log id");

    const final = await stockSnapshot();
    const tipBefore = before.get(tips.id) ?? 0;
    const tipAfter = final.get(tips.id) ?? 0;
    check(tipAfter === tipBefore - 10, `tips deducted exactly once (${tipBefore} → ${tipAfter})`);
    check(
      JSON.stringify([...final.entries()]) !== JSON.stringify([...before.entries()]),
      "stock did move once",
    );
  } finally {
    await client.close();
    await server.close();
  }
}

let crashed: unknown;
try {
  await main();
} catch (error) {
  crashed = error;
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
}

if (crashed) {
  process.exitCode = 1;
} else if (failures.length > 0) {
  console.error(`[FAILED] ${failures.length} assertion(s)`);
  process.exitCode = 1;
} else {
  console.log("[ok] MCP stock write smoke passed: two calls, one deduction");
}
