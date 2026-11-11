#!/usr/bin/env tsx
/**
 * Acceptance e2e: a retried `POST /services` must not deduct twice.
 *
 * It brings up the mena-nails local stack under the compose project `m3e2e`
 * (never touching other containers), seeds the catalog, confirms a stocktake,
 * then posts the SAME service log twice with the same `sourceAppointmentId` and
 * asserts that `GET /stock` is identical between the two calls (one movement
 * set) while the first call did move stock.
 *
 * Usage: pnpm e2e:stock [--keep]
 *   MENA_NAILS_PATH   mena-nails checkout (default ../mena-nails)
 *   M3E2E_API_PORT    host port for the API (default 8080, as in its compose)
 *
 * Exit codes: 0 pass · 1 failure · 2 cannot run (with the exact reason).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MENA_NAILS = resolve(process.env.MENA_NAILS_PATH ?? "../mena-nails");
const PROJECT = "m3e2e";
const PORT = Number(process.env.M3E2E_API_PORT ?? 8080);
const API = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://m3e2e.local";
const OWNER_PASSWORD = "m3e2e-owner-password";
const SERVICE_TOKEN = "svc_m3e2e_assistant_token";
const SOURCE_APPOINTMENT_ID = "m3e2e-appointment-1";
const KEEP = process.argv.includes("--keep");
const COMPOSE_FILE = resolve(MENA_NAILS, "deploy/compose.yaml");

interface CatalogItem {
  readonly id: number;
  readonly displayLabel: string;
  readonly quantityModel: "tip" | "pieces" | "pots" | "container";
  readonly isColor: boolean;
}
interface StockEntry {
  readonly itemId: number;
  readonly label: string;
  readonly units: number | null;
  readonly movementUnits?: number;
}
interface ServiceResult {
  readonly logId: number;
  readonly replayed: boolean;
  readonly movements: readonly { readonly itemId: number; readonly unitsDelta: number }[];
}

const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (condition) {
    console.log(`[ok] ${label}`);
  } else {
    failures.push(label);
    console.log(`[FAIL] ${label}`);
  }
}

function skip(reason: string): never {
  console.error(`[skip] ${reason}`);
  process.exit(2);
}

function compose(args: string[], env: NodeJS.ProcessEnv, inherit = false): string {
  const result = spawnSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
    cwd: MENA_NAILS,
    env,
    encoding: "utf8",
    ...(inherit ? { stdio: "inherit" } : {}),
  });
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

async function http<T>(
  method: "GET" | "POST",
  path: string,
  options: { token?: string; csrf?: string; origin?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.trim()}`);
  }
  return (text.trim().length === 0 ? undefined : JSON.parse(text)) as T;
}

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API}/readyz`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`the API did not become ready at ${API}/readyz within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    skip("docker is not available (no daemon)");
  }
  if (!existsSync(COMPOSE_FILE)) {
    skip(`mena-nails compose not found at ${COMPOSE_FILE} (set MENA_NAILS_PATH)`);
  }
  if (spawnSync("python3", ["-c", "import bcrypt"], { stdio: "ignore" }).status !== 0) {
    skip("python3 with the bcrypt module is required to seed an owner password hash");
  }

  const passwordHash = execFileSync(
    "python3",
    [
      "-c",
      "import bcrypt,sys; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt()).decode())",
      OWNER_PASSWORD,
    ],
    { encoding: "utf8" },
  ).trim();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OWNER_PASSWORD_BCRYPT_HASH: passwordHash,
    OWNER_SESSION_SECRET: randomBytes(32).toString("hex"),
    API_ALLOWED_ORIGIN: ORIGIN,
    API_SERVICE_TOKENS: `assistant:${createHash("sha256").update(SERVICE_TOKEN).digest("hex")}`,
    API_RUNTIME_GUARD: "off",
  };

  console.log(`[e2e] bringing up ${PROJECT} from ${MENA_NAILS} (this builds the API image)…`);
  compose(["up", "-d", "--build"], env, true);
  await waitForReady(180_000);
  console.log("[e2e] API ready; seeding the catalog");
  compose(["--profile", "seed", "run", "--rm", "seed"], env, true);

  // ── owner session ────────────────────────────────────────────────────────
  const session = await http<{ accessToken: string; csrfToken: string }>("POST", "/auth/login", {
    origin: ORIGIN,
    body: { password: OWNER_PASSWORD },
  });
  const owner = { token: session.accessToken, csrf: session.csrfToken };

  const catalog = await http<CatalogItem[]>("GET", "/catalog/items", { token: owner.token });
  const color = catalog.find((item) => item.isColor && item.quantityModel === "container");
  const tips = catalog.find((item) => item.quantityModel === "tip");
  if (!color || !tips) {
    throw new Error("the seeded catalog has no colour or tip item to run the chain against");
  }
  console.log(
    `[e2e] catalog: ${catalog.length} items · colour=${color.id} ${color.displayLabel} · tip=${tips.id} ${tips.displayLabel}`,
  );

  // ── confirm a stocktake so GET /stock is not empty ──────────────────────
  // Owner writes need BOTH the exact browser Origin and the CSRF token.
  const run = await http<{ runId: number; version: number }>("POST", "/stocktake/runs", {
    token: owner.token,
    csrf: owner.csrf,
    origin: ORIGIN,
  });
  for (const item of catalog) {
    const exact =
      item.quantityModel === "tip" ||
      item.quantityModel === "pieces" ||
      item.quantityModel === "pots";
    await http("POST", "/stocktake/observations", {
      token: owner.token,
      csrf: owner.csrf,
      origin: ORIGIN,
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
  await http("POST", "/stocktake/confirm", {
    token: owner.token,
    csrf: owner.csrf,
    origin: ORIGIN,
    body: { runId: run.runId, version: run.version },
  });
  console.log(`[e2e] stocktake ${run.runId}/${run.version} confirmed over ${catalog.length} items`);

  // ── the acceptance: retried service log must not deduct twice ────────────
  const readStock = async (): Promise<
    Map<number, { units: number | null; movementUnits: number }>
  > => {
    const { items } = await http<{ items: StockEntry[] }>("GET", "/stock", {
      token: SERVICE_TOKEN,
    });
    return new Map(
      items.map((item) => [
        item.itemId,
        { units: item.units, movementUnits: item.movementUnits ?? 0 },
      ]),
    );
  };

  const body = {
    serviceKey: "soft_gel",
    colorItemId: color.id,
    tips: [{ itemId: tips.id, units: 10 }],
    sourceAppointmentId: SOURCE_APPOINTMENT_ID,
  };

  const before = await readStock();
  const first = await http<ServiceResult>("POST", "/services", { token: SERVICE_TOKEN, body });
  const afterFirst = await readStock();
  const second = await http<ServiceResult>("POST", "/services", { token: SERVICE_TOKEN, body });
  const afterSecond = await readStock();

  console.log(
    `[e2e] first  logId=${first.logId} replayed=${first.replayed} movements=${JSON.stringify(first.movements)}`,
  );
  console.log(`[e2e] second logId=${second.logId} replayed=${second.replayed}`);

  check(first.replayed === false, "the first service log is a real write");
  check(second.replayed === true, "the retried service log is reported as replayed");
  check(second.logId === first.logId, "the retry returns the original log id");
  check(
    JSON.stringify(second.movements) === JSON.stringify(first.movements),
    "the retry replays the same movement set instead of a new one",
  );
  check(
    first.movements.some((movement) => movement.itemId === tips.id && movement.unitsDelta === -10),
    "the first call consumed exactly ten tips",
  );

  const beforeColour = before.get(color.id);
  const afterFirstColour = afterFirst.get(color.id);
  const afterSecondColour = afterSecond.get(color.id);
  const beforeTip = before.get(tips.id);
  const afterFirstTip = afterFirst.get(tips.id);
  const afterSecondTip = afterSecond.get(tips.id);

  check(
    afterFirstTip?.units === (beforeTip?.units ?? 0) - 10,
    "GET /stock shows the tips consumed exactly once",
  );
  check(
    afterFirstTip?.movementUnits === -10,
    "the confirmed snapshot records a single -10 movement",
  );
  check(
    afterFirstColour?.units === beforeColour?.units,
    "containers (the colour) record no movement, as the recipe defines",
  );
  check(
    afterSecondTip?.units === afterFirstTip?.units &&
      afterSecondColour?.units === afterFirstColour?.units,
    "the retry changed nothing in stock",
  );
  check(
    JSON.stringify([...afterFirst.entries()]) === JSON.stringify([...afterSecond.entries()]),
    "the whole stock snapshot is identical across the retry",
  );
}

let crashed: unknown;
try {
  await main();
} catch (error) {
  crashed = error;
  console.error(`[e2e] error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (!KEEP) {
    const cleanupEnv: NodeJS.ProcessEnv = { ...process.env };
    try {
      console.log(`[e2e] tearing down ${PROJECT}`);
      compose(["down", "-v", "--remove-orphans"], cleanupEnv);
    } catch (error) {
      console.error(
        `[e2e] teardown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    console.log(`[e2e] --keep: leaving ${PROJECT} running`);
  }
}

if (crashed) process.exit(1);
if (failures.length > 0) {
  console.error(`[e2e] FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("[e2e] PASSED: a retried service log never deducts twice");
