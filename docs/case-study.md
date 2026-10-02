# Mena Nails assistant — case study

> Status: **skeleton**. The problem, architecture, security model, eval method and
> honest limits are written; the real-usage metrics and the published model table
> are TODOs that the scripts fill after a live period.

## Problem

Romi runs a one-person nail salon. Her bookings live in a web app, her stock lives
in a separate inventory system, and her personal planning lives in a third place.
Every operational question ("what do I have today?", "do I have free slots on
Thursday?", "is anything about to run out?") needs a computer that she is not
sitting in front of. The Telegram assistant exists so she can ask those questions
from her phone and act on them without opening three tools.

## What was built

A Telegram bot plus an MCP server in the same repository:

- Telegram long polling (grammy) for Romi and Mateo, with a per-chat allowlist and
  permission profiles.
- An OpenAI-compatible LLM loop that can call tools, capped at six tool calls per
  turn, with a primary and a fallback model configured by environment variables.
- Tools that read the real booking backend (appointments, availability, services,
  daily summary) and the real inventory API (stock, alerts, prices, catalog),
  plus confirmation-gated writes.
- An eight-o'clock ART daily summary and deduplicated operational alerts.

### Architecture

```
Telegram ──long polling──► bot (this repo)
                             │ allowlist → profile (romi | mateo)
                             │ LLM tool loop (bounded, PII-minimised)
                             │ proposals → Confirm/Cancel callbacks
                             │ scheduler: 08:00 ART summary, health + stock alerts
                             ▼
                    tool registry (per-profile filter)
                    ├── turnos.* / pagos.* → booking backend HTTP actions
                    ├── stock.*            → inventory API (service credential)
                    └── tareas.*           → Mateo's calendar (Firestore, own subtree)
```

## Security model

1. **Allowlist first.** An unknown chat gets no reply, no LLM call and no tool
   call; the drop is audited without message content.
2. **The LLM never writes.** Write tools return a proposal with a code-built
   Spanish summary and diff; only a callback from the originating chat, before
   expiry and used once, runs the adapter call, with retries disabled.
3. **Least privilege per backend.** Each backend has its own service credential,
   scoped to the routes it needs; no user credentials ever reach the assistant.
4. **PII minimisation.** Short client names only; phone and email are redacted
   from the audit log and never sent to the model.
5. **Tool output is data.** Injected instructions inside a client name or a note
   are treated as data, and a poisoned tool result still cannot produce a write.
6. **Time zone discipline.** Every relative date resolves in
   `America/Argentina/Buenos_Aires`, server-side.
7. **Advisory-only intelligence.** Stock counts and prices are changed in the
   inventory panel; the assistant can only recommend a review.

## Evaluation method

- A dataset of **87 realistic Spanish (Rioplatense) cases**: questions with typos,
  relative dates, short names, question-only cases and adversarial cases (prompt
  injection inside a tool result, "cancel it now without asking", Romi requesting
  Mateo's planner).
- The dataset runs against **mock backends and a fixed clock**, so a run is
  deterministic and free; the scripted transport is a regression harness, not a
  model-quality measurement.
- The same dataset runs against **real models** with
  `pnpm eval:compare --models a,b,c`, measuring: tool accuracy, argument accuracy,
  hallucinated-tool rate, correct write-proposal rate, p50/p95 latency, tokens and
  estimated cost.
- A ~16-case `smoke` subset runs in a path-filtered CI workflow on every change to
  prompts, tools or the dataset.

TODO(model table): run `pnpm eval:compare` with `LLM_API_KEY` and paste the
generated table here (the README carries the same table between markers).

TODO(dataset): grow the dataset toward the PRD's 50–100 real cases pulled from
actual conversations once Romi has used the assistant for a few weeks.

## Results

TODO(usage): queries per week, write proposals confirmed, and the two-week usage
window (`pnpm metrics` reads the JSONL audit log).

TODO(cost): tokens and cost per conversation per model, from the comparison run.

## Honest limits

- The comparison numbers are not a live-usage measurement; they are a fixed
  dataset, so they measure instruction-following on a known distribution.
- Model ids and prices on the provider are documented from its public pages, and
  price figures are marked `[VERIFY]` until confirmed.
- The assistant is read-mostly by design: stock counts, prices and anything the
  inventory roadmap reserves stay manual.
- Two backend gaps were found while building and are being fixed upstream: the
  inventory catalog read was missing from the service-credential allowlist
  (mena-nails#158), and the booking surface did not expose the payment id that
  transfer confirmation needs (merged in mena-nails-turnos#53).
- Latency and cost depend on the provider's rate limits, which are not published
  in the pages read.
