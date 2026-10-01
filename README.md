# mena-assistant

Telegram assistant for Mena Nails: an MCP server with tools over the booking
backend, an LLM tool-calling loop, chat allowlist + permission profiles, an
audit log, ART time handling, and a confirmation flow so **the LLM never
writes**.

Romi (the salon owner) asks in a Telegram chat — "¿qué turnos tengo hoy?",
"¿qué horarios quedan el jueves?", "cancelá el turno de Laura del viernes" —
and the assistant answers with real data and, for anything that mutates, returns
a **proposal** she confirms with an inline **Confirmar / Cancelar** button.

**Status: M0 (skeleton).** Reads run against a fixture-backed mock that mirrors
the real `test-kimi` `/assistant/*` contract shapes, so M1 only swaps the
transport. `stock.*` and `tareas.*` are disabled stubs behind feature flags.

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
└───────────────┬──────────────────────────────────────────────┘
                │ MCP (stdio) / in-process tool registry
                ▼
┌──────────────────────────────────────────────────────────────┐
│ mena-assistant-mcp                                           │
│  ├─ turnos.*  → 30a backend (M0: mock fixtures)              │
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
  index.ts              bot entrypoint (long polling)
  bot/
    allowlist.ts        chat_id → profile + tool permission globs
    core.ts             message + callback decision logic (fully tested)
    index.ts            grammy adapter (inline keyboard, callbacks)
  mcp/
    registry.ts         tool definitions + profile filtering + OpenAI specs
    server.ts           MCP server over the filtered registry
    main.ts             stdio MCP entrypoint
    tools/turnos.ts     turnos.* tools (3 reads + 1 confirmation-gated write)
  llm/
    types.ts            transport seam (real client or scripted in tests)
    openai-transport.ts OpenAI-compatible client (LLM_BASE_URL/API_KEY/MODEL)
    loop.ts             bounded tool loop (retry, timeout, fallback, cap 6)
    prompt.ts           system prompt (ART dates, injection, no writes)
  adapters/
    turnos/             client interface, fixtures, mock backend
    stock/ tareas/      disabled stubs behind feature flags
  proposals/store.ts    proposal registry (expiry + single use + chat bound)
  audit/                JSON-line audit, PII redaction
  time/                 America/Argentina/Buenos_Aires + injectable clock
evals/                  20-case dataset, scripted (CI) and live runners
tests/                  vitest suites
```

## Quick start (mock backend)

Requirements: Node 24 and pnpm 11.

```bash
pnpm install
cp .env.example .env      # fill in the values below
pnpm test                 # 90 tests
pnpm eval                 # 20/20 (scripted, deterministic)
pnpm dev                  # long polling with the mock backend
```

With `TURNOS_ADAPTER=mock` (the default) no external backend is needed: the
three read tools serve fixtures anchored on today's ART date.

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

| Variable               | Default                       | Purpose                                                |
| ---------------------- | ----------------------------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`   | — (required)                  | BotFather token.                                       |
| `TELEGRAM_ALLOWLIST`   | — (required)                  | `chatId:profile` list; profiles `romi` / `mateo`.       |
| `LLM_BASE_URL`         | `https://api.nan.builders/v1` | OpenAI-compatible base URL.                            |
| `LLM_API_KEY`          | — (required)                  | Provider key.                                          |
| `LLM_MODEL`            | `deepseek-v4-flash`           | Primary model. **Changing model = changing this var.** |
| `LLM_FALLBACK_MODEL`   | `glm5.3-flash`                | Retried when the primary call fails.                   |
| `LLM_TIMEOUT_MS`       | `30000`                       | Per-call timeout.                                      |
| `LLM_MAX_TOOL_CALLS`   | `6`                           | Hard cap of tool calls per conversation turn.          |
| `TURNOS_ADAPTER`       | `mock`                        | `mock` in M0; `http` (30a) lands in M1.                |
| `ASSISTANT_BASE_URL`   | —                             | Required when `TURNOS_ADAPTER=http`.                   |
| `ASSISTANT_TOKEN`      | —                             | Bearer token for `/assistant/*`; required with `http`. |
| `FEATURE_TURNOS`       | `true`                        | Registers `turnos.*`.                                  |
| `FEATURE_STOCK`        | `false`                       | Registers `stock.*` (stub until M3).                   |
| `FEATURE_TAREAS`       | `false`                       | Registers `tareas.*` (Mateo only; stub until M5).      |
| `PROPOSAL_TTL_MINUTES` | `10`                          | Proposal lifetime before the Confirm button dies.      |
| `MCP_PROFILE`          | `mateo`                       | Profile the standalone MCP server acts as.             |

Invalid configuration fails fast at startup with the offending variables named.

## Tools (M0)

| Tool                                              | Kind                 | Backend route it mirrors              |
| ------------------------------------------------- | -------------------- | ------------------------------------- |
| `turnos.del_dia(fecha?)`                          | read                 | `POST /assistant/appointments/day`    |
| `turnos.disponibilidad(fecha)`                    | read                 | `POST /assistant/availability`        |
| `turnos.servicios()`                              | read                 | `POST /assistant/services`            |
| `turnos.cancelar(appointmentId, motivo?, fecha?)` | **write → proposal** | `POST /assistant/appointments/cancel` |

`fecha` accepts `YYYY-MM-DD` or `hoy` / `mañana` / `ayer`, always resolved in
`America/Argentina/Buenos_Aires`.

### Proposal → Confirm flow

1. The model calls `turnos.cancelar`; the tool stores a proposal (10 min TTL)
   and returns `{ proposal_id, summary, diff, requires_confirmation: true }`.
2. The bot sends the summary + diff with an inline `✅ Confirmar` /
   `❌ Cancelar` keyboard.
3. On callback the store validates, in order: the proposal exists, is not
   consumed, is not expired, and belongs to the **same chat** (a wrong chat does
   not burn it). Only then does the write tool's `executeProposal` call the
   adapter. Replays, wrong chats and expired proposals execute nothing.

A turn proposes **at most one write**. Further write tool calls in the same turn
are refused (audited as `denied`) and answered with a tool result that tells the
model to ask for confirmation on the pending action first; reads keep working.

## MCP server

```bash
pnpm mcp        # stdio; register it in Claude Desktop or your agent
```

The MCP surface is filtered by `MCP_PROFILE`. Write tools there still only
return proposals — an external MCP client cannot press Telegram's Confirm
button, so its proposals expire unless confirmed from the bot.

## Evals

```bash
pnpm eval        # 20 cases, scripted transport + mock backend, deterministic, in CI
pnpm eval:live   # same dataset against a real model (needs LLM_API_KEY; never in CI)
```

Current result: **20/20 passed · tool accuracy 100.0% · args accuracy 100.0%**
(scripted). The scripted transport is not a model-quality measurement: it pins
tool selection and ART argument resolution so regressions fail in CI. Model
comparison (`deepseek-v4-flash` vs `qwen3.8-flash` vs `glm5.3-flash` vs
`qwen3.6`) runs through `eval:live` and belongs to M4.

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
pnpm lint && pnpm typecheck && pnpm test && pnpm eval
```

`.github/workflows/ci.yml` pins every action by SHA and runs format check, lint,
typecheck, tests, evals (mock) and build on Node 24.

## Provider notes (checked against NaN's public docs)

Checked against <https://nan.builders/docs/models>:

- `deepseek-v4-flash` (default) and `glm5.3-flash` (fallback) are real ids on
  the OpenAI-compatible `https://api.nan.builders/v1` base URL, and both
  advertise standard function calling.
- Caveats worth knowing before M1:
  - `qwen3.8-flash` documents tool calling in **XML format**, not OpenAI
    `function.arguments`, so as a fallback it may return XML text instead of
    structured `tool_calls`. That is why the fallback default is
    `glm5.3-flash`; if you switch back to `qwen3.8-flash`, validate it with
    `pnpm eval:live` first.
  - `deepseek-v4-flash` raises any `max_tokens` below 16384 to 16384, rejects
    `response_format: json_schema` with a 400, and needs the word `JSON` in the
    prompt for `json_object`. This client does not set `max_tokens` or
    `response_format`, so none of that applies today.
  - Monthly quotas are per member (3B tokens for `deepseek-v4-flash`, 500M for
    `qwen3.8-flash`, 2B for `glm5.3-flash`). Rate limits were not stated on the
    pages read.
- **Not yet verified by a live call:** `pnpm eval:live` was not run here (no
  `LLM_API_KEY`), so real tool-calling behaviour, latency and cost are unmeasured.
  The four-way model comparison belongs to M4.

## Next step (M1)

Implement `HttpTurnosClient` against `test-kimi` `/assistant/*` using the
existing `TurnosClient` interface and response shapes, flip
`TURNOS_ADAPTER=http`, add the remaining reads (`turnos.rango`,
`turnos.pagos_pendientes`, `turnos.resumen`) and pick the model with live evals.
