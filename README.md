# mena-assistant

Telegram assistant for Mena Nails: an MCP server with tools over the booking
backend, an LLM tool-calling loop, chat allowlist + permission profiles, an
audit log, ART time handling, and a confirmation flow so **the LLM never
writes**.

Romi (the salon owner) asks in a Telegram chat — "¿qué turnos tengo hoy?",
"¿qué horarios quedan el jueves?", "cancelá el turno de Laura del viernes" —
and the assistant answers with real data and, for anything that mutates, returns
a **proposal** she confirms with an inline **Confirmar / Cancelar** button.

**Status: M4 (evals, traces, planner).** The `turnos.*` / `pagos.*`
tools run against the real `mena-nails-turnos` (`test-kimi`) `/assistant/*` HTTP
actions when `TURNOS_BACKEND=http`, or against a fixture-backed mock that mirrors
the same contract shapes (`mock`, the dev/CI default). Every write is
confirm-gated. An in-process scheduler sends the 08:00 ART daily summary and debounced backend
health/stock alerts. With `FEATURE_STOCK` the assistant reads mena-nails stock and
closes the "completed appointment → service log" chain; with `FEATURE_TAREAS`
Mateo's own planner is available to his chat only. OpenTelemetry spans are
exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

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
│  ├─ stock.*   → mena-nails API Go        [FEATURE_STOCK, M3] │
│  └─ tareas.*  → Firestore Admin (Mateo)  [FEATURE_TAREAS, M5]│
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
evals/prices.json       per-model price table ([VERIFY] where unknown)
docs/case-study.md      portfolio write-up (results sections are TODO)
e2e/stock-idempotency.ts  compose e2e: a retried service log never deducts twice
tests/                  vitest suites
Dockerfile              multi-stage, non-root, node dist/index.js
compose.assistant.yml   assistant service snippet for the VM compose
```

## Quick start (mock backend)

Requirements: Node 24 and pnpm 11.

```bash
pnpm install
cp .env.example .env      # fill in the values below
pnpm test                 # 285 tests
pnpm eval                 # 87/87 (scripted, deterministic)
pnpm dev                  # long polling with the mock backend
```

With `TURNOS_BACKEND=mock` (the default) no external backend is needed: the read
tools serve fixtures anchored on today's ART date. Point
`TURNOS_BACKEND=http` + `ASSISTANT_API_BASE_URL` + `ASSISTANT_TOKEN` at the real
`/assistant/*` actions to read production data.

### Create the Telegram bot and get chat ids

1. Talk to [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and
   a username ending in `bot`. BotFather replies with the **token** →
   `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`. Or talk
   to [@userinfobot](https://t.me/userinfobot), which replies with your id.
3. Put the ids in `TELEGRAM_ALLOWLIST`, one `chatId:profile` pair per chat, e.g.
   `TELEGRAM_ALLOWLIST=123456789:romi,987654321:mateo`. Profiles are `romi`
   (turnos, pagos, stock) and `mateo` (everything, including `tareas.*`).
4. Any chat that is **not** listed gets no reply, no LLM call and no tool call;
   the drop is audited with a hashed chat id and no message content.

## Environment variables

| Variable                        | Default                       | Purpose                                                            |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`            | — (required)                  | BotFather token.                                                   |
| `TELEGRAM_ALLOWLIST`            | — (required)                  | `chatId:profile` list; profiles `romi` / `mateo`.                   |
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
| `FEATURE_STOCK`                 | `false`                       | Registers `stock.*` (stub until M3).                               |
| `FEATURE_TAREAS`                | `false`                       | Registers `tareas.*` (Mateo only; stub until M5).                  |
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
| `STOCK_ALERT_CHAT_ID`           | first `romi` chat              | Where stock alerts go.                                             |

Invalid configuration fails fast at startup with the offending variables named
(`node dist/index.js --check` validates without starting the bot).

## Tools (M3)

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

A turn proposes **at most one write**. Further write tool calls in the same turn
are refused (audited as `denied`) and answered with a tool result that tells the
model to ask for confirmation on the pending action first; reads keep working.

### Conversation memory

Each chat keeps its last six exchanges (the visible text only, no tool results)
in process memory, so an answer like "Nude Glitter 118" is read against the
question it answers. A chat is forgotten after 30 idle minutes, when a proposal
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

## Daily summary (08:00 ART)

An in-process scheduler (no external cron) computes the next 08:00 in
`America/Argentina/Buenos_Aires` from the injected clock and sends one message
per allow-listed chat, built from reads only — no LLM:

```
☀️ Buenos días — resumen del 2026-01-14

Turnos: 3 (1 confirmed, 1 paid, 1 cancelled) · Seña facturada: $24000
- 08:00 · Servicio Soft Gel · Ana G. (confirmed)
- 14:00 · Servicio Capping · Laura P. (paid)

Pagos por revisar: 2
- 2026-01-14 08:00 · Ana G. · $12500 (pending)
Reintegros pendientes: 1 · $5000
```

Romi gets the day's appointments, the pending verifications and the refund
summary; with `FEATURE_STOCK` the message also lists the items below their
threshold. Mateo gets the same plus a `tareas` placeholder while `FEATURE_TAREAS`
is off. If the backend is down the scheduler skips silently and audits
`daily_summary / backend_unavailable` instead of sending a broken message.
`DAILY_SUMMARY_ENABLED=false` turns it off and `DAILY_SUMMARY_HOUR` moves it.

## Health alerts

With `HEALTH_ALERT_ENABLED=true` the process polls the cheapest read
(`turnos.servicios`) every `HEALTH_ALERT_INTERVAL_SECONDS`. After
`HEALTH_ALERT_FAILURES` consecutive failures it sends **one** message to Mateo's
chat and **one** recovery message when the backend answers again — a single
hiccup never spams. Off by default in dev.

## Push alerts belong to mena-nails-turnos

Convex already sends the Telegram admin alerts at the source (transfer to
review, orphan/duplicate payment, dispute, cancellation, calendar failure), so
the assistant does **not** duplicate them. Both may use the same bot token:
Convex only calls `sendMessage`, while the assistant is the only `getUpdates`
consumer, so long polling never competes.

## MCP server

```bash
pnpm mcp        # stdio; register it in Claude Desktop or your agent
```

The MCP surface is filtered by `MCP_PROFILE`. Write tools there still only
return proposals — an external MCP client cannot press Telegram's Confirm
button, so its proposals expire unless confirmed from the bot.

## Evals

```bash
pnpm eval        # 87 cases, scripted transport + mock backend, deterministic, in CI
pnpm eval:smoke  # the ~16 `smoke` cases only (path-filtered CI workflow)
pnpm eval:compare --models a,b,c   # live model comparison (needs LLM_API_KEY; never in CI)
pnpm eval:live   # same dataset against a real model (needs LLM_API_KEY; never in CI)
```

Current result: **87/87 passed · tool 100.0% · args 100.0% · hallucinated 0.0% · write proposals 100.0%**
(scripted). The scripted transport is not a model-quality measurement: it pins
tool selection and ART argument resolution so regressions fail in CI. Live model
selection is measured by `pnpm eval:compare` over six models — see
[Model comparison](#model-comparison).

## Metrics

The bot writes one JSON line per event (see audit below). When `AUDIT_LOG_FILE`
is set, it appends there; `pnpm metrics` reads that file and reports queries and
tool calls per profile per ISO week (ART calendar, e.g. `2026-W03`), plus dropped
chats. It is what proves "Romi uses it weekly":

```bash
pnpm metrics ./audit.log
# profile  week       queries   tools
# romi      2026-W03        12      20
#
# dropped chats: 0
# weeks with queries: 1 — the assistant is in weekly use
```

## Deploy

The assistant runs **next to the backend, on the mena-nails VM**, inside the
production compose (PRD 25). Long polling means it needs no public ingress, and
the backend is reached over the internal Docker network — no published ports.

1. Copy this repo next to the mena-nails compose (e.g. `./mena-assistant`).
2. Create `./secrets/assistant.env` (mode `600`, never committed) with the
   Telegram token and allowlist, `LLM_API_KEY`, `TURNOS_BACKEND=http`,
   `ASSISTANT_API_BASE_URL` (the Convex `.convex.site` origin) and
   `ASSISTANT_TOKEN`.
3. Merge `compose.assistant.yml` into the compose already running on the VM (or
   pass it as an extra `-f` sharing the `internal` network) and `docker compose
up -d assistant`.

The image is a multi-stage build that compiles with `pnpm build`, prunes dev
dependencies and runs `node dist/index.js` as the non-root `assistant` user:

```bash
docker build -t mena-assistant:m1 .
docker run --rm --env-file ./secrets/assistant.env mena-assistant:m1 \
  node dist/index.js --check          # config only: no Telegram, no network
```

The `HEALTHCHECK` is offline too: the process touches `HEALTH_FILE` every
`HEALTH_INTERVAL_SECONDS` and `node dist/index.js --healthcheck` fails when the
heartbeat is missing or older than three intervals. Secrets never enter the
image; they come from `env_file` on the VM.

Rollback: `docker compose up -d assistant` with the previous image tag, or
`TURNOS_BACKEND=mock` to fall back to fixtures without redeploying code.

## Traces (optional)

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the process exports OpenTelemetry spans
over OTLP HTTP: `bot.turn` → `llm.call` (one per model call) → `tool.call`, and
from each HTTP adapter an `http.request` span with the backend and path. Span
attributes go through the same redaction as the audit log, so a client phone or
email never reaches the collector. Unset (the default) keeps the API's no-op
tracer: nothing is recorded and the SDK is never loaded.

## Mateo's planner (`tareas.*`)

`FEATURE_TAREAS` registers four tools for **Mateo's chat only**: the permission
profile hides them from Romi, a test asserts it, and every handler re-checks the
profile.

| Tool                                  | Kind                 | Notes                                            |
| ------------------------------------- | -------------------- | ------------------------------------------------ |
| `tareas.listar()`                     | read                 | open tasks with their deadlines                  |
| `tareas.agenda(fecha?)`               | read                 | blocks + expanded series occurrences + tasks due |
| `tareas.crear(titulo, fecha_limite?)` | **write → proposal** | validated with the calendar's own rules          |
| `tareas.completar(occurrenceId)`      | **write → proposal** | one immutable completion per occurrence          |

The domain validations are copied from `calendar/app/src/domain/model.ts` (with a
source note; no cross-repo import) so the assistant writes exactly the shapes that
app already accepts. The Firestore Admin adapter is structurally confined to
`users/{MATEO_FIREBASE_UID}`: a single `documentPath()` builds every path.
`TAREAS_BACKEND=mock` (the default) keeps the planner in memory for development
and CI; `firestore` resolves the Admin SDK lazily on the first tool call, so the
process starts without credentials.

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

## Testing and CI

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm eval && pnpm build
```

`.github/workflows/ci.yml` pins every action by SHA and runs format check, lint,
typecheck, tests, evals (mock) and build on Node 24.

## Provider notes (checked against NaN's public docs)

Checked against <https://nan.builders/docs/models>:

- `qwen3.8-flash` (default) and `deepseek-v4-flash` (fallback) are real ids on
  the OpenAI-compatible `https://api.nan.builders/v1` base URL, and both
  advertise standard function calling.
- Caveats worth knowing:
  - The docs describe `qwen3.8-flash` tool calling as **XML format**, not OpenAI
    `function.arguments`. The live comparison did not see that: over 174 measured
    cases in two full sweeps it always returned structured `tool_calls` (98.9%
    tool accuracy, 100% of write cases proposed). Treat the caveat as unverified
    for this client, and re-check with `pnpm eval:live` before relying on a new
    behaviour.
  - `glm5.3-flash` answered slowly in both sweeps (p95 38–44 s, above the 30 s
    `LLM_TIMEOUT_MS`), and `gemma4` timed out often enough to trip the provider's
    concurrency cap and lose 4–7 cases per sweep. Neither is a safe default.
  - `deepseek-v4-flash` raises any `max_tokens` below 16384 to 16384, rejects
    `response_format: json_schema` with a 400, and needs the word `JSON` in the
    prompt for `json_object`. This client does not set `max_tokens` or
    `response_format`, so none of that applies today.
  - Monthly quotas are per member (3B tokens for `deepseek-v4-flash`, 500M for
    `qwen3.8-flash`, 2B for `glm5.3-flash`). Rate limits were not stated on the
    pages read; the live runs were throttled client-side (`EVAL_RPM=30`).
- **Verified by a live run:** `pnpm eval:compare` measured all six ids over the
  87-case dataset (two full sweeps, `2026-10-02`). Real tool-calling behaviour,
  latency and token use are in the table below; cost is still `n/d` because the
  NaN pricing page was never read.

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

> USD per 1M tokens. Values marked [VERIFY] are unknown: confirm them in the NaN dashboard before publishing a cost table. The comparison runner prints 'n/d' for a model without prices instead of inventing one.
> Sin precios configurados para: deepseek-v4-flash, gemma4, glm5.3-flash, mimo-v2.6-flash, qwen3.6, qwen3.8-flash.
> Casos salteados por rate limit, excluidos de la precisión: gemma4 (4).

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

## Next step

What M4 still needs from the human side: a few weeks of real use for the
case-study metrics and growing the dataset toward the PRD's 50–100 real cases.
The default/fallback pair is now measured, not guessed (see
[Model comparison](#model-comparison)). Cost remains unmeasured: `evals/prices.json`
still needs the real NaN prices. M5 (optional) is multimodal input: receipt photos
and Romi's voice notes. `turnos.sincronizar_precios` remains out of scope:
mena-nails owns prices.
