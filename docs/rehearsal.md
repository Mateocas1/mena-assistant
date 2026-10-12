# Local rehearsal

One command brings up the whole chain on this machine, pointed at a local
mena-nails, so the owner can try the bot and the panel before any VM exists.

| Piece                                      | Where it runs                                      | Origin                  |
| ------------------------------------------ | -------------------------------------------------- | ----------------------- |
| mena-nails API + PostgreSQL + seed         | Docker Compose project `mena-rehearsal`            | `http://127.0.0.1:8080` |
| mena-nails web (Vite dev)                  | host process, pid in `/tmp/mena-rehearsal/web.pid` | `http://localhost:5173` |
| mena-assistant bot (Telegram long polling) | host process, pid in `/tmp/mena-rehearsal/bot.pid` | outbound only           |
| Turnos backend                             | in-memory mock (see the Convex gap below)          | —                       |

```bash
scripts/rehearsal/up.sh        # stack + seed + web + bot, then health-check each one
scripts/rehearsal/status.sh    # API /readyz, compose services, web, bot heartbeat, getMe
scripts/rehearsal/down.sh      # stops bot, web and the compose stack (keeps the DB volume)
scripts/rehearsal/down.sh --purge   # also drops the PostgreSQL volume
```

`up.sh` is idempotent: a second run reuses the running stack, web server and bot.

## Secrets

| File                           | Mode | Contents                                                                                                                                                              |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/mena/rehearsal.env` | 600  | generated once by `up.sh`: memorable owner password, its bcrypt hash, session secret, `svc_` service token and its `assistant:<sha256>` digest, dev `ASSISTANT_TOKEN` |
| `~/.config/mena/telegram.env`  | 600  | owner-provided `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWLIST`                                                                                                             |
| `~/.pi/agent/auth.json`        | 600  | `.nan.key`, read at runtime for `LLM_API_KEY`                                                                                                                         |

Nothing secret is printed, written under the repo, or logged; delete
`~/.config/mena/rehearsal.env` to rotate every generated value at once.

## The first-run pitfalls `up.sh` removes

The owner's failed manual load was a setup pitfall, not a panel bug. All three
are silent in the UI until you look at the network tab:

| Pitfall                                                                            | What the owner sees                                                                                                                                                 | Evidence                                                                                                                                                                               | What `up.sh` does                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. `docker compose up` without `--profile seed` → empty catalog                    | `Inventario` starts a run with `0 de 0 contados`; `Confirmar recuento` answers _"La cuenta está incompleta: faltan productos por contar antes de poder confirmar."_ | API `POST /stocktake/confirm` → `409 stocktake count is not complete yet` (`apps/api/internal/server/stocktake_http.go:40`); message mapped in `apps/web/src/lib/api/stocktake.ts:122` | always starts with `--profile seed` and refuses to continue when `GET /catalog/items` is empty                            |
| 2. `OWNER_PASSWORD_BCRYPT_HASH` / `OWNER_SESSION_SECRET` not exported before `up`  | owner login on `Inventario` or `Ajustes` fails                                                                                                                      | `POST /auth/login` → `503 owner authentication is not configured` (`apps/api/internal/server/router.go:141`)                                                                           | generates both, exports them, and fails fast if login is not `200`                                                        |
| 3. web opened at `127.0.0.1:5173` while `API_ALLOWED_ORIGIN=http://localhost:5173` | every API call fails (CORS); login looks broken                                                                                                                     | `POST /auth/login` with `Origin: http://127.0.0.1:5173` → `403 origin rejected` (`apps/api/internal/server/auth.go:97`)                                                                | derives `API_ALLOWED_ORIGIN` from the exact origin it starts the web on (`localhost:5173`), and verifies it by logging in |
| 4. WSL + Docker Desktop `credsStore: desktop.exe`                                  | every build aborts with `error getting credentials`                                                                                                                 | `docker compose up --build` on this host                                                                                                                                               | switches to an anonymous `DOCKER_CONFIG` under `/tmp/mena-rehearsal/`                                                     |

## T3: reproducing "I tried to load the inventory manually from the page and it didn't let me"

With `up.sh` (seeded, credentials exported, matching origin) the whole manual
path works end to end, so the owner's report is caused by pitfall 1:

1. `http://localhost:5173/stocktake` → owner login → `200`, page shows the login
   form only when signed out.
2. `Ajustes` → new catalog item `Prueba Rehearsal 1` → status _"Artículo del
   catálogo creado."_ (`POST /catalog/items` `200`).
3. `Inventario` → `Iniciar recuento` → all 68 catalog items captured as
   `3 cerrados · lleno` or `100 unidades` → `Confirmar recuento` → _"Recuento
   confirmado; el stock actual refleja estas cantidades."_ `POST /stocktake/confirm` `200`, zero console errors (screenshot `/tmp/mena-t3/stocktake-confirmed.png`).

Reproduced on a stack started the way the README's _Local operation_ section
shows (`docker compose -f deploy/compose.yaml up -d --build`, no `--profile
seed`, catalog empty) the run starts but lists nothing to count and the server
rejects the confirmation with `409`, exactly as tabulated above. Nothing to fix
in mena-nails: the panel behaved correctly for an empty catalog.

## What was verified

```bash
pnpm test            # 331 tests, 34 files, all pass
pnpm lint            # ESLint: no issues
pnpm format:check    # all files formatted
pnpm e2e:stock       # PASSED: a retried service log never deducts twice
scripts/rehearsal/mcp-stock-smoke.ts   # two MCP calls, one deduction
scripts/rehearsal/status.sh            # exit 0: API /livez+/readyz 200, web 200, bot heartbeat fresh, getMe OK
```

`mcp-stock-smoke.ts` drives the real MCP server (`createMcpServer`) with the
stock backend the bot wires: it confirms a baseline stocktake, calls
`stock.registrar_servicio` twice for the same appointment (two proposals, no
write), then runs both proposals through the write tool's `executeProposal` —
the same call the bot's _Confirmar_ button makes. It asserts the first is a real
write, the retry is `replayed`, the log id matches, and the tips go `100 → 90`.

Telegram smoke: `up.sh` starts the bot, reads `getMe` through the Telegram API
without printing the token (`@robotitoo_bot`), and `status.sh` re-checks the
process heartbeat. The bot's _conversation_ was not exercised: no message was
sent from the owner's Telegram, so the reply flow is verified only by the unit
tests plus the MCP write path above.

## Morning checklist (owner)

1. `scripts/rehearsal/up.sh` — wait for `ready. Open http://localhost:5173`.
2. Open the panel at **`http://localhost:5173`** (not `127.0.0.1`), sign in with
   the password in `~/.config/mena/rehearsal.env` (`REHEARSAL_OWNER_PASSWORD`).
   The seeded catalog has 67 items; `Inventario` counts all of them.
3. From Telegram, message the bot (`@robotitoo_bot`) from an allow-listed
   account. Expected shapes:
   - _"¿qué turnos hay hoy?"_ → the list of today's appointments **from the
     in-memory mock** (real dates in ART, invented clients/services).
   - _"¿cómo está el stock?"_ → real numbers from the local mena-nails API
     (`stock.actual`), including low-stock alerts.
   - _"registrá el soft gel de ana, color Nude Glitter 118"_ → one question
     for whatever is missing (the tips, which may mix sizes: _"4 del 3 y 6 del
     5"_), never the colour again; answering it gives a proposal with
     the Spanish summary plus `✅ Confirmar` / `❌ Cancelar`. Tap **Confirmar** →
     _"Registrado…"_ and the tips drop by 10 in `Inventario` / `stock.actual`.
     Tapping Confirmar twice does not deduct twice.
   - Any other chat gets no reply at all.
4. `scripts/rehearsal/status.sh` if something looks stuck; `--purge` on
   `down.sh` gives a clean database for the next run.

## Turnos: the Convex dev deployment (known gap)

`up.sh` runs `TURNOS_BACKEND=mock` and warns about it. Reasons, in order:

- `test-kimi` is **not linked** to a deployment: no `.env.local`, no
  `convex.json`, so `npx convex dev --once` needs an interactive project
  selection (project `mena-nailss`) and cannot be driven non-interactively.
- `convex dev` also regenerates the tracked `convex/_generated/*` files, which
  would edit a repository this rehearsal is only allowed to run.
- `test-kimi` has no appointment seed (`convex/seed.ts` exports only
  `seedServices`), so "today's appointments" would have to be created by hand.

To attach it later, in the `test-kimi` checkout:

```bash
npx convex dev --once          # once, interactively: select project mena-nailss
npx convex env set ASSISTANT_TOKEN <dev token> --dev   # DEV deployment only
pnpm exec tsx /path/to/up.sh --turnos=http             # with ASSISTANT_API_BASE_URL=<dev .convex.site> and ASSISTANT_TOKEN exported
```

Never run a plain `convex deploy`, and never set these on the production
deployment (`loyal-terrier-188`).

## Go-live on the VM

Only the VM itself is missing. Everything below is a copy of a value that
already exists here; nothing in this repository needs a code change.

**mena-nails secrets — fill `deploy/.env.prod` on the VM** (template
`deploy/.env.prod.example`, `${VAR:?}` aborts on any missing value):

| Value                                                | Comes from here                                                 | Notes                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OWNER_PASSWORD_BCRYPT_HASH`, `OWNER_SESSION_SECRET` | a **new** owner password for production, hashed the same way    | keep the hash single-quoted, `$` is interpolated                                                           |
| `API_SERVICE_TOKENS`                                 | `cd apps/api && go run ./cmd/service-token assistant` on the VM | prints the `svc_` token once → goes to the assistant's `MENA_NAILS_TOKEN` and to the Convex prod env below |
| `API_ALLOWED_ORIGIN`, `VITE_PUBLIC_API_ORIGIN`       | the tailnet origin that serves the PWA                          | both the same origin with a single `tailscale serve` port                                                  |
| `POSTGRES_*`, `API_RUNTIME_*`, backup `BACKUP_*`     | generate on the VM                                              | see `deploy/README.md`                                                                                     |

**assistant secrets — `secrets/assistant.env` next to the mena-nails compose**
(see `compose.assistant.yml`):

| Value                                                               | Comes from here                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWLIST`                          | `~/.config/mena/telegram.env`                                                |
| `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`, `LLM_FALLBACK_MODEL`) | `~/.pi/agent/auth.json` `.nan.key`                                           |
| `MENA_NAILS_API_URL`, `MENA_NAILS_TOKEN`                            | the internal API URL on the VM and the `svc_` token from `cmd/service-token` |
| `ASSISTANT_API_BASE_URL`, `ASSISTANT_TOKEN`                         | the Convex **prod** `.convex.site` URL and the cutover token below           |
| `FEATURE_STOCK=true`, `STOCK_BACKEND=http`, `TURNOS_BACKEND=http`   | fixed values                                                                 |

**At cutover, on the Convex production deployment only** (`npx convex env set
<VARS> --prod`, never `convex deploy` for an unrelated change):

- `ASSISTANT_TOKEN` — the shared secret the bot sends as
  `Authorization: Bearer` to `/assistant/*`; must equal the bot's
  `ASSISTANT_TOKEN`.
- `MENA_NAILS_API_ORIGIN` and `MENA_NAILS_SERVICE_TOKEN` — read by
  `convex/priceSync.ts`. The token must be the same `svc_` credential whose
  `assistant:<sha256>` digest is in the VM's `API_SERVICE_TOKENS`.

These are documentation only: nothing in this rehearsal set, changed or read any
production Convex or mena-nails value.
