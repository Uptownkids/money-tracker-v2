# Money Tracker v2

Local-first personal finance tracker. React + TypeScript + Vite + Tailwind,
IndexedDB via Dexie. All money math in integer minor units — no floats.

## Setup

```bash
npm install
```

## Test

```bash
npx vitest run        # 90 tests: money math, dates, recurring engine,
                      # balances, safe-to-spend, payday runs, today's moves
```

## Run

```bash
npx vite              # dev server, opens the dashboard
```

## Build

```bash
npx vite build        # outputs to dist/
```

## Layout

- `src/domain/money/` — integer money math, currencies, FX
- `src/domain/dates/` — timezone-proof calendar dates (YYYY-MM-DD, UTC only)
- `src/domain/entities/` — Account, Transaction, RecurringRule, Goal, ...
- `src/domain/engine/` — recurring engine, balances, safe-to-spend calculator,
  Today's Moves ranking, payday runs
- `src/data/` — Dexie schema, repositories, v1 migration mapping
- `src/app/` + `src/components/` — dashboard UI (Phase 3)
- `test/` — Vitest suites

The app seeds clearly-labeled DEMO data on first launch; wipe it from the
demo banner in the UI.
