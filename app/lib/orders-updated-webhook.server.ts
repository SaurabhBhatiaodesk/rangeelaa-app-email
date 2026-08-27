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
      if (attr?.name === "linked_order_ids" && attr?.value) {
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
  if (value.startsWith("gid://")) return value;
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
  if (!order || classifyOrder(order, settings.preorderTags) !== "preorder") {
    return;
  }

  let tags = normalizeTags(orderPayload?.tags);
  let email = orderPayload?.email ?? null;

  if (tags.length === 0) tags = order.tags;
  if (!email) email = order.email;

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
  const invoiceId =
    String(orderPayload.admin_graphql_api_id || orderPayload.id || "unknown");
  const financialStatus = String(orderPayload.financial_status || "").toLowerCase();

  if (financialStatus !== "paid") {
    console.log("shipping-paid tagging skipped; invoice not paid:", invoiceId);
    return;
  }

  console.log("paid invoice detected:", invoiceId);

  const settings = await getShopSettings(shop);
  const shippingPaidTag = settings.preorderTags.shippingPaidTag;
  const linkedOrderIds = extractLinkedOrderIdsFromPayload(orderPayload);
  if (linkedOrderIds.length === 0) {
    console.log("No linked original orders found on paid invoice:", invoiceId);
    return;
  }

  console.log(
    "linked original orders found for paid invoice:",
    invoiceId,
    linkedOrderIds,
  );

  for (const linkedId of linkedOrderIds) {
    const linkedOrderGid = normalizeOrderGid(linkedId);
    if (!linkedOrderGid) {
      console.log("skipped linked order because ID is invalid:", linkedId);
      continue;
    }

    try {
      const linkedOrder = await fetchOrderForClassification(admin, linkedOrderGid);
      if (
        !linkedOrder ||
        classifyOrder(linkedOrder, settings.preorderTags) === "india_direct"
      ) {
        console.log(
          `skipped tagging order ${linkedId} (India Direct or not found)`,
        );
        continue;
      }

      const fetchRes = (await graphqlJson(
        admin,
        `#graphql
          query GetOrderTags($id: ID!) {
            order(id: $id) {
              id
              tags
            }
          }
        `,
        { id: linkedOrderGid },
      )) as OrderTagsResponse;

      const existingTags = fetchRes.data?.order?.tags ?? [];
      const tagsArray = Array.isArray(existingTags)
        ? existingTags
        : String(existingTags || "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);

      if (
        tagsArray.some(
          (t: string) => t.toLowerCase() === shippingPaidTag.toLowerCase(),
        )
      ) {
        console.log(
          `skipped tagging order ${linkedId} (already has ${shippingPaidTag})`,
        );
        continue;
      }

      const updatedTags = Array.from(
        new Set([...tagsArray, shippingPaidTag]),
      ).join(", ");

      const updateRes = (await graphqlJson(
        admin,
        `#graphql
          mutation OrderUpdate($input: OrderInput!) {
            orderUpdate(input: $input) {
              order { id tags }
              userErrors { field message }
            }
          }
        `,
        {
          input: {
            id: linkedOrderGid,
            tags: updatedTags,
          },
        },
      )) as OrderTagsResponse;

      const userErrors = updateRes.data?.orderUpdate?.userErrors;
      if (Array.isArray(userErrors) && userErrors.length > 0) {
        console.error("Failed to add shipping-paid tag to order", linkedId, userErrors);
      } else {
        console.log("shipping-paid tag added to order", linkedId);
      }
    } catch (error) {
      console.error("Failed to process linked order", linkedId, error);
    }
  }
}

/**
 * Task 4b: if Shopify Flow (or anything else) added `pushed-to-next-weekend`
 * directly, void the linked Thursday draft — Flow can flip tags but cannot
 * call the Admin API draft mutation itself. Idempotent: no-op if the draft
 * metafield is already cleared (e.g. the manual Friday backup already ran).
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
