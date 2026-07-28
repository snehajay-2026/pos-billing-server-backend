# Database migration plan (MySQL)

This folder holds the **target** MySQL schema for the backend. It is **not yet
wired into the running server** — `server/index.js` still reads/writes JSON
files under `server/data/`. The schema is staged here so the data layer can
be migrated in a single coherent change later.

## What's here

| File | Status | Purpose |
| --- | --- | --- |
| `schema.sql` | drafted, not applied | Full MySQL DDL: 13 tables mirroring `server/data/*.json` plus the new `shifts`, `shift_cash_movements`, `payment_intents`, `audit_log` tables. |

## What's still needed before this can run

1. **MySQL instance + credentials.** Create `pos_billing` database and the
   dedicated `pos_billing_app` user (already in `schema.sql`). Replace
   `'CHANGE_ME_app_password'` before running in any real environment; use a
   `schema.local.sql` overlay that's gitignored.
2. **Driver.** Add `mysql2` (with `promisePool`) to `server/package.json`.
3. **Connection pool.** Create `server/db/pool.js` reading `DB_HOST`,
   `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` from `server/.env`.
4. **Route migration.** Replace every `readJson` / `writeJson` call in
   `server/index.js` with a MySQL query. Roughly 15 routes are affected
   (users, products, services, expenses, orders, invoices, customers,
   customer_credits, notifications, store_settings, hotel_state, sessions).
5. **Atomic checkout transaction.** The current `/api/invoices/checkout`
   handler validates + decrements stock + writes the invoice in three
   separate file writes. The MySQL version wraps this in
   `START TRANSACTION` + `SELECT ... FOR UPDATE` on `products`.
6. **New surfaces.** The schema introduces four tables the backend has no
   routes for yet: `shifts`, `shift_cash_movements`, `payment_intents`,
   `audit_log`. The frontend already calls `/api/shifts/*` and has a
   `paymentService`; once routes exist they light up immediately.
7. **Data migration.** On first boot, bulk-`INSERT IGNORE` each
   `server/data/*.json` into the matching table. Archive the JSON files
   under `server/data/archive/` so they can't drift back out of sync.
8. **Cleanup.** Drop `readJson` / `writeJson` / `pendingWrites` from
   `server/index.js` once nothing references them.

## Stages (in order)

```
0. Decide scope (driver, target DB, keep JSON as seed source)
1. Apply schema.sql as MySQL root
2. Wire server/.env + server/db/pool.js
3. Migrate routes in server/index.js, one resource at a time
4. Convert /api/invoices/checkout to a transaction
5. Add /api/shifts/*, /api/payment-intents/*, audit-log writer
6. First-boot JSON → MySQL loader
7. Cutover: stop the JSON-backed instance, restart with MySQL
8. Drop JSON helpers, archive the JSON files
```

Stages 0–8 are detailed in the conversation history; the relevant code
locations are noted in `server/index.js` (`readJson`, `writeJson`,
`pendingWrites`, `/api/invoices/checkout`).