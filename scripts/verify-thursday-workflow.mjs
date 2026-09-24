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
    tags: options.tags ?? [], displayFinancialStatus: options.financial ?? 'PAID', displayFulfillmentStatus: options.fulfillment ?? 'UNFULFILLED', cancelledAt: options.cancelledAt ?? null,
    currentShippingPriceSet: { shopMoney: { amount: options.shipping ?? '0' } },
    customer: { id: 'gid://shopify/Customer/1', displayName: 'Review Customer' },
    shippingAddress: { countryCodeV2: options.country ?? 'CA', city: options.city ?? 'Toronto', firstName: 'Review', lastName: 'Customer' }, metafield: null,
    lineItems: { edges: [{ node: { title: 'Review product', quantity, currentQuantity: options.currentQuantity ?? quantity, requiresShipping: true, product: { tags: productTags } } }] },
  };
}

function cycleAdmin(nodes, { drafts = {}, createdDraftId = oldDraft } = {}) {
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
    } else if (query.includes('CreateThursdayDraft')) data = { draftOrderCreate: { draftOrder: { id: createdDraftId, name: '#D100', invoiceUrl: 'https://review.invalid/invoice' }, userErrors: [] } };
    else if (query.includes('VerifyThursdayDraft')) data = { draftOrder: drafts[variables.id] ?? { id: variables.id, name: '#D100', invoiceUrl: 'https://review.invalid/invoice', status: 'OPEN', order: null } };
    else if (query.includes('SetThursdayDraftMetafield')) {
      for (const meta of variables.metafields) nodes.find((node) => node.id === meta.ownerId).metafield = { value: meta.value };
      data = { metafieldsSet: { userErrors: [] } };
    } else if (query.includes('CycleTagsAdd')) {
      const node = nodes.find((node) => node.id === variables.id);
      node.tags = [...new Set([...node.tags, ...variables.tags])];
      data = { tagsAdd: { userErrors: [] } };
    } else if (query.includes('CycleTagsRemove')) {
      const node = nodes.find((node) => node.id === variables.id);
      node.tags = node.tags.filter((tag) => !variables.tags.includes(tag));
      data = { tagsRemove: { userErrors: [] } };
    }
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

await check('Cron can never send a live Thursday invoice, under any env var or param', async () => {
  // The client requires that no Thursday email is ever sent without someone
  // clicking "Run Thursday Cycle" in the app. This endpoint must stay
  // permanently incapable of a live send, no matter what gets set on Heroku.
  for (const env of [
    {},
    { THURSDAY_AUTOMATION_ENABLED: 'true' },
    { THURSDAY_CRON_LIVE_ENABLED: 'true' },
  ]) {
    let runs = 0;
    let liveRuns = 0;
    const w = world({
      'app/lib/cron-auth.server.ts': { authenticateCron: async () => ({ ok: true, shop, admin: {} }) },
      'app/lib/cron-schedule.server.ts': { getCronTimeZone: () => 'America/Chicago', isWeekdayInCronTimeZone: () => true },
      'app/lib/thursday-cycle.server.ts': { runThursdayCycle: async (_admin, opts) => { runs += 1; if (!opts.dryRun) liveRuns += 1; return { ok: true }; } },
    }, env);
    const route = w.load('app/routes/api.cron.thursday.tsx');
    for (const method of ['GET', 'POST']) {
      const response = await route[method === 'GET' ? 'loader' : 'action']({ request: new Request('https://review.invalid/api/cron/thursday?force=1', { method }) });
      assert.equal((await response.json()).skipped, true, `${method} with ${JSON.stringify(env)}`);
    }
    assert.equal(liveRuns, 0, `env=${JSON.stringify(env)}`);
  }
  return 'PASS: no env var or query param can make this endpoint send a live Thursday invoice';
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

await check('POST requires confirmation regardless of Origin header', async () => {
  const { admin, calls } = waitAdmin();
  const w = world({ 'app/shopify.server.ts': { unauthenticated: { admin: async () => ({ admin }) } } });
  const link = w.load('app/lib/thursday-wait-link.server.ts').buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [orderId] });
  const action = w.load('app/routes/shipping.wait.tsx').action;
  assert.equal((await action({ request: confirmRequest(link, {}) })).status, 400);
  assert.equal((await action({ request: new Request(link, { method: 'DELETE' }) })).status, 405);
  assert.equal(calls.length, 0);

  // Real confirmations arrive with all kinds of Origin headers (missing,
  // "null", a mismatched proxy host/protocol) - none of that may 403 a
  // otherwise-valid, signed confirmation. The signature + live order/draft
  // state check is what actually protects this endpoint.
  for (const origin of [undefined, 'null', 'https://unrelated.invalid', link.replace('https://', 'http://')]) {
    const res = await action({ request: confirmRequest(link, { confirm: 'wait' }, origin) });
    assert.notEqual(res.status, 403, `origin=${origin}`);
  }

  return 'PASS: no mutations without valid confirmation; Origin header never rejects a signed link';
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

await check('Missing Wait or Pay URL prevents invoice event', async () => {
  const klaviyo = world().load('app/lib/klaviyo.server.ts');
  const base = { apiKey: 'local-only', email: 'test@example.invalid', customerName: 'Test', invoiceUrl: 'https://review.invalid/invoice', payUrl: 'https://review.invalid/shipping/pay', orderNames: ['#1'], itemCount: 1, shippingAmount: '17.39 CAD', templateId: 'local-only' };
  const noWait = await klaviyo.sendThursdayInvoiceEmail({ ...base, waitUrl: '' });
  assert.equal(noWait.ok, false);
  assert.match(noWait.error, /wait link/i);
  const noPay = await klaviyo.sendThursdayInvoiceEmail({ ...base, payUrl: '', waitUrl: 'https://review.invalid/shipping/wait' });
  assert.equal(noPay.ok, false);
  assert.match(noPay.error, /pay link/i);
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

const readyTags = ['piece-made-notified', 'leaving-for-canada-notified', 'arrived-in-canada-notified'];
const invoiceId = 'gid://shopify/Order/999';
const refundPayload = { id: '999', financial_status: 'refunded' };

function paymentAdmin(nodes = [fixture(1)]) {
  const calls = [];
  const failures = new Set();
  const originals = new Map(nodes.map((node) => {
    node.tags = [...node.tags, 'shipping-paid', 'thursday-email-sent', 'unrelated-client-tag'];
    node.metafield = { value: oldDraft };
    return [node.id, node];
  }));
  const invoice = { id: invoiceId, tags: ['rangeela-thursday-shipping', 'shipping-invoice'], displayFinancialStatus: 'REFUNDED', customAttributes: [{ key: 'linked_order_ids', value: JSON.stringify([...originals.keys()]) }] };
  const drafts = new Map([[oldDraft, invoiceId], [newDraft, 'gid://shopify/Order/888']]);
  const admin = { graphql: async (query, { variables = {} } = {}) => {
    calls.push({ query, variables: JSON.parse(JSON.stringify(variables)) });
    let data;
    if (query.includes('query ShippingInvoicePayment')) data = { order: invoice };
    else if (query.includes('query ShippingPaymentOriginal')) {
      const node = originals.get(variables.id);
      data = { order: node ? { ...node, draft: node.metafield } : null };
    } else if (query.includes('query ShippingPaymentDraft')) data = { draftOrder: drafts.has(variables.id) ? { id: variables.id, order: { id: drafts.get(variables.id) } } : null };
    else if (query.includes('mutation ShippingRefundReceipt')) {
      const meta = variables.metafields[0];
      const receipt = JSON.parse(meta.value);
      const fail = failures.has(`ShippingRefundReceipt:${receipt.state}`);
      if (!fail) originals.get(meta.ownerId).refund = { value: meta.value };
      data = { metafieldsSet: { userErrors: fail ? [{ message: 'Receipt rejected' }] : [] } };
    } else if (query.includes('mutation ShippingRefundTagsRemove')) {
      const fail = failures.has('ShippingRefundTagsRemove');
      if (!fail) {
        const node = originals.get(variables.id);
        node.tags = node.tags.filter((tag) => !variables.tags.includes(tag));
      }
      data = { tagsRemove: { userErrors: fail ? [{ message: 'Tag removal rejected' }] : [] } };
    } else if (query.includes('mutation ShippingPaymentTagsAdd')) {
      const fail = failures.has('ShippingPaymentTagsAdd');
      if (!fail) {
        const node = originals.get(variables.id);
        node.tags = [...new Set([...node.tags, ...variables.tags])];
      }
      data = { tagsAdd: { userErrors: fail ? [{ message: 'Paid tag rejected' }] : [] } };
    } else throw new Error(`Unexpected payment operation: ${query}`);
    return { json: async () => JSON.parse(JSON.stringify({ data })) };
  } };
  return { admin, calls, failures, originals, invoice, drafts };
}

function paymentWorld() {
  return world({ 'app/lib/send-status-email.server.ts': {} });
}

await check('Cancelled, fully refunded, and voided originals never enter either Thursday pool', async () => {
  const nodes = [fixture(1, 2), fixture(2, 4, { productTags: ['group'], tags: readyTags })];
  for (const productTags of [['dress'], ['group']]) {
    for (const options of [{ cancelledAt: '2026-09-15T00:00:00Z' }, { financial: 'REFUNDED' }, { financial: 'VOIDED' }]) {
      nodes.push(fixture(nodes.length + 1, 20, { ...options, productTags, tags: [...readyTags, 'hold-for-next-cycle'] }));
    }
  }
  const { admin, calls } = cycleAdmin(nodes);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results[0].orderNames.sort().join(','), '#1,#2');
  assert.equal(result.results[0].itemCount, 6);
  assert.equal(result.results[0].shippingAmount, '23.26 CAD');
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: both pools exclude cancelled/fully-refunded/voided orders, even with a hold override';
});

await check('A partially refunded RTW order stays eligible for its full quantity when nothing was returned', async () => {
  const nodes = [fixture(1, 3, { financial: 'PARTIALLY_REFUNDED' })];
  const { admin, calls } = cycleAdmin(nodes);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].itemCount, 3);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: a courtesy/shipping refund that never reduced the garment quantity still counts as unpaid shipping';
});

await check('A partially refunded preorder order stays eligible for its full quantity when nothing was returned', async () => {
  const nodes = [fixture(1, 2, { productTags: ['group'], tags: readyTags, financial: 'PARTIALLY_REFUNDED' })];
  const { admin, calls } = cycleAdmin(nodes);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].itemCount, 2);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: the same partial-refund eligibility applies to a preorder order';
});

await check('A refund that returns some garments still bills for the remaining quantity', async () => {
  const nodes = [fixture(1, 3, { financial: 'PARTIALLY_REFUNDED', currentQuantity: 2 })];
  const { admin, calls } = cycleAdmin(nodes);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].itemCount, 2);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: the order stays in; only the returned piece drops out of the billed count';
});

await check('A refund that returns every unit of the only line item excludes the order (nothing left to bill)', async () => {
  const nodes = [fixture(1, 3, { financial: 'PARTIALLY_REFUNDED', currentQuantity: 0 })];
  const { admin } = cycleAdmin(nodes);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 0);
  return 'PASS: zero remaining billable quantity means no invoice, not an error';
});

await check('A preorder order bills every physical piece, not just the group/Web Saree-tagged line', async () => {
  const node = fixture(1, 1, { productTags: ['group'], tags: readyTags });
  node.lineItems.edges.push({ node: { title: 'Plain scarf', quantity: 1, currentQuantity: 1, requiresShipping: true, product: { tags: ['scarf'] } } });
  const { admin, calls } = cycleAdmin([node]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].itemCount, 2);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: shipping is priced per piece; the untagged second line item on a preorder order is still billed';
});

await check('Dispatch skirt items are billed as ordinary RTW pieces, including mixed orders', async () => {
  const node = fixture(1, 1, { productTags: ['dispatch skirt'] });
  node.lineItems.edges.push({ node: { title: 'Plain top', quantity: 1, currentQuantity: 1, requiresShipping: true, product: { tags: ['top'] } } });
  const { admin, calls } = cycleAdmin([node]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].itemCount, 2);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: a dispatch skirt no longer forces preorder classification; both pieces on the order are billed';
});

await check('A dispatch skirt item that also carries an india tag is still excluded as India Direct', async () => {
  const node = fixture(1, 1, { productTags: ['dispatch skirt', 'india'] });
  const { admin } = cycleAdmin([node]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 0);
  return 'PASS: only virtual products and india-tagged products are excluded; india always wins, even on a dispatch skirt';
});

await check('A genuine India item (no dispatch skirt tag) is still excluded as India Direct', async () => {
  const node = fixture(1, 1, { productTags: ['india'] });
  const { admin } = cycleAdmin([node]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 0);
  return 'PASS: the India Direct exclusion is untouched for ordinary india-tagged items';
});

await check('A fulfilled preorder order is excluded from the invoice list', async () => {
  const nodes = [fixture(1, 2, { productTags: ['group'], tags: readyTags, fulfillment: 'FULFILLED' })];
  const { admin, calls } = cycleAdmin(nodes);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 0);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: a fulfilled preorder order never re-enters the Thursday invoice list';
});

await check('An already-paid order can never be re-invoiced by adding hold-for-next-cycle', async () => {
  const paidWithHold = fixture(1, 3, {
    productTags: ['group'],
    tags: [...readyTags, 'shipping-paid', 'thursday-email-sent', 'hold-for-next-cycle'],
  });
  const { admin, calls } = cycleAdmin([paidWithHold]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 0);
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: shipping-paid always blocks re-invoicing, even when hold-for-next-cycle is also present';
});

await check('hold-for-next-cycle still re-opens an unpaid, already-invoiced order', async () => {
  const invoicedNotPaid = fixture(1, 3, {
    productTags: ['group'],
    tags: [...readyTags, 'thursday-email-sent', 'hold-for-next-cycle'],
  });
  const { admin } = cycleAdmin([invoicedNotPaid]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].orderNames.join(','), '#1');
  return 'PASS: hold-for-next-cycle still overrides thursday-email-sent when the order was never paid';
});

await check('Removed units do not affect Thursday counts or classification', async () => {
  const node = fixture(1, 10, { currentQuantity: 2 });
  node.lineItems.edges.push({ node: { quantity: 20, currentQuantity: 0, requiresShipping: true, product: { tags: ['india'] } } });
  const { admin } = cycleAdmin([node, fixture(2, 4, { currentQuantity: 0 })]);
  const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: true });
  assert.equal(result.results[0].itemCount, 2);
  assert.equal(result.results[0].shippingAmount, '19.52 CAD');
  assert.equal(result.results[0].orderNames.join(','), '#1');
  return 'PASS: current quantities used; zero-quantity removed lines cannot classify or inflate an order';
});

await check('Status item lists and dashboard omit cancelled and refunded originals', async () => {
  const nodes = [fixture(1, 5, { currentQuantity: 2, productTags: ['group'], tags: readyTags }), fixture(2, 8, { productTags: ['group'], tags: readyTags, cancelledAt: '2026-09-15T00:00:00Z' }), fixture(3, 9, { productTags: ['group'], tags: readyTags, financial: 'REFUNDED' })];
  const admin = { graphql: async () => ({ json: async () => ({ data: { orders: { edges: nodes.map((node) => ({ node })) } } }) }) };
  const w = world();
  const tags = (await w.load('app/lib/klaviyo-settings.server.ts').getShopSettings(shop)).preorderTags;
  const orders = w.load('app/lib/orders.server.ts');
  const listed = await orders.fetchAwaitingReadinessOrders(admin, tags);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].lineItems[0].quantity, 2);
  assert.equal((await orders.fetchShippingWorkflowSummary(admin, tags)).readyToShipCount, 1);
  return 'PASS: filtered before list and summary calculation';
});

await check('Full shipping refund reopens the group without emailing or deleting payment history', async () => {
  const state = paymentAdmin([fixture(1, 2), fixture(2, 4, { productTags: ['group'], tags: readyTags })]);
  const apply = paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund;
  await apply(state.admin, refundPayload, shop);
  for (const node of state.originals.values()) {
    assert.ok(!node.tags.includes('shipping-paid') && !node.tags.includes('thursday-email-sent'));
    assert.ok(node.tags.includes('unrelated-client-tag'));
    assert.equal(node.metafield.value, oldDraft);
    assert.equal(JSON.parse(node.refund.value).state, 'complete');
  }
  const writes = state.calls.filter((call) => call.query.includes('mutation')).length;
  await apply(state.admin, refundPayload, shop);
  assert.equal(state.calls.filter((call) => call.query.includes('mutation')).length, writes);
  assert.ok(state.calls.every((call) => !/draftOrderCreate|draftOrderDelete|orderUpdate/.test(call.query)));
  return 'PASS: full refund resets only invoice-blocking tags; repeat webhook makes no writes';
});

await check('Refunded shipping is charged once at the current combined tier in the next manual cycle', async () => {
  const nodes = [fixture(1, 2), fixture(2, 4, { productTags: ['group'], tags: readyTags })];
  const state = paymentAdmin(nodes);
  await paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund(state.admin, refundPayload, shop);
  const { admin, calls } = cycleAdmin(nodes, { createdDraftId: newDraft, drafts: { [oldDraft]: { id: oldDraft, status: 'COMPLETED', order: { displayFinancialStatus: 'REFUNDED' } } } });
  const events = [];
  const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async (event) => { events.push(event); return { ok: true }; } } });
  const run = w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle;
  const preview = await run(admin, { shop, dryRun: true });
  assert.equal(preview.results[0].itemCount, 6);
  assert.equal(preview.results[0].shippingAmount, '23.26 CAD');
  assert.ok(calls.every((call) => !call.query.includes('mutation')));
  assert.equal(events.length, 0);
  const live = await run(admin, { shop, dryRun: false });
  assert.equal(live.results[0].draftOrderId, newDraft);
  assert.equal(live.results[0].shippingAmount, '23.26 CAD');
  assert.equal(events.length, 1);
  assert.equal(calls.filter((call) => call.query.includes('CreateThursdayDraft')).length, 1);
  assert.ok(nodes.every((node) => node.metafield.value === newDraft));
  const repeated = await run(admin, { shop, dryRun: false });
  assert.equal(repeated.customersProcessed, 0);
  assert.equal(events.length, 1);
  return 'PASS: preview 6 items / CAD 23.26; next manual run creates a fresh invoice once, not old amount plus new rate';
});

await check('Partial, pending and failed shipping refunds cannot reopen paid shipments', async () => {
  for (const status of ['PARTIALLY_REFUNDED', 'PAID', 'PENDING', 'AUTHORIZED', 'VOIDED']) {
    const state = paymentAdmin();
    state.invoice.displayFinancialStatus = status;
    await paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund(state.admin, refundPayload, shop);
    assert.ok(state.originals.get(orderId).tags.includes('shipping-paid'));
    assert.ok(state.calls.every((call) => !call.query.includes('mutation')), status);
  }
  return 'PASS: only the live fully-refunded state can reopen shipping';
});

await check('Product-order refunds cannot masquerade as shipping invoice refunds', async () => {
  const state = paymentAdmin();
  state.invoice.tags = ['ordinary-product-order'];
  await paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund(state.admin, refundPayload, shop);
  assert.ok(state.calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: shipping invoice identity required in addition to linked IDs';
});

await check('Old refund leaves newer invoices unchanged, even after an interrupted retry', async () => {
  for (const pending of [false, true]) {
    const state = paymentAdmin();
    const node = state.originals.get(orderId);
    node.metafield = { value: newDraft };
    if (pending) node.refund = { value: JSON.stringify({ invoiceId, draftId: oldDraft, state: 'pending' }) };
    await paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund(state.admin, refundPayload, shop);
    assert.ok(state.calls.every((call) => !call.query.includes('mutation')));
    assert.ok(node.tags.includes('shipping-paid') && node.tags.includes('thursday-email-sent'));
  }
  return 'PASS: the original must still be linked to the exact refunded invoice';
});

await check('Shipping refund does not resurrect cancelled/refunded/fulfilled or India-direct originals', async () => {
  const nodes = [fixture(1, 1, { cancelledAt: '2026-09-15T00:00:00Z' }), fixture(2, 1, { financial: 'REFUNDED' }), fixture(3, 1, { financial: 'PARTIALLY_REFUNDED' }), fixture(4, 1, { fulfillment: 'FULFILLED' }), fixture(5, 1, { tags: ['india-direct'] })];
  const state = paymentAdmin(nodes);
  await paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund(state.admin, refundPayload, shop);
  assert.ok(state.calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: ineligible originals remain excluded after an invoice refund';
});

await check('Every refund write failure is retryable without losing linkage', async () => {
  for (const failure of ['ShippingRefundReceipt:pending', 'ShippingRefundTagsRemove', 'ShippingRefundReceipt:complete']) {
    const state = paymentAdmin();
    const apply = paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund;
    state.failures.add(failure);
    await assert.rejects(() => apply(state.admin, refundPayload, shop), /rejected/i);
    assert.equal(state.originals.get(orderId).metafield.value, oldDraft);
    state.failures.clear();
    await apply(state.admin, refundPayload, shop);
    assert.equal(JSON.parse(state.originals.get(orderId).refund.value).state, 'complete');
    assert.ok(!state.originals.get(orderId).tags.includes('shipping-paid'));
  }
  return 'PASS: pending receipt, tag removal and completion failures all recover on retry';
});

await check('Paid tagging still works and a delayed paid webhook cannot undo a refund', async () => {
  const state = paymentAdmin();
  const node = state.originals.get(orderId);
  node.tags = ['thursday-email-sent', 'client-tag'];
  state.invoice.displayFinancialStatus = 'PAID';
  const handlers = paymentWorld().load('app/lib/orders-updated-webhook.server.ts');
  await handlers.processShippingPaidTagging(state.admin, { id: '999', financial_status: 'paid' }, shop);
  assert.ok(node.tags.includes('shipping-paid') && node.tags.includes('client-tag'));
  state.invoice.displayFinancialStatus = 'REFUNDED';
  await handlers.processShippingInvoiceRefund(state.admin, refundPayload, shop);
  await handlers.processShippingPaidTagging(state.admin, { id: '999', financial_status: 'paid' }, shop);
  assert.ok(!node.tags.includes('shipping-paid'));
  return 'PASS: normal payment tags originals, delayed paid delivery respects the live refund';
});

await check('Missing or conflicting shipping references fail safely', async () => {
  for (const scenario of ['missingOrder', 'missingDraft', 'noReference', 'conflict', 'incompleteDraft']) {
    const state = paymentAdmin();
    if (scenario === 'missingOrder') state.originals.delete(orderId);
    if (scenario === 'missingDraft') state.drafts.delete(oldDraft);
    if (scenario === 'noReference') state.originals.get(orderId).metafield = null;
    if (scenario === 'conflict') state.originals.get(orderId).legacyDraft = { value: newDraft };
    if (scenario === 'incompleteDraft') state.drafts.set(oldDraft, null);
    await assert.rejects(() => paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund(state.admin, refundPayload, shop), /Cannot/);
    assert.ok(state.calls.every((call) => !call.query.includes('mutation')));
  }
  return 'PASS: unverified linkage never resets orders';
});

await check('Webhook routes request retries for payment/refund failures', async () => {
  for (const route of ['updated', 'created']) {
    let paidCalls = 0;
    let refundCalls = 0;
    const w = world({
      'app/shopify.server.ts': { authenticate: { webhook: async () => ({ topic: `ORDERS_${route}`, shop, admin: {}, payload: refundPayload }) } },
      'app/lib/orders-updated-webhook.server.ts': {
        processStatusEmailTags: async () => { throw new Error('isolated status-email failure'); },
        processShippingPaidTagging: async () => { paidCalls++; if (route === 'created') throw new Error('payment failed'); },
        processShippingInvoiceRefund: async () => { refundCalls++; throw new Error('refund failed'); },
        processPushedToNextWeekendVoid: async () => {},
      },
    });
    const response = await w.load(`app/routes/webhooks.orders.${route}.tsx`).action({ request: new Request('https://review.invalid/webhook', { method: 'POST' }) });
    assert.equal(response.status, 503);
    assert.equal(paidCalls, 1);
    assert.equal(refundCalls, route === 'updated' ? 1 : 0);
  }
  return 'PASS: payment/refund failures produce retryable responses even when status emails fail separately';
});

await check('Existing unpaid invoice is reused only when its eligible orders and payable amount still match', async () => {
  for (const mismatch of ['none', 'orders', 'amount', 'currency']) {
    const nodes = [fixture(1, 2)];
    nodes[0].metafield = { value: oldDraft };
    const draft = {
      id: oldDraft, name: '#D100', invoiceUrl: 'https://review.invalid/existing', status: 'OPEN', order: null,
      customAttributes: [{ key: 'source_order_ids', value: mismatch === 'orders' ? `${orderId},gid://shopify/Order/2` : orderId }],
      totalPriceSet: { presentmentMoney: { amount: mismatch === 'amount' ? '23.26' : '19.52', currencyCode: mismatch === 'currency' ? 'USD' : 'CAD' } },
    };
    const { admin, calls } = cycleAdmin(nodes, { drafts: { [oldDraft]: draft } });
    let sent = 0;
    const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async () => { sent++; return { ok: true }; } } });
    const result = await w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: false });
    assert.equal(sent, mismatch === 'none' ? 1 : 0);
    if (mismatch !== 'none') assert.match(result.results[0].error, /no longer matches/);
    assert.ok(calls.every((call) => !call.query.includes('CreateThursdayDraft')));
  }
  return 'PASS: valid retry reuses the invoice; changed order group, rate or currency blocks a stale payment link';
});

await check('Completed paid or partially refunded invoices cannot be reused or fully recharged', async () => {
  for (const financial of ['PAID', 'PARTIALLY_REFUNDED']) {
    const node = fixture(1);
    node.metafield = { value: oldDraft };
    const { admin, calls } = cycleAdmin([node], { drafts: { [oldDraft]: { id: oldDraft, status: 'COMPLETED', order: { displayFinancialStatus: financial } } } });
    const result = await world().load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: false });
    assert.match(result.results[0].error, /not fully refunded/);
    assert.ok(calls.every((call) => !call.query.includes('CreateThursdayDraft')));
  }
  return 'PASS: a completed non-refunded draft cannot become a duplicate invoice';
});

await check('Several previously refunded invoices can consolidate into one next-cycle invoice', async () => {
  const nodes = [fixture(1, 2), fixture(2, 4)];
  nodes[0].metafield = { value: oldDraft };
  nodes[1].metafield = { value: newDraft };
  const thirdDraft = 'gid://shopify/DraftOrder/300';
  const drafts = Object.fromEntries([oldDraft, newDraft].map((id) => [id, { id, status: 'COMPLETED', order: { displayFinancialStatus: 'REFUNDED' } }]));
  const { admin, calls } = cycleAdmin(nodes, { drafts, createdDraftId: thirdDraft });
  const w = world({ 'app/lib/klaviyo.server.ts': { sendThursdayInvoiceEmail: async () => ({ ok: true }) } });
  const result = await w.load('app/lib/thursday-cycle.server.ts').runThursdayCycle(admin, { shop, dryRun: false });
  assert.equal(result.results[0].draftOrderId, thirdDraft);
  assert.equal(result.results[0].shippingAmount, '23.26 CAD');
  assert.equal(calls.filter((call) => call.query.includes('CreateThursdayDraft')).length, 1);
  return 'PASS: refunded historical draft IDs do not block customer consolidation';
});

await check('Shipping invoice source attributes accept legacy IDs and remove duplicates', async () => {
  const state = paymentAdmin();
  state.invoice.customAttributes = [{ key: 'source_order_ids', value: '1' }, { key: 'linked_order_ids', value: JSON.stringify([orderId, 1]) }];
  await paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingInvoiceRefund(state.admin, refundPayload, shop);
  assert.equal(state.calls.filter((call) => call.query.includes('query ShippingPaymentOriginal')).length, 1);
  assert.equal(JSON.parse(state.originals.get(orderId).refund.value).state, 'complete');
  return 'PASS: numeric and GID attributes resolve to one original order';
});

await check('Late payment for an older invoice cannot mark a newer shipment paid', async () => {
  const state = paymentAdmin();
  const node = state.originals.get(orderId);
  node.metafield = { value: newDraft };
  node.tags = ['thursday-email-sent'];
  state.invoice.displayFinancialStatus = 'PAID';
  await paymentWorld().load('app/lib/orders-updated-webhook.server.ts').processShippingPaidTagging(state.admin, { id: '999', financial_status: 'paid' }, shop);
  assert.ok(!node.tags.includes('shipping-paid'));
  assert.ok(state.calls.every((call) => !call.query.includes('mutation')));
  return 'PASS: paid state is scoped to the same linked shipping invoice';
});

await check('Pay link redirects to a live invoice and fails gracefully once the draft is gone', async () => {
  let draft = { id: oldDraft, status: 'OPEN', invoiceUrl: 'https://review.invalid/checkout/1', order: null };
  const admin = { graphql: async (query) => {
    assert.ok(query.includes('ThursdayPayDraft'), `Unexpected pay operation: ${query}`);
    return { json: async () => ({ data: { draftOrder: draft } }) };
  } };
  const w = world({ 'app/shopify.server.ts': { unauthenticated: { admin: async () => ({ admin }) } } });
  const link = w.load('app/lib/thursday-wait-link.server.ts').buildThursdayPayUrl({ shop, draftId: oldDraft, orderIds: [orderId] });
  const loader = w.load('app/routes/shipping.pay.tsx').loader;

  const ok = await loader({ request: new Request(link) });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), draft.invoiceUrl);

  // Friday reset (or anything else) deleted the draft after the email went out.
  draft = null;
  const deleted = await loader({ request: new Request(link) });
  assert.equal(deleted.status, 409);

  // Draft completed (paid) via another channel: friendly "already paid" page, not a generic error.
  draft = { id: oldDraft, status: 'COMPLETED', invoiceUrl: 'https://review.invalid/checkout/1', order: { id: 'gid://shopify/Order/999' } };
  const completed = await loader({ request: new Request(link) });
  assert.equal(completed.status, 200);
  assert.ok((await completed.text()).includes('Shipping Already Paid'));

  // A wait-purpose link must not work as a pay link, and vice versa.
  const waitLink = w.load('app/lib/thursday-wait-link.server.ts').buildThursdayWaitUrl({ shop, draftId: oldDraft, orderIds: [orderId] });
  const crossUse = await loader({ request: new Request(waitLink) });
  assert.equal(crossUse.status, 400);

  return 'PASS: pay link resolves live draft state and rejects a wait link';
});

for (const result of results) console.log(JSON.stringify(result));
console.log(`verify-thursday-workflow: ${results.filter((result) => !result.failed).length}/${results.length} scenarios passed`);
