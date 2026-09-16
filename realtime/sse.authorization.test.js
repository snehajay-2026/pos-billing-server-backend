const test = require("node:test");
const assert = require("node:assert/strict");

const hub = require("./hub");
const sseHandler = require("./sse");
const {
  resolveAuthorizedScope,
  buildAuthorizedChannels,
  eventMatchesChannels,
} = sseHandler;

const user = (role, storeType = "service", storeId = "A") => ({
  id: `${role}-${storeId}`,
  role,
  storeType,
  storeId,
});

const request = (currentUser, query = {}) => ({
  user: currentUser,
  query,
});

const channelsFor = (storeType, storeId) => [
  hub.CHANNELS.BOOKING(storeType, storeId),
  hub.CHANNELS.HOTEL(storeType, storeId),
  hub.CHANNELS.INVOICE(storeType, storeId),
  hub.CHANNELS.STOCK(storeType, storeId),
  hub.CHANNELS.SHIFT(storeType, storeId),
  hub.CHANNELS.ORDER(storeType, storeId),
  hub.CHANNELS.SERVICE(storeType, storeId),
  hub.CHANNELS.CUSTOMER(storeType, storeId),
  hub.CHANNELS.CUSTOMER_CREDIT(storeType, storeId),
];

test("non-super roles cannot widen SSE scope with store query parameters", () => {
  for (const role of ["ADMIN", "STORE_ADMIN", "CASHIER", "BRANCH_ADMIN"]) {
    const scope = resolveAuthorizedScope(
      request(user(role), {
        storeType: "service",
        storeId: "B",
      })
    );

    assert.deepEqual(scope, {
      storeType: "service",
      storeId: "A",
      role,
      isGlobal: false,
    });
    assert.ok(!buildAuthorizedChannels(request(user(role), { storeId: "B" })).includes("*"));
  }
});

test("non-super users with no store scope fail closed", () => {
  assert.throws(
    () => resolveAuthorizedScope(request(user("CASHIER", "", ""), { storeType: "service", storeId: "B" })),
    (error) => error.status === 403
  );
});

test("SUPER_OWNER preserves explicit scoped and unscoped platform behavior", () => {
  const scoped = resolveAuthorizedScope(
    request(user("SUPER_OWNER", "system", ""), { storeType: "service", storeId: "A" })
  );
  assert.deepEqual(scoped, {
    storeType: "service",
    storeId: "A",
    role: "SUPER_OWNER",
    isGlobal: false,
  });
  assert.ok(!buildAuthorizedChannels(request(user("SUPER_OWNER"), { storeType: "service", storeId: "A" })).includes("*"));

  const global = resolveAuthorizedScope(request(user("SUPER_OWNER", "system", "")));
  assert.equal(global.isGlobal, true);
  assert.deepEqual(buildAuthorizedChannels(request(user("SUPER_OWNER", "system", ""))), ["*"]);
});

test("ambiguous or branch query parameters cannot create an unauthorized scope", () => {
  assert.throws(
    () => resolveAuthorizedScope(request(user("SUPER_OWNER", "system", ""), { storeId: "B" })),
    (error) => error.status === 403
  );
  assert.throws(
    () => resolveAuthorizedScope(request(user("ADMIN"), { branchId: "B" })),
    (error) => error.status === 403
  );
  assert.throws(
    () => resolveAuthorizedScope(request(user("ADMIN"), { branchId: ["A", "B"] })),
    (error) => error.status === 403
  );
  assert.throws(
    () => resolveAuthorizedScope(request(user("SUPER_OWNER"), { storeType: ["service", "retail"] })),
    (error) => error.status === 403
  );
  assert.throws(
    () => resolveAuthorizedScope(request(user("SUPER_OWNER"), { storeType: "service", storeId: ["A", "B"] })),
    (error) => error.status === 403
  );
  assert.throws(
    () => resolveAuthorizedScope(request(user("SUPER_OWNER"), { storeType: ["", ""] })),
    (error) => error.status === 403
  );
});

test("scoped channel lists contain only the authorized store channels", () => {
  const channels = buildAuthorizedChannels(request(user("CASHIER"), {
    storeType: "retail",
    storeId: "B",
  }));
  assert.deepEqual(channels, channelsFor("service", "A"));
  assert.ok(!channels.includes(hub.CHANNELS.ALL()));
});

test("Store A subscribers cannot receive Store B events for every realtime event kind", () => {
  const storeA = channelsFor("service", "A");
  const storeB = channelsFor("service", "B");
  const receivedA = [];
  const receivedGlobal = [];
  const unsubscribeA = storeA.map((channel) => hub.subscribe(channel, (event) => receivedA.push(event)));
  const unsubscribeGlobal = hub.subscribe(hub.CHANNELS.ALL(), (event) => receivedGlobal.push(event));

  const kinds = [
    "invoice",
    "stock",
    "order",
    "service",
    "customer",
    "customer_credit",
    "shift",
    "booking",
    "hotel",
    "live_bill",
    "message",
  ];
  kinds.forEach((kind, index) => {
    hub.publish({
      id: `security-a-${kind}`,
      kind,
      channel: storeA[index % storeA.length],
      storeType: "service",
      storeId: "A",
    });
    hub.publish({
      id: `security-b-${kind}`,
      kind,
      channel: storeB[index % storeB.length],
      storeType: "service",
      storeId: "B",
    });
  });

  unsubscribeA.forEach((unsubscribe) => unsubscribe());
  unsubscribeGlobal();

  assert.equal(receivedA.length, kinds.length);
  assert.ok(receivedA.every((event) => event.storeId === "A"));
  assert.equal(receivedGlobal.length, kinds.length * 2);
});

test("live delivery matching rejects mismatched event metadata", () => {
  const channels = channelsFor("service", "A");
  const channel = hub.CHANNELS.INVOICE("service", "A");
  const good = {
    kind: "invoice",
    channel,
    storeType: "service",
    storeId: "A",
  };
  const wrongPayload = { ...good, storeId: "B" };
  const wrongChannel = { ...good, channel: hub.CHANNELS.INVOICE("service", "B") };

  assert.equal(eventMatchesChannels(channels, good, { storeType: "service", storeId: "A" }), true);
  assert.equal(eventMatchesChannels(channels, wrongPayload, { storeType: "service", storeId: "A" }), false);
  assert.equal(eventMatchesChannels(channels, wrongChannel, { storeType: "service", storeId: "A" }), false);
});

test("all audited event kinds match only their authorized store channel", () => {
  const channelsA = channelsFor("service", "A");
  const channelsB = channelsFor("service", "B");
  const kinds = [
    "invoice",
    "stock",
    "order",
    "service",
    "customer",
    "customer_credit",
    "shift",
    "booking",
    "hotel",
    "live_bill",
    "message",
  ];
  for (const [index, kind] of kinds.entries()) {
    const channelA = channelsA[index % channelsA.length];
    const channelB = channelsB[index % channelsB.length];
    assert.equal(
      eventMatchesChannels(channelsA, { kind, channel: channelA, storeType: "service", storeId: "A" }, { storeType: "service", storeId: "A" }),
      true,
      `${kind} should match Store A`
    );
    assert.equal(
      eventMatchesChannels(channelsA, { kind, channel: channelB, storeType: "service", storeId: "B" }, { storeType: "service", storeId: "A" }),
      false,
      `${kind} should not match Store B`
    );
  }
});

test("replay matching is scoped unless the authorized connection is global", () => {
  const channelsA = channelsFor("service", "A");
  const eventA = {
    kind: "invoice",
    channel: hub.CHANNELS.INVOICE("service", "A"),
    storeType: "service",
    storeId: "A",
  };
  const eventB = {
    kind: "invoice",
    channel: hub.CHANNELS.INVOICE("service", "B"),
    storeType: "service",
    storeId: "B",
  };

  assert.equal(eventMatchesChannels(channelsA, eventA, { storeType: "service", storeId: "A" }), true);
  assert.equal(eventMatchesChannels(channelsA, eventB, { storeType: "service", storeId: "A" }), false);
  assert.equal(
    eventMatchesChannels([hub.CHANNELS.ALL()], eventA, { isGlobal: true }),
    true
  );
  assert.equal(
    eventMatchesChannels([hub.CHANNELS.ALL()], eventB, { isGlobal: true }),
    true
  );
  assert.equal(
    eventMatchesChannels([hub.CHANNELS.ALL()], eventA, {
      storeType: "service",
      storeId: "A",
      isGlobal: false,
    }),
    false
  );
});
