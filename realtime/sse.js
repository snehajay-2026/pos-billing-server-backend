// server/realtime/sse.js
//
// Server-Sent Events endpoint. Streams events from the in-process hub to
// the browser. Native EventSource on the client — no socket.io, no
// libraries, no WebSocket drama with proxies.
//
// One SSE connection per browser tab. The connection auto-reconnects
// on transient network drops; the server emits a "hello" frame so the
// client can confirm the channel is live.

const hub = require("./hub");

const SUPER_OWNER = "SUPER_OWNER";
const forbidden = (message) => {
  const error = new Error(message);
  error.status = 403;
  return error;
};

const scalarQueryValue = (value) => {
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    return String(value[0] || "").trim();
  }
  return value == null ? "" : String(value).trim();
};

const queryValue = (query, key) => {
  const provided = Object.prototype.hasOwnProperty.call(query || {}, key);
  if (!provided) return { provided: false, invalid: false, value: "" };
  const raw = query[key];
  if (Array.isArray(raw) && raw.length !== 1) {
    return { provided: true, invalid: true, value: "" };
  }
  return { provided: true, invalid: false, value: scalarQueryValue(raw) || "" };
};

const hasQueryValue = (query, key) => {
  const parameter = queryValue(query, key);
  return parameter.provided && (parameter.invalid || parameter.value !== "");
};

// Resolve the SSE scope from the authenticated session, not from client input.
// A SUPER_OWNER may retain the existing platform-wide stream or explicitly
// narrow it to a store. Every other role is bound to req.user's store scope;
// query parameters are only hints and can never widen that authorization.
const resolveAuthorizedScope = (req) => {
  const user = req && req.user;
  if (!user) throw forbidden("Authenticated user is required for realtime events");

  const query = req.query || {};
  const role = String(user.role || "").toUpperCase();
  const requestedStoreType = queryValue(query, "storeType");
  const requestedStoreId = queryValue(query, "storeId");
  const queryStoreType = requestedStoreType.value;
  const queryStoreId = requestedStoreId.value;

  // There is no branch_id/access-list model in the current users schema.
  // Reject any branch parameter, including ambiguous arrays, rather than
  // pretending it can authorize a branch or silently widening a store-level
  // subscription.
  if (hasQueryValue(query, "branchId")) {
    throw forbidden("Branch-scoped realtime access is not supported");
  }
  if (requestedStoreType.invalid || requestedStoreId.invalid) {
    throw forbidden("Realtime store scope parameters must be single values");
  }

  if (role === SUPER_OWNER) {
    // No storeType is the deliberate platform-wide SUPER_OWNER mode. A
    // storeId without a storeType is ambiguous and must not select a scope.
    if (!queryStoreType) {
      if (queryStoreId) {
        throw forbidden("storeType is required when selecting a store");
      }
      return {
        storeType: null,
        storeId: null,
        role,
        isGlobal: true,
      };
    }

    return {
      storeType: queryStoreType,
      storeId: queryStoreId || queryStoreType,
      role,
      isGlobal: false,
    };
  }

  const storeType = scalarQueryValue(user.storeType);
  const storeId = scalarQueryValue(user.storeId) || storeType;
  if (!storeType || !storeId) {
    throw forbidden("Authenticated user has no authorized store scope");
  }

  return {
    storeType,
    storeId,
    role,
    isGlobal: false,
  };
};

// Build only the channels authorized by resolveAuthorizedScope(). The global
// wildcard is intentionally available to an unscoped SUPER_OWNER only.
const buildDefaultChannel = ({ storeType, storeId, isGlobal }) => {
  if (isGlobal) return [hub.CHANNELS.ALL()];

  return [
    hub.CHANNELS.BOOKING(storeType, storeId),
    hub.CHANNELS.HOTEL(storeType, storeId),
    hub.CHANNELS.INVOICE(storeType, storeId),
    hub.CHANNELS.STOCK(storeType, storeId),
    hub.CHANNELS.SHIFT(storeType, storeId),
    hub.CHANNELS.ORDER(storeType, storeId),
    hub.CHANNELS.SERVICE(storeType, storeId),
    hub.CHANNELS.CUSTOMER(storeType, storeId),
    hub.CHANNELS.CUSTOMER_CREDIT(storeType, storeId),
    // Audit log channel — RecentActivity on admin tabs subscribes to
    // this so audit rows recorded in another tab show up live. Routed
    // per-(storeType, storeId) so cross-store leakage is structurally
    // impossible (the hub only fans out to listeners on the matching
    // channel).
    hub.CHANNELS.AUDIT(storeType, storeId),
  ];
};

const buildAuthorizedChannels = (req) =>
  buildDefaultChannel(resolveAuthorizedScope(req));

const eventMatchesChannels = (channels, event, scope) => {
  if (!event) return false;
  if (scope?.isGlobal && channels.includes(hub.CHANNELS.ALL())) return true;
  if (!scope?.storeType || !scope?.storeId) return false;
  return (
    channels.includes(event.channel) &&
    String(event.storeType || "") === String(scope.storeType) &&
    String(event.storeId || "") === String(scope.storeId)
  );
};

const sseHandler = (req, res) => {
  let scope;
  try {
    // ensureAuth normally supplies req.user at the route boundary. Keep this
    // check here too so direct reuse of the handler fails closed.
    scope = resolveAuthorizedScope(req);
  } catch (error) {
    const status = Number(error.status) || 403;
    return res.status(status).json({ error: error.message });
  }

  const channels = buildDefaultChannel(scope);

  // SSE response headers.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Vary Origin so CORS doesn't cache responses between origins.
  res.setHeader("Vary", "Origin");
  // CORS for the EventSource response — must echo the request origin.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Cache-Control");
  }
  // Commit headers + status code via writeHead, THEN flushHeaders.
  // Previously flushHeaders() was called first and writeHead(200) was
  // silently ignored (you can't call writeHead on an already-flushed
  // response), so the SSE stream returned an empty body.
  res.writeHead(200);
  res.flushHeaders();

  // Initial hello + recent-event replay so the client catches up
  // immediately on connect.
  res.write(`event: hello\ndata: ${JSON.stringify({ channels, ts: Date.now() })}\n\n`);

  // Replay only events authorized by this connection. Global replay is
  // possible only because resolveAuthorizedScope() granted SUPER_OWNER's
  // platform-wide mode; scoped users match their explicit channels only.
  for (const ev of hub.recentEvents) {
    if (eventMatchesChannels(channels, ev, scope)) {
      res.write(`event: ${ev.kind || "message"}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  }

  // Subscribe to each channel.
  const unsubscribes = channels.map((channel) =>
    hub.subscribe(channel, (event) => {
      if (!eventMatchesChannels(channels, event, scope)) return;
      try {
        res.write(`event: ${event.kind || "message"}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* connection closed */
      }
    })
  );

  // Heartbeat every 25s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* closed */
    }
  }, 25000);

  // Clean up on close.
  req.on("close", () => {
    clearInterval(heartbeat);
    for (const fn of unsubscribes) fn();
    try {
      res.end();
    } catch {
      /* already closed */
    }
  });
};

module.exports = sseHandler;
module.exports.resolveAuthorizedScope = resolveAuthorizedScope;
module.exports.buildDefaultChannel = buildDefaultChannel;
module.exports.buildAuthorizedChannels = buildAuthorizedChannels;
module.exports.eventMatchesChannels = eventMatchesChannels;