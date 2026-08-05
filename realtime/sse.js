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

// Default channel: ALL. Pass ?storeType=hotel&storeId=hotel to scope.
const buildDefaultChannel = ({ storeType, storeId }) => {
  // Super Owner (no specific storeType in user record) or query override
  // targeting a specific store → join the booking + hotel channels for
  // that store plus the global channel.
  if (storeType) {
    return [
      hub.CHANNELS.BOOKING(storeType, storeId),
      hub.CHANNELS.HOTEL(storeType, storeId),
      hub.CHANNELS.ALL(),
    ];
  }
  return [hub.CHANNELS.ALL()];
};

const sseHandler = (req, res) => {
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
  const channels = buildDefaultChannel({ storeType: req.query.storeType, storeId: req.query.storeId });

  res.write(`event: hello\ndata: ${JSON.stringify({ channels, ts: Date.now() })}\n\n`);

  // Replay any events from the last RECENT_LIMIT that match a subscribed
  // channel — covers the case where an event fired between the page
  // load and the SSE handshake.
  for (const ev of hub.recentEvents) {
    if (channels.includes(ev.channel)) {
      res.write(`event: ${ev.kind || "message"}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  }

  // Subscribe to each channel.
  const unsubscribes = channels.map((channel) =>
    hub.subscribe(channel, (event) => {
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