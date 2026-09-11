import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_WAIT_PATH = "/shipping/wait";

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
  shop: string;
  draftId: string;
  orderIds: string[];
  exp: string;
}) {
  return [
    input.shop,
    input.draftId,
    [...input.orderIds].sort().join(","),
    input.exp,
  ].join("|");
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

export function buildThursdayWaitUrl(input: {
  shop: string;
  draftId: string;
  orderIds: string[];
}) {
  const base = waitBaseUrl();
  if (!base || !input.draftId || input.orderIds.length === 0) return "";

  const exp = String(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 21);
  const payload = canonicalPayload({ ...input, exp });
  const sig = sign(payload);
  if (!sig) return "";

  const url = new URL(DEFAULT_WAIT_PATH, base);
  url.searchParams.set("shop", input.shop);
  url.searchParams.set("draft", input.draftId);
  url.searchParams.set("orders", input.orderIds.join(","));
  url.searchParams.set("exp", exp);
  url.searchParams.set("sig", sig);
  return url.toString();
}

export function verifyThursdayWaitUrl(url: URL):
  | { ok: true; shop: string; draftId: string; orderIds: string[] }
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
    return { ok: false, error: "This wait link is missing required details." };
  }

  const expiresAt = Number(exp);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "This wait link has expired." };
  }

  const expected = sign(canonicalPayload({ shop, draftId, orderIds, exp }));
  if (!expected || !safeEqualHex(sig, expected)) {
    return { ok: false, error: "This wait link is not valid." };
  }

  return { ok: true, shop, draftId, orderIds };
}
