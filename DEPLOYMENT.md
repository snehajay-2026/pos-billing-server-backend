# Deployment notes

This document covers deploying the backend to **Vercel** with MySQL on
**Railway** (or any managed MySQL provider). The frontend living in
`pos-billing-ui-frontend` also deploys to Vercel separately; configure
`REACT_APP_API_BASE` to point at the backend URL.

## Topology

```
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  Vercel             │    │  Vercel             │    │  Railway            │
│  (frontend)         │    │  (backend)          │    │  (MySQL plugin)     │
│  pos-billing-ui-…   │◀──▶│  pos-billing-server-…│◀──▶│  pos_billing        │
│  port 443 (https)   │    │  port 443 (https)   │    │  port 3306          │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
        React app              Express server            MySQL 8
```

## One-time setup

1. **Railway — provision MySQL.**
   - Create a new Railway project.
   - Add the **MySQL** plugin. Note the connection string Railway
     shows as `MYSQL_URL` (formatted as
     `mysql://user:password@host:port/dbname`).
   - Connect the project to a GitHub repo so it can run migrations
     automatically (recommended) or apply the schema manually via a
     Railway shell.

2. **Apply the schema.**
   - From a local shell (or a Railway shell), apply the DDL:
     ```bash
     mysql "$(railway variables get MYSQL_URL)" < db/schema/001_initial_ddl.sql
     ```
   - That's it — Railway already created the database and user, so the
     localhost bootstrap file (`002_bootstrap_local.sql`) is **not**
     needed.

3. **Run the data loader once** (only if you have JSON data to import).
   ```bash
   railway run --service mysql bash
   # In the shell:
   cd ../your-server-clone
   railway run node scripts/load-json-to-mysql.js
   ```
   Or, from your local machine with `MYSQL_URL` overridden in env:
   ```bash
   MYSQL_URL="mysql://..." node scripts/load-json-to-mysql.js
   ```
   The loader expects each `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD`
   / `DB_NAME` env var individually. If your tooling only exposes
   `MYSQL_URL`, parse it once and export the parts before invoking the
   loader:
   ```bash
   # Pseudocode
   MYSQL_URL=$MYSQL_URL node -e "..."  # extract into DB_* vars
   node scripts/load-json-to-mysql.js
   ```

4. **Vercel — deploy the backend.**
   - In Vercel, click **"Add New Project"** → import
     `snehajay-2026/pos-billing-server-backend`.
   - **Framework Preset**: "Other" (do not pick Next.js).
   - **Root Directory**: `server` (the repo's `server/` folder).
   - **Build Command**: leave blank (Vercel doesn't need to bundle
     Node for serverless deployments).
   - **Output Directory**: leave blank.
   - Vercel detects `server/vercel.json` automatically and uses the
     `@vercel/node` builder.

5. **Vercel — set environment variables.** In the project's
   Settings → Environment Variables, add the same five as `server/.env`:
   - `DB_HOST` — Railway's MySQL hostname (e.g. `containers-us-west-123.railway.app`)
   - `DB_PORT` — `3306`
   - `DB_USER` — from Railway
   - `DB_PASSWORD` — from Railway
   - `DB_NAME` — `railway` (default DB name on Railway)
   - `FRONTEND_ORIGIN` — your deployed UI URL (e.g. `https://pos-billing-ui-frontend.vercel.app`)
   - `PORT` — leave unset; Vercel injects its own

6. **Vercel — deploy the frontend.**
   - In Vercel, add a second project from
     `snehajay-2026/pos-billing-ui-frontend`.
   - **Framework Preset**: "Create React App".
   - **Root Directory**: leave as `.` (the repo root).
   - **Environment Variable**:
     `REACT_APP_API_BASE=https://your-backend.vercel.app` (the URL Vercel
     assigned to the backend project).
   - Vercel runs `npm run build` automatically and serves `build/`.

## After deploy

1. **Verify the backend is reachable:**
   ```bash
   curl https://your-backend.vercel.app/api/register/available
   # → {"available":false,"isFirstUser":false}
   ```
   The `false` value confirms MySQL connected (it ran `SELECT COUNT(*) FROM users`).

2. **Open the frontend** in your browser. Try logging in. Open
   DevTools → Network; a 200 on `/api/login` confirms the frontend-to-backend
   wiring is correct.

3. **Check CORS** if the frontend gets a 401/403:
   - The backend's CORS allowlist (in `server/index.js`) accepts
     `localhost:3000`, `127.0.0.1`, and the `FRONTEND_ORIGIN` env var.
   - Add the deployed frontend URL to `FRONTEND_ORIGIN` on Vercel.

## Schema migrations after the first deploy

When the schema needs to change:

1. Edit `db/schema/001_initial_ddl.sql` (or add a new numbered file).
2. Push to the `pos-billing-db-mysql` repo (the source of truth).
3. Apply the new SQL to the live MySQL:
   ```bash
   mysql "$(railway variables get MYSQL_URL)" < db/schema/001_initial_ddl.sql
   ```
   `CREATE TABLE IF NOT EXISTS` keeps it idempotent.
4. Mirror the change in `server/db/queries/<table>.js`.

## Local dev against the deployed DB

Point your local `server/.env` at the Railway MySQL instead of
`localhost`. Now you can develop the server locally while the schema and
data live on Railway — useful for debugging prod-shaped issues.

## Cost

- **Vercel**: free tier covers both projects (UI + server) for moderate
  usage.
- **Railway MySQL**: $5/month credit covers most small POS workloads
  (the free trial credit expires after the trial period).
- **Total**: $0 during trials, ~$5/month once you outgrow them.

## Rollback

If something goes wrong:

- **Backend**: redeploy a previous commit on Vercel (instant).
- **Frontend**: same.
- **Database**: take a Railway snapshot before each migration. To roll
  back, restore the snapshot and re-apply the previous schema version.
- **Combined**: with Vercel + Railway, rollback is a redeploy + a
  snapshot restore; no long-running infrastructure to coordinate.

## Notes

- **Vercel serverless functions are stateless.** All session state
  lives in MySQL — no warm-up needed, no sync issues between lambda
  invocations.
- **Cold starts matter less than you'd think.** Vercel keeps the
  function warm after the first request; first request may take ~500ms.
- **MySQL connection limits.** The default pool size is 10. If Vercel
  spins up multiple concurrent lambdas, you may need to bump that or
  use a connection pooler like PgBouncer (MySQL equivalent: ProxySQL).
  For a single-store POS, 10 is plenty.