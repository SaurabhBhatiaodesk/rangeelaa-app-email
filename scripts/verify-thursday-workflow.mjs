import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real server modules with isolated environment, database and API doubles.
// Any unstubbed network operation fails immediately; no store or inbox is touched.
const root = resolve(import.meta.dirname, '..');
const nativeRequire = createRequire(import.meta.url);
const shop = 'review-test.myshopify.com';
const orderId = 'gid://shopify/Order/1';
const oldDraft = 'gid://shopify/DraftOrder/100';
const newDraft = 'gid://shopify/DraftOrder/200';
const baseEnv = { SHOPIFY_APP_URL: 'https://review.invalid', SHOPIFY_API_SECRET: 'local-review-secret' };

function world(overrides = {}, env = {}) {
  const cache = new Map();
  const environment = { ...baseEnv, ...env };
  const mocks = new Map(Object.entries(overrides).map(([file, value]) => [resolve(root, file), value]));
  mocks.set(resolve(root, 'app/db.server.ts'), { __esModule: true, default: { shopKlaviyoSettings: { findUnique: async () => null } } });
  function load(file) {
    const path = resolve(root, file);
    if (mocks.has(path)) return mocks.get(path);
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const require = (specifier) => {
      if (specifier.startsWith('node:')) return nativeRequire(specifier);
      assert.ok(specifier.startsWith('.'), `Unmocked package: ${specifier}`);
      const target = resolve(dirname(path), specifier);
      const candidate = [target, `${target}.ts`, `${target}.tsx`].find(existsSync);
      assert.ok(candidate, `Unresolved dependency: ${specifier}`);
      return load(candidate);
    };
    const context = { module, exports: module.exports, require, process: { env: environment }, console: { log() {}, error() {} }, URL, Request, Response, Buffer, setTimeout, clearTimeout, fetch: () => { throw new Error('Network disabled for review'); } };
    vm.runInNewContext(code, context, { filename: path });
    return module.exports;
  }
  return { load, env: environment };
}

function waitAdmin({ currentDraft = oldDraft, deleteFailure = false, paid = false, completed = false } = {}) {
  const calls = [];
  const failures = new Set(deleteFailure ? ['DeleteThursdayDraft'] : []);
  const orders = new Map([1, 2].map((id) => [`gid://shopify/Order/${id}`, { draftId: currentDraft, tags: ['thursday-email-sent', ...(paid ? ['shipping-paid'] : [])] }]));
  let draftExists = true;
  const admin = { graphql: async (query, { variables = {} } = {}) => {
    calls.push({ query, variables });
    let data;
    if (query.includes('ThursdayWaitOrder') || query.includes('OrderThursdayDraftMetafield')) {
      const order = orders.get(variables.id);
      data = { order: order ? { tags: [...order.tags], cancelledAt: order.cancelledAt ?? null, metafield: order.draftId ? { id: 'meta-1', value: order.draftId } : null } : null };
    } else if (query.includes('ThursdayWaitDraft')) {
      data = { draftOrder: draftExists ? { id: variables.id, status: completed ? 'COMPLETED' : 'OPEN', order: completed ? { id: 'gid://shopify/Order/999' } : null } : null };
    } else if (query.includes('DeleteThursdayDraft')) {
      const fail = failures.has('DeleteThursdayDraft');
      if (!fail) draftExists = false;
      data = { draftOrderDelete: { deletedId: fail ? null : variables.input.id, userErrors: fail ? [{ message: 'Draft deletion rejected' }] : [] } };
    } else if (query.includes('FridayRemoveTag')) {
      const fail = failures.has('FridayRemoveTag');
      if (!fail) orders.get(variables.id).tags = orders.get(variables.id).tags.filter((tag) => !variables.tags.includes(tag));
      data = { tagsRemove: { userErrors: fail ? [{ message: 'Tag removal rejected' }] : [] } };
    } else if (query.includes('FridayAddTag')) {
      const fail = failures.has('FridayAddTag');
      if (!fail) orders.get(variables.id).tags = [...new Set([...orders.get(variables.id).tags, ...variables.tags])];
      data = { tagsAdd: { userErrors: fail ? [{ message: 'Tag addition rejected' }] : [] } };
    } else if (query.includes('ClearThursdayDraftMetafield')) {
      const fail = failures.has('ClearThursdayDraftMetafield');
      if (!fail) orders.get(variables.metafields[0].ownerId).draftId = null;
      data = { metafieldsDelete: { userErrors: fail ? [{ message: 'Metafield deletion rejected' }] : [] } };
    }
    else throw new Error(`Unexpected wait operation: ${query}`);
    return { json: async () => ({ data }) };
  } };
  return { admin, calls, orders, failures };
}

function fixture(id, quantity = 1, options = {}) {
  const productTags = options.productTags ?? ['skirt'];
  return {
    id: `gid://shopify/Order/${id}`, name: `#${id}`, email: 'local-test@example.invalid', createdAt: '2026-09-01T00:00:00Z',
    tags: options.tags ?? [], displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    currentShippingPriceSet: { shopMoney: { amount: options.shipping ?? '0' } }, customer: { id: 'gid://shopify/Customer/1', displayName: 'Review Customer' },
    shippingAddress: { countryCodeV2: options.country ?? 'CA', city: options.city ?? 'Toronto', firstName: 'Review', lastName: 'Customer' }, metafield: null,
    lineItems: { edges: [{ node: { title: 'Review product', quantity, requiresShipping: true, product: { tags: productTags } } }] },
  };
}

function cycleAdmin(nodes) {
  const calls = [];
  const admin = { graphql: async (query, { variables = {} } = {}) => {
    calls.push({ query, variables });
    let data;
    if (query.includes('ThursdayCycleOrders')) {
      const candidates = variables.query.includes('financial_status:paid') ? nodes : nodes.filter((node) => node.tags.includes('arrived-in-canada-notified'));
      const offset = variables.after ? Number(variables.after) : 0;
      const selected = candidates.slice(offset, offset + variables.first);
      data = { orders: { edges: selected.map((node, index) => ({ node: { ...node, lineItems: { edges: node.lineItems.edges.slice(0, 10), pageInfo: { hasNextPage: node.lineItems.edges.length > 10, endCursor: '10' } } }, cursor: String(offset + index + 1) })), pageInfo: { hasNextPage: offset + selected.length < candidates.length, endCursor: String(offset + selected.length) } } };
    } else if (query.includes('ThursdayCycleLineItems')) {
      const edges = nodes.find((node) => node.id === variables.id).lineItems.edges;
      const offset = Number(variables.after);
      const selected = edges.slice(offset, offset + 100);
      data = { order: { lineItems: { edges: selected, pageInfo: { hasNextPage: offset + selected.length < edges.length, endCursor: String(offset + selected.length) } } } };
    } else if (query.includes('CreateThursdayDraft')) data = { draftOrderCreate: { draftOrder: { id: oldDraft, name: '#D100', invoiceUrl: 'https://review.invalid/invoice' }, userErrors: [] } };
    else if (query.includes('VerifyThursdayDraft')) data = { draftOrder: { id: oldDraft, name: '#D100', invoiceUrl: 'https://review.invalid/invoice' } };
    else if (query.includes('SetThursdayDraftMetafield')) data = { metafieldsSet: { userErrors: [] } };
    else if (query.includes('CycleTagsAdd')) data = { tagsAdd: { userErrors: [] } };
    else if (query.includes('CycleTagsRemove')) data = { tagsRemove: { userErrors: [] } };
    else throw new Error(`Unexpected cycle operation: ${query}`);
    return { json: async () => ({ data }) };
  } };
  return { admin, calls };
}

const results = [];
async function check(name, action) {
  try { results.push({ name, outcome: await action() }); }
  catch (error) { results.push({ name, failed: error.stack }); process.exitCode = 1; }
}

function confirmRequest(link, fields = { confirm: 'wait' }, origin) {
  return new Request(link, { method: 'POST', body: new URLSearchParams(fields), ...(origin ? { headers: { origin } } : {}) });
}

await check('Wait link GET and HEAD never mutate orders', async () => {
  const { admin, calls } = waitAdmin();
  const w = world({ 'app/shopify.server.ts': { unauthenticated: { admin: async () => ({ admin }) } } });
  const link = w.load('app/lib/thursday-wait-link.server.ts').buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [orderId] });
  for (const method of ['GET', 'HEAD']) {
    const response = await w.load('app/routes/shipping.wait.tsx').loader({ request: new Request(link, { method }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /name="confirm" value="wait"/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0);
  return 'PASS: confirmation page only; no Shopify calls';
});

await check('Old signed email affects newer invoice', async () => {
  const { admin, calls } = waitAdmin({ currentDraft: newDraft });
  const w = world({ 'app/shopify.server.ts': { unauthenticated: { admin: async () => ({ admin }) } } });
  const link = w.load('app/lib/thursday-wait-link.server.ts').buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [orderId] });
  const response = await w.load('app/routes/shipping.wait.tsx').action({ request: confirmRequest(link) });
  assert.equal(response.status, 409);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: old link cannot change a newer invoice';
});

await check('Deletion failure retains retry state', async () => {
  const { admin, calls } = waitAdmin({ deleteFailure: true });
  const result = await world().load('app/lib/friday-reset.server.ts').applyThursdayWaitChoice(admin, { shop, draftId: oldDraft, orderIds: [orderId] });
  assert.equal(result.ok, false);
  assert.ok(calls.every((call) => !/ClearThursdayDraftMetafield|FridayRemoveTag|FridayAddTag/.test(call.query)));
  return 'PASS: failed draft deletion preserves tags and references';
});

await check('Malformed signature handling', async () => {
  const wait = world().load('app/lib/thursday-wait-link.server.ts');
  const link = new URL(wait.buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [orderId] }));
  link.searchParams.set('sig', 'z'.repeat(64));
  assert.equal(wait.verifyThursdayWaitUrl(link).ok, false);
  return 'PASS: malformed signature returns invalid-link result without throwing';
});

await check('Email failure appears in cycle result', async () => {
  const { admin, calls } = cycleAdmin([fixture(1)]);
  const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async () => ({ ok: false, error: 'Simulated email failure' }) } });
  const result = await w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: false });
  assert.ok(calls.some((call) => call.query.includes('CreateThursdayDraft')));
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].emailSent, false);
  assert.match(result.error, /Simulated email failure/);
  return 'PASS: failed email is reported against the customer and cycle';
});

await check('Eligible order beyond first 75 is included', async () => {
  const nodes = Array.from({ length: 75 }, (_, index) => fixture(index + 1, 1, { country: 'GB' }));
  nodes.push(fixture(76));
  const { admin, calls } = cycleAdmin(nodes);
  const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async () => { throw new Error('Dry run must not send email'); } } });
  const result = await w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.customersProcessed, 1);
  assert.equal(result.results[0].orderNames.join(','), '#76');
  assert.ok(calls.filter((call) => call.query.includes('ThursdayCycleOrders')).length > 2);
  return 'PASS: eligible Canada order at position 76 is included';
});

await check('Canada combined 2 RTW + 4 preorder preview', async () => {
  const nodes = [fixture(11842, 2), fixture(11845, 4, { productTags: ['group'], tags: ['piece-made-notified', 'leaving-for-canada-notified', 'arrived-in-canada-notified'] })];
  const { admin, calls } = cycleAdmin(nodes);
  const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async () => { throw new Error('Dry run must not send email'); } } });
  const result = await w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results[0].itemCount, 6);
  assert.equal(result.results[0].shippingAmount, '23.26 CAD');
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: 1 customer / 6 items / CAD 23.26; no mutations or email sends';
});

await check('Allowed destinations and exclusions', async () => {
  const nodes = [fixture(1, 2, { country: 'US' }), fixture(2, 1, { country: 'GB' }), fixture(3, 1, { city: 'Saskatoon' }), fixture(4, 1, { tags: ['india-direct'] }), fixture(5, 1, { productTags: ['india'] }), fixture(6, 1, { shipping: '10.00' })];
  const { admin } = cycleAdmin(nodes);
  const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async () => { throw new Error('Dry run must not send email'); } } });
  const result = await w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results[0].orderNames.join(','), '#1');
  assert.equal(result.results[0].shippingAmount, '21.99 CAD');
  return 'PASS: USA eligible; Europe, Saskatoon, India-direct and checkout shipping excluded';
});

await check('Shipping rate tier boundaries', async () => {
  const rates = world().load('app/lib/shipping-rates.ts');
  const counts = [1, 2, 3, 4, 5, 9, 10, 14, 15, 19, 20, 100];
  const expected = { CA: ['17.39', '19.52', '19.75', '19.99', '23.26', '23.26', '27.26', '27.26', '29.26', '29.26', '32.26', '32.26'], US: ['18.99', '21.99', '23.99', '25.99', '31.79', '31.79', '44.93', '44.93', '47.93', '47.93', '51.93', '51.93'] };
  for (const countryCode of ['CA', 'US']) for (const [index, itemCount] of counts.entries()) assert.equal(rates.selectTieredShippingRate(rates.DEFAULT_SHIPPING_RATE_TABLE, { countryCode, itemCount }).amount, expected[countryCode][index]);
  return 'PASS: all 24 client rate boundary checks';
});

await check('Cron cannot send with default guard or legacy automation flag', async () => {
  for (const env of [{}, { THURSDAY_AUTOMATION_ENABLED: 'true' }]) {
    let runs = 0;
    const w = world({
      'app/lib/cron-auth.server.ts': { authenticateCron: async () => ({ ok: true, shop, admin: {} }) },
      'app/lib/cron-schedule.server.ts': { getCronTimeZone: () => 'America/Chicago', isWeekdayInCronTimeZone: () => true },
      'app/lib/thursday-cycle.server.ts': { runThursdayCycle: async () => { runs += 1; return { ok: true }; } },
    }, env);
    const route = w.load('app/routes/api.cron.thursday.tsx');
    for (const method of ['GET', 'POST']) {
      const response = await route[method === 'GET' ? 'loader' : 'action']({ request: new Request('https://review.invalid/api/cron/thursday?force=1', { method }) });
      assert.equal((await response.json()).skipped, true);
    }
    assert.equal(runs, 0);
  }
  return 'PASS: GET/POST force=1 and old automation env cannot invoke a live cycle';
});

await check('Confirmed wait deletes one shared draft; repeat click is harmless', async () => {
  const { admin, calls, orders } = waitAdmin();
  const w = world({ 'app/shopify.server.ts': { unauthenticated: { admin: async () => ({ admin }) } } });
  const link = w.load('app/lib/thursday-wait-link.server.ts').buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [...orders.keys()] });
  const route = w.load('app/routes/shipping.wait.tsx');
  for (let count = 0; count < 2; count++) {
    const response = await route.action({ request: confirmRequest(link) });
    assert.equal(response.status, 200);
  }
  assert.equal(calls.filter((call) => call.query.includes('DeleteThursdayDraft')).length, 1);
  for (const order of orders.values()) {
    assert.equal(order.draftId, null);
    assert.ok(order.tags.includes('pushed-to-next-weekend'));
    assert.ok(!order.tags.includes('thursday-email-sent'));
  }
  return 'PASS: two orders deferred with one deletion; second click makes no changes';
});

await check('Validate the entire customer group before any deletion', async () => {
  const { admin, calls, orders } = waitAdmin();
  orders.get('gid://shopify/Order/2').draftId = newDraft;
  const result = await world().load('app/lib/friday-reset.server.ts').applyThursdayWaitChoice(admin, { shop, draftId: oldDraft, orderIds: [...orders.keys()] });
  assert.equal(result.ok, false);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: one stale order prevents all changes';
});

await check('Paid, completed, cancelled and missing orders cannot be deferred', async () => {
  for (const scenario of ['paid', 'completed', 'cancelled', 'missing']) {
    const { admin, calls, orders } = waitAdmin({ paid: scenario === 'paid', completed: scenario === 'completed' });
    if (scenario === 'cancelled') orders.get(orderId).cancelledAt = '2026-09-01T00:00:00Z';
    if (scenario === 'missing') orders.delete(orderId);
    const result = await world().load('app/lib/friday-reset.server.ts').applyThursdayWaitChoice(admin, { shop, draftId: oldDraft, orderIds: [orderId] });
    assert.equal(result.ok, false, scenario);
    assert.equal(result.unavailable, true, scenario);
    assert.ok(calls.every((call) => !call.query.includes('mutation')), scenario);
  }
  return 'PASS: all four cases reject without mutation';
});

await check('Each failed cleanup step can be retried', async () => {
  for (const operation of ['DeleteThursdayDraft', 'FridayAddTag', 'ClearThursdayDraftMetafield', 'FridayRemoveTag']) {
    const { admin, calls, orders, failures } = waitAdmin();
    failures.add(operation);
    const apply = world().load('app/lib/friday-reset.server.ts').applyThursdayWaitChoice;
    const options = { shop, draftId: oldDraft, orderIds: [orderId] };
    assert.equal((await apply(admin, options)).ok, false, operation);
    assert.ok(orders.get(orderId).tags.includes('thursday-email-sent'), operation);
    failures.delete(operation);
    assert.equal((await apply(admin, options)).ok, true, operation);
    assert.equal(orders.get(orderId).draftId, null, operation);
    assert.ok(!orders.get(orderId).tags.includes('thursday-email-sent'), operation);
    assert.ok(calls.filter((call) => call.query.includes('DeleteThursdayDraft')).length <= 2);
  }
  return 'PASS: all four failures retain recoverable state';
});

await check('POST requires confirmation and rejects foreign origins', async () => {
  const { admin, calls } = waitAdmin();
  const w = world({ 'app/shopify.server.ts': { unauthenticated: { admin: async () => ({ admin }) } } });
  const link = w.load('app/lib/thursday-wait-link.server.ts').buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [orderId] });
  const action = w.load('app/routes/shipping.wait.tsx').action;
  assert.equal((await action({ request: confirmRequest(link, {}) })).status, 400);
  assert.equal((await action({ request: confirmRequest(link, { confirm: 'wait' }, 'https://unrelated.invalid') })).status, 403);
  assert.equal((await action({ request: new Request(link, { method: 'DELETE' }) })).status, 405);
  assert.equal(calls.length, 0);

  // Behind a proxy (e.g. Heroku) req.protocol/url.origin often reports http
  // even though the public site is https; same host with a different
  // protocol must still be accepted or every real confirmation click 403s.
  const sameHostDifferentProtocol = link.replace('https://', 'http://');
  const res = await action({ request: confirmRequest(link, { confirm: 'wait' }, sameHostDifferentProtocol.slice(0, new URL(sameHostDifferentProtocol).origin.length)) });
  assert.notEqual(res.status, 403);

  return 'PASS: no mutations without valid confirmation; proxy protocol mismatch is not rejected';
});

await check('Invalid, tampered and expired links are rejected', async () => {
  const w = world();
  const wait = w.load('app/lib/thursday-wait-link.server.ts');
  const original = wait.buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [orderId] });
  for (const [key, value] of [['sig', 'z'.repeat(64)], ['sig', 'f'.repeat(63)], ['draft', newDraft], ['orders', 'gid://shopify/Order/2'], ['exp', '1'], ['exp', 'Infinity'], ['shop', 'other.myshopify.com']]) {
    const link = new URL(original);
    link.searchParams.set(key, value);
    assert.equal(wait.verifyThursdayWaitUrl(link).ok, false, key);
  }
  assert.equal(wait.verifyThursdayWaitUrl(new URL(original)).ok, true);
  return 'PASS: invalid signatures and altered payloads rejected';
});

await check('Missing Wait URL prevents invoice event', async () => {
  const result = await world().load('app/lib/klaviyo.server.ts').sendThursdayInvoiceEmail({ apiKey: 'local-only', email: 'test@example.invalid', customerName: 'Test', invoiceUrl: 'https://review.invalid/invoice', waitUrl: '', orderNames: ['#1'], itemCount: 1, shippingAmount: '17.39 CAD', templateId: 'local-only' });
  assert.equal(result.ok, false);
  assert.match(result.error, /wait link/i);
  return 'PASS: incomplete button data never reaches the network';
});

await check('Line items paginate and contribute to shipping total', async () => {
  const node = fixture(1);
  node.lineItems.edges = Array.from({ length: 211 }, () => ({ node: { title: 'Dress', quantity: 1, requiresShipping: true, product: { tags: ['dress'] } } }));
  const { admin, calls } = cycleAdmin([node]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results[0].itemCount, 211);
  assert.equal(result.results[0].shippingAmount, '32.26 CAD');
  assert.equal(calls.filter((call) => call.query.includes('ThursdayCycleLineItems')).length, 3);
  return 'PASS: all line-item pages counted';
});

await check('Combined orders across pages retain correct count and rate', async () => {
  const nodes = [fixture(1, 2), ...Array.from({ length: 75 }, (_, index) => fixture(index + 2, 1, { country: 'GB' })), fixture(99, 4)];
  const { admin } = cycleAdmin(nodes);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].itemCount, 6);
  assert.equal(result.results[0].shippingAmount, '23.26 CAD');
  return 'PASS: customer grouping spans all order pages';
});

await check('Live manual cycle sends signed links and clears old wait tag first', async () => {
  const { admin, calls } = cycleAdmin([fixture(1, 1, { tags: ['pushed-to-next-weekend'] })]);
  const events = [];
  const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async (event) => { events.push(event); return { ok: true }; } } });
  const result = await w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].emailSent, true);
  assert.equal(events.length, 1);
  assert.equal(w.load('app/lib/thursday-wait-link.server.ts').verifyThursdayWaitUrl(new URL(events[0].waitUrl)).draftId, oldDraft);
  const removed = calls.findIndex((call) => call.query.includes('CycleTagsRemove'));
  const linked = calls.findIndex((call) => call.query.includes('SetThursdayDraftMetafield'));
  assert.ok(removed >= 0 && removed < linked);
  return 'PASS: manual run event has valid invoice/wait links; wait marker removed before linking';
});

await check('Delayed wait webhooks cannot void a newer cycle or paid shipment', async () => {
  for (const tags of [[], ['pushed-to-next-weekend', 'shipping-paid'], ['pushed-to-next-weekend']]) {
    let voids = 0;
    const w = world({
      'app/lib/friday-reset.server.ts': { voidThursdayDraftForOrder: async () => { voids++; return { ok: true, voided: true }; } },
      'app/lib/send-status-email.server.ts': {},
    });
    const admin = { graphql: async () => ({ json: async () => ({ data: { order: { email: 'test@example.invalid', tags, lineItems: { edges: [{ node: { quantity: 1, requiresShipping: true, product: { tags: ['dress'] } } }] } } } }) }) };
    await w.load('app/lib/orders-updated-webhook.server.ts').processPushedToNextWeekendVoid(admin, { id: '1', tags: 'pushed-to-next-weekend' }, shop);
    assert.equal(voids, tags.length === 1 ? 1 : 0);
  }
  return 'PASS: fresh order state determines whether the webhook may void';
});

await check('Friday reset preserves references when invoice deletion fails', async () => {
  const state = waitAdmin({ deleteFailure: true });
  const admin = { graphql: async (query, options) => {
    if (query.includes('FridayUnpaidThursdayOrders')) {
      const node = fixture(1, 1, { tags: ['thursday-email-sent'] });
      node.metafield = { id: 'meta-1', value: oldDraft };
      return { json: async () => ({ data: { orders: { edges: [{ node }] } } }) };
    }
    return state.admin.graphql(query, options);
  } };
  const result = await world().load('app/lib/friday-reset.server.ts').runFridayReset(admin, { shop, dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(state.orders.get(orderId).draftId, oldDraft);
  assert.ok(state.orders.get(orderId).tags.includes('thursday-email-sent'));
  return 'PASS: Friday deletion failure does not orphan the invoice';
});

for (const result of results) console.log(JSON.stringify(result));
console.log(`verify-thursday-workflow: ${results.filter((result) => !result.failed).length}/${results.length} scenarios passed`);
