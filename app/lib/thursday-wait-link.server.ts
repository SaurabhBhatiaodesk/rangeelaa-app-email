import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_WAIT_PATH = "/shipping/wait";
const DEFAULT_PAY_PATH = "/shipping/pay";

function signingSecret(): string {
  return (
    process.env.THURSDAY_WAIT_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    process.env.CRON_SECRET ||
    ""
  );
}

function waitBaseUrl(): string {
  const base =
    process.env.THURSDAY_WAIT_BASE_URL ||
    process.env.SHOPIFY_APP_URL ||
    "";
  return base.replace(/\/+$/, "");
}

function canonicalPayload(input: {
  purpose: "wait" | "pay";
  shop: string;
  draftId: string;
  orderIds: string[];
  exp: string;
}) {
  return [
    input.purpose,
    input.shop,
    input.draftId,
    [...input.orderIds].sort().join(","),
    input.exp,
  ].join("|");
}

/** Pre-existing wait links were signed without a purpose segment; keep verifying those so links already emailed to real customers do not break. */
function legacyWaitPayload(input: {
  shop: string;
  draftId: string;
  orderIds: string[];
  exp: string;
}) {
  return [input.shop, input.draftId, [...input.orderIds].sort().join(","), input.exp].join("|");
}

function sign(payload: string): string {
  const secret = signingSecret();
  if (!secret) return "";
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function buildSignedUrl(
  purpose: "wait" | "pay",
  path: string,
  input: { shop: string; draftId: string; orderIds: string[] },
) {
  const base = waitBaseUrl();
  if (!base || !input.draftId || input.orderIds.length === 0) return "";

  const exp = String(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 21);
  const payload = canonicalPayload({ purpose, ...input, exp });
  const sig = sign(payload);
  if (!sig) return "";

  const url = new URL(path, base);
  url.searchParams.set("shop", input.shop);
  url.searchParams.set("draft", input.draftId);
  url.searchParams.set("orders", input.orderIds.join(","));
  url.searchParams.set("exp", exp);
  url.searchParams.set("sig", sig);
  return url.toString();
}

export function buildThursdayWaitUrl(input: {
  shop: string;
  draftId: string;
  orderIds: string[];
}) {
  return buildSignedUrl("wait", DEFAULT_WAIT_PATH, input);
}

export function buildThursdayPayUrl(input: {
  shop: string;
  draftId: string;
  orderIds: string[];
}) {
  return buildSignedUrl("pay", DEFAULT_PAY_PATH, input);
}

function verifySignedUrl(
  purpose: "wait" | "pay",
  url: URL,
): { ok: true; shop: string; draftId: string; orderIds: string[] }
  | { ok: false; error: string } {
  const shop = url.searchParams.get("shop") || "";
  const draftId = url.searchParams.get("draft") || "";
  const orderIds = (url.searchParams.get("orders") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const exp = url.searchParams.get("exp") || "";
  const sig = url.searchParams.get("sig") || "";

  if (!shop || !draftId || orderIds.length === 0 || !exp || !sig) {
    return { ok: false, error: "This link is missing required details." };
  }

  const expiresAt = Number(exp);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "This link has expired." };
  }

  const expected = sign(canonicalPayload({ purpose, shop, draftId, orderIds, exp }));
  const legacyExpected =
    purpose === "wait" ? sign(legacyWaitPayload({ shop, draftId, orderIds, exp })) : "";
  const valid =
    (expected && safeEqualHex(sig, expected)) ||
    (legacyExpected && safeEqualHex(sig, legacyExpected));
  if (!valid) {
    return { ok: false, error: "This link is not valid." };
  }

  return { ok: true, shop, draftId, orderIds };
}

export function verifyThursdayWaitUrl(url: URL) {
  return verifySignedUrl("wait", url);
}

export function verifyThursdayPayUrl(url: URL) {
  return verifySignedUrl("pay", url);
}
