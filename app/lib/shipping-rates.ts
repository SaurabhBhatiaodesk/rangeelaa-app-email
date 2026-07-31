/** Configurable CAD shipping rates by billable physical item count. */
export function shippingAmountForItemCount(itemCount: number): string {
  const raw = process.env.SHIPPING_RATE_TIERS_JSON;
  // Default tiers — replace via SHIPPING_RATE_TIERS_JSON when client confirms.
  let tiers: Record<string, string> = {
    "1": "15.00",
    "2": "22.00",
    "3": "28.00",
    "4": "34.00",
    "5": "40.00",
  };

  if (raw) {
    try {
      tiers = JSON.parse(raw) as Record<string, string>;
    } catch {
      // keep defaults
    }
  }

  if (itemCount <= 0) return "0.00";

  const exact = tiers[String(itemCount)];
  if (exact) return exact;

  const keys = Object.keys(tiers)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  if (keys.length === 0) return "0.00";

  const maxKey = keys[keys.length - 1]!;
  if (itemCount > maxKey) {
    const perExtra = process.env.SHIPPING_RATE_PER_EXTRA || "5.00";
    const base = Number(tiers[String(maxKey)] || "0");
    const extra = (itemCount - maxKey) * Number(perExtra);
    return (base + extra).toFixed(2);
  }

  // nearest lower tier
  const lower = [...keys].reverse().find((k) => k <= itemCount) ?? keys[0]!;
  return tiers[String(lower)] || "0.00";
}

export const SHIPPING_CURRENCY =
  process.env.SHIPPING_CURRENCY || "CAD";
