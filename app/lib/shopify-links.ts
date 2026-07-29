/**
 * Builds the `shopify://admin/...` deep link App Bridge uses to navigate
 * within the embedded Shopify Admin, without hardcoding the shop domain.
 */
export function shopifyAdminOrderPath(orderId: string | null | undefined): string | null {
  const numericId = (orderId ?? "").split("/").pop()?.trim();
  if (!numericId || !/^\d+$/.test(numericId)) return null;
  return `shopify://admin/orders/${numericId}`;
}
