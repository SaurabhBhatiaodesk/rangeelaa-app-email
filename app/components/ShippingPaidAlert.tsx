import type { ShippingOrder } from "../lib/orders.server";
import { shopifyAdminOrderPath } from "../lib/shopify-links";

type Props = {
  order: ShippingOrder;
  busy: boolean;
  onHold: (orderId: string) => void;
};

export function ShippingPaidAlert({ order, busy, onHold }: Props) {
  const orderAdminPath = shopifyAdminOrderPath(order.id);

  return (
    <s-banner
      heading={`${order.name} — new item after shipping was paid`}
      tone="info"
    >
      <s-stack direction="block" gap="base">
        <s-paragraph color="base">
          {order.customerName || order.email || "Customer"} bought a new
          item after shipping was already paid. Ship now (manual) or hold
          for next Thursday?
        </s-paragraph>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {orderAdminPath ? (
            <s-button variant="secondary" href={orderAdminPath}>
              Ship now (manual)
            </s-button>
          ) : (
            <>
              <s-button variant="secondary" disabled>
                Ship now (manual)
              </s-button>
              <s-text tone="critical">
                Could not open this order — its Shopify order ID looks
                invalid.
              </s-text>
            </>
          )}
          <s-button
            variant="primary"
            disabled={busy}
            {...(busy ? { loading: true } : {})}
            onClick={() => onHold(order.id)}
          >
            Hold for next cycle
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
