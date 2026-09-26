import type { AdminGraphql } from "./cycle-shared.server";
import { graphqlJson } from "./cycle-shared.server";
import { hasTag, normalizeTags } from "./tags";
import { voidThursdayDraftForOrder } from "./friday-reset.server";
import { getShopSettings } from "./klaviyo-settings.server";
import { sendStatusEmailIfNeeded } from "./send-status-email.server";
import {
  classifyOrder,
  type ProductTaggedOrder,
} from "./product-eligibility.server";
import type { StatusEmailAction } from "./tags";
import { reconcileLinkedShippingOrders } from "./shipping-invoice-payment.server";

type WebhookNoteAttribute = {
  name?: string;
  value?: unknown;
};

type OrderWebhookPayload = {
  id?: string | number;
  admin_graphql_api_id?: string;
  financial_status?: string;
  email?: string | null;
  note_attributes?: WebhookNoteAttribute[];
  note?: string | null;
  tags?: string[] | string;
};

type OrderTagsResponse = {
  data?: {
    order?: {
      email?: string | null;
      tags?: string[] | string;
      lineItems?: {
        edges?: Array<{
          node?: {
            quantity?: number;
            requiresShipping?: boolean;
            product?: { tags?: string[] | string } | null;
          };
        }>;
      };
    } | null;
    orderUpdate?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };
};

function parseLinkedOrderIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .flatMap((item) =>
          typeof item === "string" || typeof item === "number"
            ? String(item).trim()
            : [],
        )
        .filter(Boolean);
    }
  } catch {
    // not JSON
  }

  return trimmed
    .split(/[\s,|,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractLinkedOrderIdsFromPayload(
  orderPayload: OrderWebhookPayload,
): string[] {
  const ids = new Set<string>();

  if (Array.isArray(orderPayload?.note_attributes)) {
    for (const attr of orderPayload.note_attributes) {
      if ((attr?.name === "linked_order_ids" || attr?.name === "source_order_ids") && attr?.value) {
        parseLinkedOrderIds(attr.value).forEach((id) => ids.add(id));
      }
    }
  }

  if (typeof orderPayload?.note === "string") {
    const note = orderPayload.note.trim();
    try {
      const parsed = JSON.parse(note);
      if (parsed?.linked_order_ids) {
        parseLinkedOrderIds(JSON.stringify(parsed.linked_order_ids)).forEach(
          (id) => ids.add(id),
        );
      }
    } catch {
      const match = note.match(/linked_order_ids\s*[:=]\s*([\d,\s|]+)/i);
      if (match?.[1]) {
        parseLinkedOrderIds(match[1]).forEach((id) => ids.add(id));
      }
    }
  }

  if (orderPayload?.tags) {
    const tags =
      typeof orderPayload.tags === "string"
        ? orderPayload.tags.split(",")
        : Array.isArray(orderPayload.tags)
        ? orderPayload.tags
        : [];
    for (const tag of tags) {
      const match = String(tag).match(/linked_order_ids\s*[:=]\s*([\d,\s|]+)/i);
      if (match?.[1]) {
        parseLinkedOrderIds(match[1]).forEach((id) => ids.add(id));
      }
    }
  }

  return [...ids];
}

function normalizeOrderGid(id: string): string | null {
  const value = String(id || "").trim();
  if (!value) return null;
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Order/${value}`;
  return null;
}

async function fetchOrderForClassification(
  admin: AdminGraphql,
  orderId: string,
): Promise<
  | (ProductTaggedOrder & {
      email: string | null;
      tags: string[];
    })
  | null
> {
  const res = (await graphqlJson(
    admin,
    `#graphql
      query OrderForClassification($id: ID!) {
        order(id: $id) {
          email
          tags
          lineItems(first: 250) {
            edges {
              node {
                quantity
                requiresShipping
                product {
                  tags
                }
              }
            }
          }
        }
      }
    `,
    { id: orderId },
  )) as OrderTagsResponse;

  const order = res.data?.order;
  if (!order) return null;

  const lineItems = (order.lineItems?.edges ?? []).map((edge) => ({
    quantity: Number(edge.node?.quantity || 0),
    requiresShipping: edge.node?.requiresShipping !== false,
    productTags: normalizeTags(edge.node?.product?.tags),
  }));

  return {
    email: order.email ?? null,
    tags: normalizeTags(order.tags),
    lineItems,
  };
}

const STATUS_EMAIL_ACTIONS: StatusEmailAction[] = [
  "piece_made",
  "leaving_for_canada",
  "arrived_in_canada",
];

export async function processStatusEmailTags(
  admin: AdminGraphql,
  orderPayload: OrderWebhookPayload,
  shop: string,
) {
  const orderGid = normalizeOrderGid(
    String(orderPayload?.admin_graphql_api_id || orderPayload?.id || ""),
  );
  if (!orderGid) return;

  const settings = await getShopSettings(shop);
  const order = await fetchOrderForClassification(admin, orderGid);
  if (!order || classifyOrder(order, settings.preorderTags) === "india_direct") {
    return;
  }

  const tags = Array.from(
    new Set([...order.tags, ...normalizeTags(orderPayload?.tags)]),
  );
  const email = orderPayload?.email ?? order.email;

  for (const statusAction of STATUS_EMAIL_ACTIONS) {
    const result = await sendStatusEmailIfNeeded(admin, {
      orderId: orderGid,
      email,
      tags,
      statusAction,
      shop,
      workflowTags: settings.preorderTags,
    });

    if (!result.ok) {
      console.error("status email webhook failed", {
        orderGid,
        statusAction,
        error: result.error,
      });
    }
  }
}

export async function processShippingPaidTagging(
  admin: AdminGraphql,
  orderPayload: OrderWebhookPayload,
  shop: string,
) {
  if (String(orderPayload.financial_status).toLowerCase() !== "paid") return;
  await processShippingInvoicePayment(admin, orderPayload, shop);
}

export async function processShippingInvoiceRefund(
  admin: AdminGraphql,
  orderPayload: OrderWebhookPayload,
  shop: string,
) {
  if (String(orderPayload.financial_status).toLowerCase() !== "refunded") return;
  await processShippingInvoicePayment(admin, orderPayload, shop);
}

async function processShippingInvoicePayment(
  admin: AdminGraphql,
  orderPayload: OrderWebhookPayload,
  shop: string,
) {
  const invoiceId = normalizeOrderGid(String(orderPayload.admin_graphql_api_id || orderPayload.id || ""));
  if (!invoiceId) return;
  // Webhooks can arrive out of order. Never reapply a stale paid/refunded payload.
  const json = await graphqlJson(admin, `#graphql
    query ShippingInvoicePayment($id: ID!) {
      order(id: $id) {
        id tags cancelledAt displayFinancialStatus note
        customAttributes { key value }
      }
    }`, { id: invoiceId });
  const invoice = json.data?.order;
  if (!invoice) throw new Error(`Cannot load shipping invoice ${invoiceId}`);
  const tags = normalizeTags(invoice.tags);
  if (!hasTag(tags, "rangeela-thursday-shipping") && !hasTag(tags, "shipping-invoice")) return;
  const financialStatus = invoice.displayFinancialStatus;
  if (financialStatus !== "PAID" && financialStatus !== "REFUNDED") return;
  if (financialStatus === "PAID" && invoice.cancelledAt) return;
  const linkedOrderIds = [...new Set(extractLinkedOrderIdsFromPayload({
    tags, note: invoice.note,
    note_attributes: (invoice.customAttributes ?? []).map((attr: { key: string; value: string }) => ({ name: attr.key, value: attr.value })),
  }).map(normalizeOrderGid).filter((id): id is string => Boolean(id)))];
  if (!linkedOrderIds.length) throw new Error(`Shipping invoice ${invoiceId} has no linked original orders`);
  const settings = await getShopSettings(shop);
  await reconcileLinkedShippingOrders(admin, { id: invoiceId, financialStatus, linkedOrderIds }, settings.preorderTags);
}

/**
 * Task 4b: if Shopify Flow (or anything else) added `pushed-to-next-weekend`
 * directly, void the linked Thursday draft — Flow can flip tags but cannot
 * call the Admin API draft mutation itself. Idempotent: no-op if the draft
 * metafield is already cleared (e.g. the manual Friday backup already ran),
 * and a no-op if the draft is still too new to reset (see friday-reset.server.ts).
 */
export async function processPushedToNextWeekendVoid(
  admin: AdminGraphql,
  orderPayload: OrderWebhookPayload,
  shop: string,
) {
  const settings = await getShopSettings(shop);
  const tags = normalizeTags(orderPayload?.tags);
  if (!hasTag(tags, settings.preorderTags.pushedToNextWeekendTag)) {
    return;
  }

  const orderGid = normalizeOrderGid(
    String(orderPayload?.admin_graphql_api_id || orderPayload?.id || ""),
  );
  if (!orderGid) {
    console.log("pushed-to-next-weekend void skipped; invalid order id");
    return;
  }

  try {
    const order = await fetchOrderForClassification(admin, orderGid);
    if (
      !order ||
      classifyOrder(order, settings.preorderTags) === "india_direct"
    ) {
      console.log(
        "pushed-to-next-weekend void skipped; India Direct or not found",
        orderGid,
      );
      return;
    }

    // Delivery may be delayed until after a newer cycle removed the wait marker.
    if (
      !hasTag(order.tags ?? [], settings.preorderTags.pushedToNextWeekendTag) ||
      hasTag(order.tags ?? [], settings.preorderTags.shippingPaidTag)
    ) {
      console.log(
        "pushed-to-next-weekend void skipped; order state moved on since the webhook fired",
        orderGid,
      );
      return;
    }

    const result = await voidThursdayDraftForOrder(admin, orderGid);
    if (!result.ok) {
      console.error(
        "Failed to void Thursday draft for pushed-to-next-weekend order",
        orderGid,
        result.error,
      );
    } else if (result.voided) {
      console.log("Voided Thursday draft for pushed-to-next-weekend order", orderGid);
    }
  } catch (error) {
    console.error(
      "Error voiding Thursday draft for pushed-to-next-weekend order",
      orderGid,
      error,
    );
  }
}
