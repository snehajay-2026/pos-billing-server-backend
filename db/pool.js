// server/db/pool.js
//
// Thin wrapper around mysql2's promise pool. Reads DB_* from process.env
// (populated by dotenv in index.js), creates a single shared pool, and
// exports:
//   - query(sql, params) — single SELECT/INSERT/UPDATE/DELETE
//   - withTransaction(fn) — BEGIN/COMMIT/ROLLBACK around a callback that
//                            receives a connection for sequential queries
//   - closePool() — graceful shutdown, called from the existing
//                    SIGINT/SIGTERM handlers once the HTTP server stops
//                    accepting connections
//
// Notes:
//   - timezone: 'Z' so DATETIME(3) columns round-trip as UTC ISO strings
//     rather than getting silently re-stringified to local time.
//   - dateStrings: true keeps DATETIME columns as strings instead of
//     coercing to JS Date (which loses sub-millisecond precision and
//     forces the app to think about timezones everywhere).
//   - enableKeepAlive + keepAliveInitialDelay help long-lived pool
//     connections survive MySQL's wait_timeout (default 8h).
//   - decimalNumbers: false so DECIMAL columns come back as strings —
//     prevents silent precision loss on prices/stock.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mysql = require("mysql2/promise");

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
  timezone: "Z",
  dateStrings: true,
  decimalNumbers: false,
  // Multi-statement support is OFF by default; turning it on is a SQLi
  // vector if any caller passes user input straight into a query. We keep
  // it disabled and rely on withTransaction() for atomic batches.
  multipleStatements: false,
};

// TLS support — required by TiDB Cloud, Aiven, PlanetScale, and most
// managed MySQL providers. Local MySQL doesn't have TLS, so we only
// enable it when DB_SSL=true is set in env.
//
// `rejectUnauthorized: false` because TiDB Cloud rotates certificates
// and uses a public CA chain; the driver doesn't ship with the
// intermediate CAs, so strict verification fails. The TLS tunnel still
// encrypts the connection — we're just trusting the server cert, same
// as mysqlsh / DBeaver defaults.
if (String(process.env.DB_SSL).toLowerCase() === "true") {
  config.ssl = {
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
  };
}

if (!config.user || !config.password || !config.database) {
  // Fail fast at boot rather than at the first query. The common cause
  // is server/.env missing or named wrong.
  throw new Error(
    "MySQL pool misconfigured: DB_USER, DB_PASSWORD, and DB_NAME must all be set (see server/.env)."
  );
}

const pool = mysql.createPool(config);

const query = (sql, params) => pool.query(sql, params);

// withTransaction(fn): fn receives a single connection, runs queries on
// it sequentially, and the helper commits on resolve or rolls back on
// throw. Use for atomic multi-step writes (e.g. /api/invoices/checkout).
const withTransaction = async (fn) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      // Surface both, but don't let the rollback error mask the original.
      console.error("Rollback failed:", rollbackErr);
    }
    throw err;
  } finally {
    conn.release();
  }
};

const closePool = () => pool.end();

module.exports = {
  pool,
  query,
  withTransaction,
  closePool,
};