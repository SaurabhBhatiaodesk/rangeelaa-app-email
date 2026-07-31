/**
 * Phase 2 helper verification — pure pool/tag rules (no Shopify API).
 * Run: npx tsx scripts/verify-thursday-rules.ts
 */
import {
  countBillablePhysicalShippingItems,
  countCanadaDispatchItems,
  countPhysicalShippingItems,
  hasIndiaItems,
  isAllowedShippingCountry,
  isSaskatoon,
  passesCycleTagGate,
  type CycleOrder,
  type LineItemInfo,
} from "../app/lib/cycle-shared.server";
import { TAGS } from "../app/lib/tags";

function order(partial: Partial<CycleOrder> & { tags: string[] }): CycleOrder {
  return {
    id: partial.id || "gid://shopify/Order/1",
    name: partial.name || "#1001",
    email: partial.email ?? "a@test.com",
    tags: partial.tags,
    createdAt: partial.createdAt || "2026-01-01T00:00:00Z",
    displayFinancialStatus: partial.displayFinancialStatus ?? "PAID",
    displayFulfillmentStatus: partial.displayFulfillmentStatus ?? "UNFULFILLED",
    shippingCity: partial.shippingCity ?? "Toronto",
    shippingCountryCode: partial.shippingCountryCode ?? "CA",
    shippingAddress: null,
    customerId: null,
    customerName: null,
    lineItems: partial.lineItems ?? [],
    thursdayDraftId: null,
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const canadaItem: LineItemInfo = {
  title: "Dress",
  quantity: 2,
  productTags: ["canada"],
  requiresShipping: true,
};
const indiaItem: LineItemInfo = {
  title: "India piece",
  quantity: 1,
  productTags: ["india"],
  requiresShipping: true,
};
const virtualItem: LineItemInfo = {
  title: "Digital add-on",
  quantity: 5,
  productTags: [],
  requiresShipping: false,
};

assert(
  passesCycleTagGate([TAGS.ARRIVED_IN_CANADA, TAGS.READY_TO_SHIP]),
  "ready preorder should pass gate",
);
assert(
  !passesCycleTagGate([TAGS.THURSDAY_EMAIL_SENT]),
  "thursday-email-sent should block",
);
assert(
  !passesCycleTagGate([TAGS.SHIPPING_PAID]),
  "shipping-paid should block",
);
assert(
  passesCycleTagGate([TAGS.SHIPPING_PAID, TAGS.HOLD_FOR_NEXT_CYCLE]),
  "hold-for-next-cycle overrides shipping-paid",
);

const sask = order({
  tags: [],
  shippingCity: "Saskatoon",
  shippingCountryCode: "CA",
});
assert(isSaskatoon(sask), "Saskatoon detect");
assert(isAllowedShippingCountry(sask), "CA shipping");
assert(
  isAllowedShippingCountry(
    order({ tags: [], shippingCountryCode: "GB" }),
    { allowedShippingCountryCodes: "CA,US,GB" },
  ),
  "GB shipping can be allowed from settings",
);

assert(countCanadaDispatchItems([canadaItem, indiaItem]) === 2, "count canada only");
assert(hasIndiaItems([canadaItem, indiaItem]), "detect india");
assert(!hasIndiaItems([canadaItem]), "no india");
assert(
  countPhysicalShippingItems([canadaItem, virtualItem]) === 2,
  "count physical items only",
);
assert(
  countBillablePhysicalShippingItems([canadaItem, indiaItem, virtualItem]) === 3,
  "count all physical items only",
);

console.log("verify-thursday-rules: all assertions passed");
