import { unauthenticated } from "../shopify.server";

/**
 * Cron routes: Authorization: Bearer <CRON_SECRET>
 * Optional header X-Shopify-Shop-Domain, else CRON_SHOP env.
 */
export async function authenticateCron(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return {
      ok: false as const,
      status: 500,
      error: "CRON_SECRET is not configured",
    };
  }

  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== secret) {
    return { ok: false as const, status: 401, error: "Unauthorized" };
  }

  const shop =
    request.headers.get("x-shopify-shop-domain") ||
    process.env.CRON_SHOP ||
    "";

  if (!shop) {
    return {
      ok: false as const,
      status: 400,
      error: "Missing shop. Set CRON_SHOP or X-Shopify-Shop-Domain.",
    };
  }

  const { admin } = await unauthenticated.admin(shop);
  return { ok: true as const, admin, shop };
}
