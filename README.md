# mena-assistant

> - **What:** a Telegram assistant for a nail studio. The owner asks about bookings and stock; anything that writes is a proposal she confirms with a button.
> - **Status:** built for a freelance client, Mena Nails (May – Oct 2026, finished). Pre-launch: it is not running in production and has no usage data.
> - **Stack:** TypeScript on Node 24, pnpm 11, MCP SDK, grammY, OpenAI-compatible API, Zod, Vitest, GitHub Actions.
> - **Run without credentials:** `pnpm install && pnpm test && pnpm eval` (mock backends, scripted model).
> - **Related:** [receipt-verifier](https://github.com/Mateocas1/receipt-verifier) · [case study](https://mateocas1.github.io/portfolio/mena-nails.html)
> - **How it was built:** I design, decide and verify: I define the tests, the review criteria and the measurements. AI agents write much of the code under those tests and that review.

## What it does

The owner writes in a Telegram chat: "¿qué turnos tengo hoy?", "¿cuánto esmalte queda?", "cancelá el turno del viernes". The assistant answers with data from the booking and inventory APIs, which it reaches through MCP tools.

The LLM never writes on its own. Every write is a proposal with a one-use **Confirmar / Cancelar** button. The button expires and is bound to the chat that received it (`tests/proposal-store.test.ts`).

All names, phone numbers and appointments in fixtures, tests and evals are invented.

## How the model was chosen

I built an eval of 87 tool-calling cases and ran it against 6 LLMs on 2026-10-02 (results in `evals/results/2026-10-02-*.json`). The chosen model, qwen3.8-flash (`evals/results/2026-10-02-qwen3.8-flash.json`):

| Metric                    | Value                  |
| ------------------------- | ---------------------- |
| Tool selection            | 98.9 %                 |
| Arguments                 | 97.7 %                 |
| Invented tool or argument | 1.1 %                  |
| Cases fully passed        | 84 / 87 (96.6 %)       |
| Latency                   | p50 8.2 s / p95 17.2 s |

Tool selection and full passes are different numbers: 98.9 % is the share of cases where it picked the right tool; 84 of 87 cases passed every check. The full six-model table is under [Model comparison](#model-comparison).

The CI runs the same 87 cases with a **scripted mock model**, not a real one. That run pins tool selection and date handling so regressions fail in CI. Its result (87/87, tool 100 %) is the scripted mock passing, not a measure of model quality. Live comparisons need an API key and never run in CI:

```bash
pnpm eval                          # 87 cases, scripted mock model + mock backends, deterministic, in CI
pnpm eval:smoke                    # 16-case subset (path-filtered workflow)
pnpm eval:compare --models a,b,c   # live comparison (needs LLM_API_KEY)
```

## Run it locally

Requirements: Node 24 or newer (`engines`, CI uses 24) and pnpm 11.11.0 (`packageManager`).

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck
pnpm test          # 383 Vitest tests in 38 files
pnpm eval          # scripted mock model, 87 cases
```

None of these needs a credential: `TURNOS_BACKEND` and `STOCK_BACKEND` default to `mock`, which serve fixtures anchored on today's date in Buenos Aires time.

The MCP server also runs against the mock backends. It never calls Telegram or the LLM, but config validation still requires the three variables, so placeholders are enough:

```bash
TELEGRAM_BOT_TOKEN=unused TELEGRAM_ALLOWLIST=1:romi LLM_API_KEY=unused MCP_PROFILE=romi pnpm mcp
```

The Telegram bot itself (`pnpm dev`) needs a real `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWLIST` and `LLM_API_KEY`; copy `.env.example` and see [Environment variables](#environment-variables).

## Tests

`pnpm test` runs 383 Vitest tests in 38 files. CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, tests, the scripted eval and the build on every push to `main` and on pull requests. Neither workflow reads a secret or a repository variable.

## Limits

- Not running in production and no usage data.
- The eval set is 87 hand-written cases, not real conversations.
- Repeated live runs moved single models by 1 to 3 cases, so small gaps between models are ties.
- Cost per model is not measured: no prices are configured.

## Architecture

```
Telegram (Romi, Mateo)
      │  long polling (grammy)
      ▼
┌──────────────────────────────────────────────────────────────┐
│ bot (this repo)                                              │
│  1. allowlist chat_id → profile (romi | mateo)                │
│     └─ unknown chat: no reply, no LLM call, no tool call     │
│  2. LLM tool loop (OpenAI-compatible, ≤6 tool calls/turn)    │
│     └─ only the tools that profile may see                   │
│  3. audit (JSON lines, PII redacted)                         │
│  4. scheduler: 08:00 ART summary + health probe              │
└───────────────┬──────────────────────────────────────────────┘
                │ MCP (stdio) / in-process tool registry
                ▼
┌──────────────────────────────────────────────────────────────┐
│ mena-assistant-mcp                                           │
│  ├─ turnos.*  → 30a backend: TURNOS_BACKEND=http (real)     │
│  │              or mock fixtures (dev/CI)                    │
│  ├─ stock.*   → mena-nails API Go        [FEATURE_STOCK]     │
│  └─ tareas.*  → Firestore Admin (Mateo)  [FEATURE_TAREAS]    │
│  + proposals (Confirm/Cancel) + audit + ART timezone + PII   │
└──────────────────────────────────────────────────────────────┘
```

Write tools never reach the backend from the model. They return a proposal
(`proposal_id`, human summary, diff); only a callback from the originating
`chat_id`, before expiry and used once, runs the adapter call.

## Layout

```
src/
  config.ts             Zod-parsed env, fail fast on invalid config
  index.ts              entrypoint: bot, --check, --healthcheck
  health.ts             liveness heartbeat + offline run modes
  bot/
    allowlist.ts        chat_id → profile + tool permission globs
    core.ts             message + callback decision logic (fully tested)
    index.ts            grammy adapter (inline keyboard, callbacks)
  mcp/
    registry.ts         tool definitions + profile filtering + OpenAI specs
    server.ts           MCP server over the filtered registry
    main.ts             stdio MCP entrypoint
    tools/turnos.ts     turnos.* tools (6 reads + 1 confirmation-gated write)
  llm/
    types.ts            transport seam (real client or scripted in tests)
    openai-transport.ts OpenAI-compatible client (LLM_BASE_URL/API_KEY/MODEL)
    loop.ts             bounded tool loop (retry, timeout, fallback, cap 6)
    prompt.ts           system prompt (ART dates, injection, no writes)
  adapters/
    turnos/client.ts    contract types + typed errors
    turnos/http.ts      real /assistant/* client (retry, timeout, Zod)
    turnos/mock.ts      fixture backend with the same semantics
    turnos/fixtures.ts  fixtures anchored on the clock's ART day
    stock/              mena-nails client, mock, fixtures, service mapping
    tareas/             calendar model (copied), store, Firestore Admin adapter
  telemetry/tracer.ts   OTLP spans (bot turn → LLM → tool → HTTP), PII redacted
  proposals/store.ts    proposal registry (expiry + single use + chat bound)
  audit/                JSONL audit, PII redaction, file sink
  metrics/usage.ts      queries per profile per ISO week
  schedule/             daily 08:00 ART summary + debounced health alerts
  time/                 America/Argentina/Buenos_Aires + injectable clock
evals/                  40-case dataset, scripted (CI) and live runners
scripts/metrics.ts      pnpm metrics CLI
evals/compare.ts        live model comparison + README table
evals/prices.json       per-model price table (no prices filled in)
docs/case-study.md      portfolio write-up (results sections are TODO)
e2e/stock-idempotency.ts  compose e2e: a retried service log never deducts twice
tests/                  vitest suites
Dockerfile              multi-stage, non-root, node dist/index.js
compose.assistant.yml   assistant service snippet for the VM compose
```

## Environment variables

| Variable                        | Default                       | Purpose                                                            |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`            | — (required)                  | BotFather token.                                                   |
| `TELEGRAM_ALLOWLIST`            | — (required)                  | `chatId:profile` list; profiles `romi` / `mateo`.                  |
| `LLM_BASE_URL`                  | `https://api.nan.builders/v1` | OpenAI-compatible base URL.                                        |
| `LLM_API_KEY`                   | — (required)                  | Provider key.                                                      |
| `LLM_MODEL`                     | `qwen3.8-flash`               | Primary model. **Changing model = changing this var.**             |
| `LLM_FALLBACK_MODEL`            | `deepseek-v4-flash`           | Retried when the primary call fails.                               |
| `LLM_TIMEOUT_MS`                | `30000`                       | Per-call timeout.                                                  |
| `LLM_MAX_TOOL_CALLS`            | `6`                           | Hard cap of tool calls per conversation turn.                      |
| `TURNOS_BACKEND`                | `mock`                        | `mock` (fixtures) or `http` (real `/assistant/*`).                 |
| `ASSISTANT_API_BASE_URL`        | —                             | Convex `.convex.site` origin; required with `http`.                |
| `ASSISTANT_TOKEN`               | —                             | Bearer token for `/assistant/*`; required with `http`.             |
| `TURNOS_TIMEOUT_MS`             | `10000`                       | Per-request timeout for the booking backend.                       |
| `FEATURE_TURNOS`                | `true`                        | Registers `turnos.*`.                                              |
| `FEATURE_STOCK`                 | `false`                       | Registers `stock.*`.                                               |
| `FEATURE_TAREAS`                | `false`                       | Registers `tareas.*` (Mateo only).                                 |
| `PROPOSAL_TTL_MINUTES`          | `10`                          | Proposal lifetime before the Confirm button dies.                  |
| `AUDIT_LOG_FILE`                | — (stdout)                    | Appends the JSONL audit log there; read by `pnpm metrics`.         |
| `HEALTH_FILE`                   | `/tmp/mena-assistant-alive`   | Heartbeat file for the offline container healthcheck.              |
| `HEALTH_INTERVAL_SECONDS`       | `30`                          | Heartbeat interval; three missed beats = unhealthy.                |
| `DAILY_SUMMARY_ENABLED`         | `true`                        | Pushes the 08:00 ART summary to allow-listed chats.                |
| `DAILY_SUMMARY_HOUR`            | `8`                           | Summary hour in ART (0–23).                                        |
| `HEALTH_ALERT_ENABLED`          | `false`                       | Polls the backend and alerts Mateo on an outage.                   |
| `HEALTH_ALERT_INTERVAL_SECONDS` | `300`                         | Health probe interval.                                             |
| `HEALTH_ALERT_FAILURES`         | `3`                           | Consecutive failures before the single alert.                      |
| `HEALTH_ALERT_CHAT_ID`          | first `mateo` chat            | Where health alerts go.                                            |
| `TAREAS_BACKEND`                | `mock`                        | `mock` or `firestore` (Mateo's planner).                           |
| `MATEO_FIREBASE_UID`            | —                             | Required with `firestore`; the adapter only touches `users/{uid}`. |
| `FIREBASE_PROJECT_ID`           | —                             | Optional Admin SDK project override.                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | — (off)                       | Enables OTLP trace export when set.                                |
| `MCP_PROFILE`                   | `mateo`                       | Profile the standalone MCP server acts as.                         |
| `STOCK_BACKEND`                 | `mock`                        | `mock` (fixtures) or `http` (mena-nails API).                      |
| `MENA_NAILS_API_URL`            | —                             | mena-nails API origin; required with `http`.                       |
| `MENA_NAILS_TOKEN`              | —                             | Service credential (`svc_...`); required with `http`.              |
| `MENA_NAILS_TIMEOUT_MS`         | `10000`                       | Per-request timeout for the stock API.                             |
| `STOCK_ALERT_ENABLED`           | `false`                       | Deduped push when a new item drops below threshold.                |
| `STOCK_ALERT_INTERVAL_SECONDS`  | `1800`                        | Stock alert poll interval.                                         |
| `STOCK_ALERT_CHAT_ID`           | first `romi` chat             | Where stock alerts go.                                             |

Invalid configuration fails fast at startup with the offending variables named
(`node dist/index.js --check` validates without starting the bot).

## Tools

| Tool                                                        | Kind                 | Backend route it mirrors                        |
| ----------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| `turnos.del_dia(fecha?)`                                    | read                 | `POST /assistant/appointments/today` or `/day`  |
| `turnos.rango(desde?, hasta?)`                              | read                 | `POST /assistant/appointments/range` (≤31 days) |
| `turnos.disponibilidad(fecha?)`                             | read                 | `POST /assistant/availability`                  |
| `turnos.servicios()`                                        | read                 | `POST /assistant/services`                      |
| `turnos.pagos_pendientes()`                                 | read                 | `/verifications/pending` + `/refunds/summary`   |
| `turnos.resumen(fecha?)`                                    | read                 | `POST /assistant/summary`                       |
| `turnos.marcar_completado(appointmentId, fecha?)`           | **write → proposal** | `POST /assistant/appointments/complete`         |
| `turnos.cancelar(appointmentId, motivo?, fecha?)`           | **write → proposal** | `POST /assistant/appointments/cancel`           |
| `turnos.bloquear(fecha, hora?, motivo?, dia_completo?)`     | **write → proposal** | `POST /assistant/blocks/create`                 |
| `turnos.desbloquear(blockedSlotId, fecha?, hora?)`          | **write → proposal** | `POST /assistant/blocks/remove`                 |
| `turnos.crear_para_clienta(cliente, telefono, servicio, …)` | **write → proposal** | `POST /assistant/appointments/create`           |
| `turnos.reprogramar(appointmentId, fecha, hora, …)`         | **write → proposal** | `POST /assistant/appointments/reschedule`       |
| `pagos.confirmar_transferencia(verificationId)`             | **write → proposal** | `POST /assistant/transfers/confirm`             |
| `pagos.rechazar_transferencia(verificationId, motivo)`      | **write → proposal** | `POST /assistant/transfers/reject`              |
| `stock.actual()`                                            | read                 | `GET /stock`                                    |
| `stock.alertas()`                                           | read                 | `GET /stock` (alert = low)                      |
| `stock.servicios_recientes(limit?)`                         | read                 | `GET /services?limit=N`                         |
| `stock.precios()`                                           | read                 | `GET /services/prices`                          |
| `stock.catalogo(solo_colores?)`                             | read                 | `GET /catalog/items`                            |
| `stock.registrar_servicio(servicio, colorItemId, tips?, …)` | **write → proposal** | `POST /services` (idempotent)                   |
| `stock.proponer_correccion(tema, detalle)`                  | read (advisory)      | — (never calls the API)                         |

Dates accept `YYYY-MM-DD`, `hoy` / `mañana` / `pasado mañana` / `ayer`, weekday
names (`el jueves`) and `esta semana` / `la semana que viene` (ranges), always
resolved in `America/Argentina/Buenos_Aires` by the time module. The model never
does date math: every date tool's description carries fresh ART anchors
(`hoy=…`, `mañana=…`, `esta semana=…`) and the tool resolves whatever phrase
comes back.

### Proposal → Confirm flow

1. The model calls a write tool; the tool validates its inputs with Zod, reads
   whatever current state it needs, and stores a proposal (10 min TTL) with a
   code-built Spanish summary and diff — the LLM never writes them. It returns
   `{ proposal_id, summary, diff, requires_confirmation: true }`.
2. The bot sends the summary + diff with an inline `✅ Confirmar` /
   `❌ Cancelar` keyboard.
3. On callback the store validates, in order: the proposal exists, is not
   consumed, is not expired, and belongs to the **same chat** (a wrong chat does
   not burn it). Only then does the write tool's `executeProposal` call the
   adapter — the backend HTTP write, always with `retry: false`. Replays, wrong
   chats and expired proposals execute nothing. Backend rejections (including
   HTTP 500 domain errors like "slot taken") become clear Spanish messages.

A turn ends as soon as it produces a proposal: the model is not asked again for
a closing line (`stoppedReason: proposal_ready`); its own text, if it wrote any,
or a fixed "confirmame" line goes above the buttons.

A turn proposes **at most one write**. Further write tool calls in the same turn
are refused (audited as `denied`) and answered with a tool result that tells the
model to ask for confirmation on the pending action first; reads keep working.

### Streaming and typing

While the model works the chat shows "escribiendo…" (renewed every 4 s,
allow-listed chats only). The model call is streamed: the first ~20 characters
of the reply open a message that is edited at most once per second, and the
final text replaces it. With reasoning models most of the wait happens before
the first character, so streaming mainly helps long answers.

### Conversation memory

Each chat keeps its last six exchanges in process memory, so an answer like
"Nude Glitter 118" is read against the question it answers. The last two
exchanges also replay their successful reads (today's appointments, the compact
catalog), so the next message does not spend a model round trip on them; write
results are never replayed. Before the model is called, the bot also runs
`turnos.del_dia` (today) and `stock.catalogo` itself and hands their results in
as if the model had asked (audited with `detail: "preload"`); a failed preload is
skipped and the model can still call the tool. A chat is forgotten after 30 idle minutes, when a proposal
is cancelled, and when one is confirmed — except a confirmed completion, which
restarts the chat from the stock question. Nothing is persisted; a restart
starts every chat over. Each `llm_turn` audit entry records `latencyMs` and
`modelCalls`.

## Stock (mena-nails)

With `FEATURE_STOCK=true` (and `STOCK_BACKEND=http` in production) the assistant
reads the salon's stock over the internal network using a scoped service
credential, and closes the loop from a finished appointment:

1. Romi confirms `turnos.marcar_completado`. The tool maps the booking service to
   a mena-nails key (`servicio-softgel` → `soft_gel`, `capping`,
   `semipermanente`); `retiro-*` consumes nothing and is not registered.
2. The bot asks only for what the appointment does not carry: the colour
   (`stock.catalogo`) and, for Soft Gel, the tips: 10 units in total, usually
   across several sizes (one allocation per tip item, e.g. 4 of size 3 and 6 of
   size 5). The proposal lists each size with its units.
3. The model proposes `stock.registrar_servicio` with
   `sourceAppointmentId` = the appointment id; Romi confirms; the API call runs
   with `retry: false`.
4. An identical retry replays (`replayed: true`, "ya estaba registrado"); the
   same appointment with different data returns 409 and changes nothing.

**Rules taken from the mena-nails roadmap:** the bot never changes counts or
prices. There is no stocktake or price tool for any profile — the assistant
exposes `stock.proponer_correccion`, which returns advisory text and calls no
endpoint, and directing Romi to the mena-nails panel. A test asserts no profile
(including Mateo) can see a forbidden operation.

### E2E: a retried service log never deducts twice

```bash
pnpm e2e:stock          # requires Docker + a mena-nails checkout
```

It brings up the mena-nails stack under the compose project `m3e2e` (never
touching other containers), seeds the catalog, confirms a stocktake, posts the
SAME service log twice with the same `sourceAppointmentId`, and asserts that
`GET /stock` is identical between the two calls while the first one did move
stock. It tears the stack down afterwards (`--keep` leaves it running). Paths
and port: `MENA_NAILS_PATH` (default `../mena-nails`) and `M3E2E_API_PORT`
(default `8080`, matching mena-nails' compose).

### Catalog reads over the service credential

mena-nails PR #158 added `GET /catalog/items` to the service-credential
allowlist (`serviceRouteAllowed` in `apps/api/internal/server/access.go`), so
`stock.catalogo` now returns item ids, labels and quantity models with the
assistant's `MENA_NAILS_TOKEN` instead of answering `403`. Catalog _changes_
stay owner-only: the credential is read-only there.

## MCP server

```bash
pnpm mcp        # stdio; register it in any MCP client
```

The MCP surface is filtered by `MCP_PROFILE`. Write tools there still only
return proposals — an external MCP client cannot press Telegram's Confirm
button, so its proposals expire unless confirmed from the bot.

## Security rules (non-negotiable)

1. **Chat allowlist with per-chat permissions.** Unknown chats get no reply, no
   LLM call and no tool call (audited without message content). The LLM only
   ever receives the tools a profile may call: `romi` → `turnos.*`, `pagos.*`,
   `stock.*`; `mateo` → everything, including `tareas.*`.
2. **The LLM never writes.** Write tools return a proposal; only a verified
   Telegram callback (same `chat_id`, unexpired, single use) executes it.
3. **Audit.** Every tool call is a JSON line with profile, tool, PII-redacted
   args, status, latency, model and tokens.
4. **Service tokens per backend**, least-privilege and rotable; never user
   credentials.
5. **PII minimisation.** Short client name only; never phone or email. The audit
   redacts phone/email keys and phone- or email-shaped values.
6. **Prompt injection.** Tool data is data, not instructions, and writes always
   require human confirmation.
7. **Timezone.** Every today/tomorrow/this-week calculation uses
   `America/Argentina/Buenos_Aires`, never UTC.

## Model comparison

The table below is regenerated by `pnpm eval:compare --models a,b,c` (needs
`LLM_API_KEY`; never run in CI) and rebuilt from the stored files in
`evals/results/` by `pnpm eval:compare --render` (no API call), so a sweep can run
one model at a time and still publish together. The published row set is the
second full sweep of `2026-10-02`: 87 cases × 6 models, `EVAL_RPM=30`, mock
backends, dataset clock fixed at `2026-01-14T15:00:00Z`.

Columns: **Tool** = share of scored cases where the expected tool was actually
invoked; **Args** = share of tool-matched cases whose declared arguments passed
the semantic comparison in `evals/args.ts` (dates resolved through the ART clock,
documented defaults treated as omitted, text compared insensitive to
case/accents/spaces); **Fabricados** = share of cases that invented a tool or ran
one where none was expected; **Propuestas** = share of write cases answered with
a proposal instead of an execution; **p50/p95** = per-call latency.

<!-- model-comparison:start -->

| Modelo              | Tool  | Args  | Fabricados | Propuestas | p50      | p95      | Tokens (in/out) | Costo |
| ------------------- | ----- | ----- | ---------- | ---------- | -------- | -------- | --------------- | ----- |
| `glm5.3-flash`      | 98.9% | 95.4% | 1.1%       | 100.0%     | 17114 ms | 37569 ms | 853184/20885    | n/d   |
| `qwen3.8-flash`     | 98.9% | 97.7% | 1.1%       | 100.0%     | 8193 ms  | 17237 ms | 946673/23923    | n/d   |
| `deepseek-v4-flash` | 97.7% | 96.6% | 1.1%       | 96.2%      | 7747 ms  | 16284 ms | 978729/23930    | n/d   |
| `mimo-v2.6-flash`   | 97.7% | 95.4% | 1.1%       | 100.0%     | 14975 ms | 41796 ms | 941782/16301    | n/d   |
| `qwen3.6`           | 96.6% | 93.1% | 1.1%       | 100.0%     | 5840 ms  | 26560 ms | 901572/40540    | n/d   |
| `gemma4`            | 94.0% | 94.0% | 1.2%       | 92.3%      | 6162 ms  | 25161 ms | 634959/26652    | n/d   |

> Cost is `n/d` for every model: `evals/prices.json` has no prices.
> gemma4: 4 cases hit the provider rate limit and are excluded from its accuracy.

<!-- model-comparison:end -->

**Default and fallback, by data.** `qwen3.8-flash` is the default and
`deepseek-v4-flash` the fallback (`LLM_MODEL` / `LLM_FALLBACK_MODEL`). Both sweeps
agree on the top of the table: `qwen3.8-flash` scored 97.7–98.9% tool and
95.4–97.7% args with 100% of write cases proposed, and `deepseek-v4-flash` scored
97.7% tool and 96.6–97.7% args with the lowest p50 (6.7–7.7 s). `qwen3.8-flash`
gets the default for the best argument accuracy and a clean write-proposal record;
`deepseek-v4-flash` gets the fallback for its consistently fast first response
(and no documented protocol caveat). Every model except `gemma4` cleared the 90%
tool target.

Two things to read with care. First, run-to-run noise is real: repeated sweeps
moved single models by 1–3 cases and by tens of seconds at p95, so treat small
gaps as ties. Second, the comparison is deliberately strict about free-text
reasons (`motivo`): `está duplicado` and `Comprobante duplicado` score as a
mismatch. That costs 1–3 of 87 cases for four of the six models and is reported
here instead of being loosened, because a looser rule risks accepting a wrong
reason.

## License

No license is granted. All rights reserved.
