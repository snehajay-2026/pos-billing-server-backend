// server/realtime/hub.js
//
// In-process pub/sub hub for cross-device real-time sync. Bookings,
// occupancy changes, and live-bill updates publish structured events
// here; the SSE endpoint (/api/events) subscribes a per-connection
// listener that streams them down to the browser.
//
// Scope-prefixed channel names keep cross-store noise out of
// irrelevant sessions: a SUPER_OWNER switching between stores belongs
// to all of them; a CASHIER belongs to only their assigned store.
//
// Memory: O(active SSE connections). No disk persistence — events are
// transient (a missed SSE event is recovered by the client on the
// next GET /api/hotel/bookings poll + the loadBookings overlay on
// mount). Last-N-events replay is implemented for the SSE handshake
// so the client immediately receives events that fired during the
// SSE handshake.

const { randomUUID } = require("crypto");

const CHANNELS = {
  BOOKING: (storeType, storeId) => `bookings:${storeType || ""}:${storeId || ""}`,
  HOTEL: (storeType, storeId) => `hotel:${storeType || ""}:${storeId || ""}`,
  ALL: () => "*",
};

const RECENT_LIMIT = 100;
const recentEvents = []; // ring buffer of last N events for the replay

const addRecent = (event) => {
  recentEvents.push(event);
  if (recentEvents.length > RECENT_LIMIT) {
    recentEvents.shift();
  }
};

// subscribers: Map<channel, Set<fn>. Each fn receives the event object.
const subscribers = new Map();

const subscribe = (channel, fn) => {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set());
  subscribers.get(channel).add(fn);
  return () => {
    const set = subscribers.get(channel);
    if (set) {
      set.delete(fn);
      if (set.size === 0) subscribers.delete(channel);
    }
  };
};

const publish = (event) => {
  const enriched = {
    id: event.id || randomUUID(),
    ts: Date.now(),
    ...event,
  };
  addRecent(enriched);

  // Fan out to the explicit channel + ALL (broadcast).
  const targets = new Set([enriched.channel, CHANNELS.ALL()]);
  for (const channel of targets) {
    const set = subscribers.get(channel);
    if (!set) continue;
    for (const fn of set) {
      try {
        fn(enriched);
      } catch {
        /* listener died — ignore */
      }
    }
  }
  return enriched;
};

// Build an event for a booking write. The client uses `kind` to know
// what to update and `id` to dedupe.
const buildBookingEvent = ({ action, booking, scope }) => ({
  kind: "booking",
  action, // 'created' | 'updated' | 'checked_out'
  storeType: scope?.storeType || null,
  storeId: scope?.storeId || null,
  channel: CHANNELS.BOOKING(scope?.storeType, scope?.storeId),
  booking,
});

// Build an event for a hotel-related change (table booking, room
// booking, live bill, etc.). Same shape, but the kind disambiguates.
const buildHotelEvent = ({ action, kind, storeType, storeId, data }) => ({
  kind: kind || "hotel",
  action,
  storeType: storeType || null,
  storeId: storeId || null,
  channel: CHANNELS.HOTEL(storeType, storeId),
  data,
});

module.exports = {
  CHANNELS,
  subscribe,
  publish,
  buildBookingEvent,
  buildHotelEvent,
  recentEvents,
};
