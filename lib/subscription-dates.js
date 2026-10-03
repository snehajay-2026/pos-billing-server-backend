// lib/subscription-dates.js
//
// Pure calendar + grace helpers for the subscription lifecycle (Task 10).
// No I/O, no DB, no provider calls — fully unit-testable with a fake clock.

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Canonical tenant key: rootOwnerEmail || ownerEmail || email,
 * trimmed + lowercased. Matches resolveTenantEmail semantics.
 */
function canonicalizeTenantKey(userOrEmail) {
  const v =
    typeof userOrEmail === "string"
      ? userOrEmail
      : userOrEmail?.rootOwnerEmail ||
        userOrEmail?.ownerEmail ||
        userOrEmail?.email ||
        null;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

/**
 * Anchor day-of-month for sticky billing. Persisted once at creation.
 * Falls back explicitly (documented): derive from startedAt day when the
 * anchor column is missing — flagged as potentially shifted, never assumed
 * to be the original anchor.
 */
function resolveAnchorDay(subscription) {
  const stored = Number(subscription?.billingAnchorDay ?? subscription?.billing_anchor_day);
  if (Number.isFinite(stored) && stored >= 1 && stored <= 31) return stored;
  const started = toDate(subscription?.startedAt ?? subscription?.started_at);
  if (started) return started.getUTCDate();
  return 1;
}

function addCalendarCycle(base, billingCycle, anchorDay) {
  const b = toDate(base);
  if (!b) return null;
  const anchor = Math.min(Math.max(Number(anchorDay) || 1, 1), 31);
  if (billingCycle === "yearly") {
    const y = b.getUTCFullYear() + 1;
    const m = b.getUTCMonth();
    const day = Math.min(anchor, daysInMonth(y, m));
    return new Date(Date.UTC(y, m, day, b.getUTCHours(), b.getUTCMinutes(), b.getUTCSeconds(), b.getUTCMilliseconds()));
  }
  // monthly (default)
  let y = b.getUTCFullYear();
  let m = b.getUTCMonth() + 1;
  if (m > 11) {
    m = 0;
    y += 1;
  }
  const day = Math.min(anchor, daysInMonth(y, m));
  return new Date(Date.UTC(y, m, day, b.getUTCHours(), b.getUTCMinutes(), b.getUTCSeconds(), b.getUTCMilliseconds()));
}

/**
 * Monotonic renewal expiry: candidate (provider current_end, seconds or ms)
 * wins when strictly later than current expiry; otherwise keep current.
 * Returns { expiresAt: Date|null, moved: boolean }.
 */
function applyMonotonicExpiry(currentExpiresAt, candidateCurrentEnd) {
  const current = toDate(currentExpiresAt);
  let candidate = null;
  if (candidateCurrentEnd != null && candidateCurrentEnd !== "") {
    const n = Number(candidateCurrentEnd);
    if (Number.isFinite(n) && n > 0) {
      // Heuristic: values < 1e12 are seconds, larger are milliseconds.
      candidate = new Date(n < 1e12 ? n * 1000 : n);
      if (Number.isNaN(candidate.getTime())) candidate = null;
    } else {
      const d = toDate(candidateCurrentEnd);
      if (d) candidate = d;
    }
  }
  if (!candidate) return { expiresAt: current, moved: false, candidate: null };
  if (!current || candidate.getTime() > current.getTime()) {
    return { expiresAt: candidate, moved: true, candidate };
  }
  return { expiresAt: current, moved: false, candidate };
}

/**
 * Calendar fallback when current_end is missing/invalid:
 * max(currentExpiry, eventTime) + one cycle on the sticky anchor.
 */
function fallbackCycleExpiry({ currentExpiresAt, eventTime, billingCycle, anchorDay }) {
  const current = toDate(currentExpiresAt);
  const evt = toDate(eventTime);
  const base = current && evt ? (current.getTime() >= evt.getTime() ? current : evt) : current || evt;
  if (!base) return null;
  return addCalendarCycle(base, billingCycle, anchorDay);
}

function graceAllows({ now, pastDueSince }) {
  const since = toDate(pastDueSince);
  if (!since) return { allowed: true, legacyNoTimestamp: true };
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return { allowed: t < since.getTime() + GRACE_MS, legacyNoTimestamp: false };
}

module.exports = {
  GRACE_MS,
  canonicalizeTenantKey,
  resolveAnchorDay,
  addCalendarCycle,
  applyMonotonicExpiry,
  fallbackCycleExpiry,
  graceAllows,
  toDate,
};
