# Database layer (MySQL)

This folder holds the **MySQL data layer** for the backend server.

## What's here

| Path | Purpose |
| --- | --- |
| `pool.js` | mysql2 connection pool. Reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` from `server/.env`. Exports `query()`, `withTransaction()`, `closePool()`. |
| `queries/*.js` | One module per table (`users`, `products`, `services`, `expenses`, `orders`, `invoices`, `customers`, `customer-credits`, `notifications`, `store-settings`, `hotel`, `sessions`). Each module owns its table's CRUD and exposes a uniform `{list, findById, findByIdScoped, create, update, deleteById}` shape. |
| `schema/` | The MySQL schema, split into two files (see below). This folder is intended to live in a separate repo (`pos-billing-db-mysql`) once the deployment is finalized. |
| `README.md` | This file. |

## Schema files

```
schema/
├── 001_initial_ddl.sql       # Pure CREATE TABLE statements. Always safe to apply.
└── 002_bootstrap_local.sql  # Localhost-only: CREATE DATABASE + CREATE USER + GRANT.
```

The split exists because **managed MySQL providers** (Railway, PlanetScale,
Aiven, Render) create the database and user for you. So:

- **Localhost**: apply both, in order.
- **Managed MySQL**: apply only `001_initial_ddl.sql`.

## Applying the schema

### Localhost

```bash
# As MySQL root:
mysql -u root -p < schema/002_bootstrap_local.sql
mysql -u root -p < schema/001_initial_ddl.sql
```

Edit the `CREATE USER` line in `002_bootstrap_local.sql` to set a real
password before running (the placeholder is `CHANGE_ME_app_password`).
The same password goes in `server/.env` as `DB_PASSWORD`.

### Railway (managed MySQL)

1. In the Railway dashboard, add a **MySQL plugin** to your project.
2. Once provisioned, Railway shows a `MYSQL_URL` connection string.
3. From your local machine (or a Railway shell), apply the DDL:

```bash
mysql "$(railway variables get MYSQL_URL)" < schema/001_initial_ddl.sql
```

4. In your server's environment, set the `DB_*` variables from
   `MYSQL_URL`. The format Railway uses is
   `mysql://user:password@host:port/dbname`, which needs splitting into
   `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. The
   `db/pool.js` setup reads these four variables plus `DB_HOST`. If
   you'd rather consume `MYSQL_URL` directly, swap `dotenv` for a small
   URL parser in your server entry point.

### PlanetScale / Aiven / Render

Same as Railway — apply `001_initial_ddl.sql` against the connection
URL the provider gives you. PlanetScale notably doesn't allow
`CREATE USER` (it manages users itself) and skips foreign keys, but our
schema uses neither.

## Idempotency

Every `CREATE TABLE` uses `IF NOT EXISTS`. Re-running any of these
scripts is safe.

## Schema versioning (forward-looking)

If/when the schema needs to evolve, add a new numbered file
(`002_add_payment_intents.sql`, etc.) rather than editing the existing
ones. This matches the convention used by every migration tool (Flyway,
Liquibase, knex, prisma) and lets you track what changed and when.

## Schema source of truth

The schema here is the source of truth. When column names or shapes
change, update `schema/001_initial_ddl.sql` first, then mirror the
change in the corresponding `db/queries/<table>.js` module. Tests
should cover both.

## Data migration

`scripts/load-json-to-mysql.js` (in the server repo) bulk-imports the
archived `server/data/archive-<date>/*.json` files into MySQL on first
boot. Run once per environment after applying the schema:

```bash
node scripts/load-json-to-mysql.js
```

Optional flags: `--dry-run` (read JSONs and report counts, no writes),
`--no-archive` (don't move JSON files), `--only=users,products` (load
specific tables only).

## Tables (current schema)

| # | Table | Notes |
| --- | --- | --- |
| 1 | `users` | bcrypt-hashed passwords, role enum |
| 2 | `products` | DECIMAL stock (kg items), scope columns for multi-tenant filtering |
| 3 | `services` | hourly-rate catalog |
| 4 | `expenses` | free-form |
| 5 | `orders` | laundry / service orders, JSON items column |
| 6 | `invoices` | receipts, JSON discount breakdown |
| 7 | `store_settings` | scope-keyed config (`global`, `store-settings:<type>:<id>`) |
| 8 | `hotel_state` | singleton row, JSON columns for the six hotel sub-resources |
| 9 | `sessions` | row-per-session, expires_at filter at read time |
| 10 | `customers` | CRM |
| 11 | `customer_credits` | store-scoped credit balances |
| 12 | `notifications` | per-user feed |
| 13 | `shifts` | open / close shift cycles (no routes yet) |
| 14 | `shift_cash_movements` | cash in/out during a shift (no routes yet) |
| 15 | `payment_intents` | UPI / card intents (no routes yet) |
| 16 | `audit_log` | append-only activity feed (no routes yet) |

The last four tables are **schema-only**: no API routes exist for them
yet. They're documented here so the deploy target is complete; routes
are follow-up work.