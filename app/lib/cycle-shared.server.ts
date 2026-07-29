import { TAGS } from "./tags";

export type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type LineItemInfo = {
  quantity: number;
  title: string;
  productTags: string[];
};

export type CycleOrder = {
  id: string;
  name: string;
  email: string | null;
  tags: string[];
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  shippingCity: string | null;
  shippingCountryCode: string | null;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    countryCode: string | null;
    zip: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  customerId: string | null;
  customerName: string | null;
  lineItems: LineItemInfo[];
  thursdayDraftId: string | null;
};

export function productHasTag(tags: string[], tag: string): boolean {
  return tags.some((t) => t.toLowerCase() === tag.toLowerCase());
}

export function countCanadaDispatchItems(lineItems: LineItemInfo[]): number {
  return lineItems.reduce((sum, item) => {
    const isCanada = productHasTag(item.productTags, "canada");
    const isDispatch = productHasTag(item.productTags, "dispatch");
    if (isCanada || isDispatch) return sum + item.quantity;
    return sum;
  }, 0);
}

export function hasIndiaItems(lineItems: LineItemInfo[]): boolean {
  return lineItems.some((item) => productHasTag(item.productTags, "india"));
}

export function isCanadaOrUsShipping(order: CycleOrder): boolean {
  const country = (order.shippingCountryCode || "").toUpperCase();
  return country === "CA" || country === "US";
}

export function isSaskatoon(order: CycleOrder): boolean {
  return (order.shippingCity || "").trim().toLowerCase() === "saskatoon";
}

export type CycleGateTags = {
  holdForNextCycleTag: string;
  thursdayEmailSentTag: string;
  shippingPaidTag: string;
};

/** Eligible unless already tagged — hold-for-next-cycle overrides shipping-paid / thursday-email-sent. */
export function passesCycleTagGate(
  tags: string[],
  gateTags: CycleGateTags = {
    holdForNextCycleTag: TAGS.HOLD_FOR_NEXT_CYCLE,
    thursdayEmailSentTag: TAGS.THURSDAY_EMAIL_SENT,
    shippingPaidTag: TAGS.SHIPPING_PAID,
  },
): boolean {
  const lower = tags.map((t) => t.toLowerCase());
  const hasHold = lower.includes(gateTags.holdForNextCycleTag.toLowerCase());
  if (hasHold) return true;

  if (lower.includes(gateTags.thursdayEmailSentTag.toLowerCase())) return false;
  if (lower.includes(gateTags.shippingPaidTag.toLowerCase())) return false;
  return true;
}

export async function graphqlJson(
  admin: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(
      json.errors.map((e: { message: string }) => e.message).join("; "),
    );
  }
  return json;
}
