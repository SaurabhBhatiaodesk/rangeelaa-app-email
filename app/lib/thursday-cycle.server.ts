import { TAGS, hasTag, normalizeTags } from "./tags";
import {
  shippingAmountForItemCount,
  SHIPPING_CURRENCY,
} from "./shipping-rates";
import {
  type AdminGraphql,
  type CycleGateTags,
  type CycleOrder,
  type ItemRoutingTags,
  type LineItemInfo,
  countPhysicalShippingItems,
  graphqlJson,
  isAllowedShippingCountry,
  isSaskatoon,
  passesCycleTagGate,
} from "./cycle-shared.server";
import { sendThursdayInvoiceEmail } from "./klaviyo.server";
import {
  getShopSettings,
  type PreorderWorkflowTags,
} from "./klaviyo-settings.server";

const META_NAMESPACE = "rangeela";
const META_DRAFT_KEY = "thursday_draft_id";
const SIDEKICK_META_NAMESPACE = "sidekick";
const SIDEKICK_META_DRAFT_KEY = "draft_order_id";

const CYCLE_ORDER_FIELDS = `
  id
  name
  email
  createdAt
  tags
  displayFinancialStatus
  displayFulfillmentStatus
  customer {
    id
    displayName
  }
  shippingAddress {
    address1
    address2
    city
    provinceCode
    countryCodeV2
    zip
    firstName
    lastName
    phone
  }
  metafield(namespace: "${META_NAMESPACE}", key: "${META_DRAFT_KEY}") {
    value
  }
  lineItems(first: 100) {
    edges {
      node {
        title
        quantity
        requiresShipping
        product {
          tags
        }
      }
    }
  }
`;

function mapOrder(node: Record<string, unknown>): CycleOrder {
  const tags = normalizeTags(node.tags as string[] | string);
  const customer = node.customer as
    | { id?: string; displayName?: string }
    | null;
  const shipping = node.shippingAddress as Record<string, string | null> | null;
  const metafield = node.metafield as { value?: string } | null;
  const lineEdges =
    (
      node.lineItems as {
        edges: { node: Record<string, unknown> }[];
      }
    )?.edges ?? [];

  const lineItems: LineItemInfo[] = lineEdges.map((edge) => {
    const li = edge.node;
    const product = li.product as { tags?: string[] | string } | null;
    return {
      title: String(li.title || ""),
      quantity: Number(li.quantity || 0),
      requiresShipping: li.requiresShipping !== false,
      productTags: normalizeTags(product?.tags),
    };
  });

  return {
    id: node.id as string,
    name: node.name as string,
    email: (node.email as string | null) || null,
    tags,
    createdAt: node.createdAt as string,
    displayFinancialStatus:
      (node.displayFinancialStatus as string | null) ?? null,
    displayFulfillmentStatus:
      (node.displayFulfillmentStatus as string | null) ?? null,
    shippingCity: shipping?.city ?? null,
    shippingCountryCode: shipping?.countryCodeV2 ?? null,
    shippingAddress: shipping
      ? {
          address1: shipping.address1 ?? null,
          address2: shipping.address2 ?? null,
          city: shipping.city ?? null,
          provinceCode: shipping.provinceCode ?? null,
          countryCode: shipping.countryCodeV2 ?? null,
          zip: shipping.zip ?? null,
          firstName: shipping.firstName ?? null,
          lastName: shipping.lastName ?? null,
          phone: shipping.phone ?? null,
        }
      : null,
    customerId: customer?.id ?? null,
    customerName: customer?.displayName ?? null,
    lineItems,
    thursdayDraftId: metafield?.value ?? null,
  };
}

async function fetchCycleOrders(
  admin: AdminGraphql,
  query: string,
  first = 100,
): Promise<CycleOrder[]> {
  const json = await graphqlJson(
    admin,
    `#graphql
      query ThursdayCycleOrders($first: Int!, $query: String!) {
        orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              ${CYCLE_ORDER_FIELDS}
            }
          }
        }
      }`,
    { first, query },
  );

  return (json.data?.orders?.edges ?? []).map(
    (e: { node: Record<string, unknown> }) => mapOrder(e.node),
  );
}

function isPool1Preorder(
  order: CycleOrder,
  arrivedInCanadaTag: string,
  readyToShipTag: string,
  gateTags: CycleGateTags,
  routingTags: ItemRoutingTags,
): boolean {
  if (!hasTag(order.tags, arrivedInCanadaTag)) return false;
  if (!hasTag(order.tags, readyToShipTag)) return false;
  if (!passesCycleTagGate(order.tags, gateTags)) return false;
  if (isSaskatoon(order)) return false;
  if (!isAllowedShippingCountry(order, routingTags)) return false;
  if (isIndiaDirect(order)) return false;
  return countPhysicalShippingItems(order.lineItems) > 0;
}

function isPool2Rtw(
  order: CycleOrder,
  gateTags: CycleGateTags,
  routingTags: ItemRoutingTags,
): boolean {
  const financial = (order.displayFinancialStatus || "").toUpperCase();
  const fulfillment = (order.displayFulfillmentStatus || "").toUpperCase();
  if (financial !== "PAID") return false;
  if (fulfillment !== "UNFULFILLED") return false;
  if (!passesCycleTagGate(order.tags, gateTags)) return false;
  if (isSaskatoon(order)) return false;
  if (!isAllowedShippingCountry(order, routingTags)) return false;
  if (isIndiaDirect(order)) return false;
  if (countPhysicalShippingItems(order.lineItems) < 1) return false;

  return true;
}

function billableItemCount(order: CycleOrder): number {
  if (isIndiaDirect(order)) return 0;
  return countPhysicalShippingItems(order.lineItems);
}

function isIndiaDirect(order: CycleOrder): boolean {
  return hasTag(order.tags, TAGS.INDIA_DIRECT);
}

export type ThursdayCustomerResult = {
  email: string;
  orderNames: string[];
  itemCount: number;
  shippingAmount: string;
  draftOrderId?: string;
  invoiceUrl?: string;
  emailSent?: boolean;
  error?: string;
};

export type ThursdayCycleResult = {
  ok: boolean;
  dryRun: boolean;
  customersProcessed: number;
  results: ThursdayCustomerResult[];
  error?: string;
  message: string;
};

async function addTags(
  admin: AdminGraphql,
  id: string,
  tags: string[],
) {
  console.log("Thursday cycle addTags request", { id, tags });
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation CycleTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
    { id, tags },
  );
  const errors = json.data?.tagsAdd?.userErrors ?? [];
  if (errors.length) {
    const message = errors.map((e: { message: string }) => e.message).join(", ");
    console.error("Thursday cycle addTags failed", { id, tags, message });
    throw new Error(message);
  }
  console.log("Thursday cycle addTags succeeded", { id, tags });
}

async function removeTags(
  admin: AdminGraphql,
  id: string,
  tags: string[],
) {
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation CycleTagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
    { id, tags },
  );
  const errors = json.data?.tagsRemove?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((e: { message: string }) => e.message).join(", "));
  }
}

async function setDraftMetafield(
  admin: AdminGraphql,
  orderId: string,
  draftId: string,
) {
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation SetThursdayDraftMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { message }
        }
      }`,
    {
      metafields: [
        {
          ownerId: orderId,
          namespace: META_NAMESPACE,
          key: META_DRAFT_KEY,
          type: "single_line_text_field",
          value: draftId,
        },
        {
          ownerId: orderId,
          namespace: SIDEKICK_META_NAMESPACE,
          key: SIDEKICK_META_DRAFT_KEY,
          type: "single_line_text_field",
          value: draftId,
        },
      ],
    },
  );
  const errors = json.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      errors.map((e: { message: string }) => e.message).join(", "),
    );
  }
}

async function createShippingDraft(
  admin: AdminGraphql,
  orders: CycleOrder[],
  email: string,
  amount: string,
  linkedOrderIds: Array<string | number>,
): Promise<{ id: string; invoiceUrl: string | null; name: string }> {
  // Human-readable note per client spec (e.g. "Combined orders: #1234, #1235").
  // linked_order_ids goes in customAttributes instead — draft order custom
  // attributes carry over to the real order's note_attributes once paid, which
  // is the primary (most reliable) strategy orders-updated-webhook.server.ts
  // uses to find the original orders to tag shipping-paid.
  const note = `Combined orders: ${orders.map((o) => o.name).join(", ")}`;
  const primary = orders[0]!;
  const address = primary.shippingAddress;

  const input: Record<string, unknown> = {
    email,
    note,
    tags: ["rangeela-thursday-shipping", "shipping-invoice"],
    customAttributes: [
      {
        key: "source_order_ids",
        value: orders.map((o) => o.id).join(","),
      },
      {
        key: "linked_order_ids",
        value: JSON.stringify(linkedOrderIds.map(String)),
      },
    ],
    lineItems: [
      {
        title: "Shipping fee",
        originalUnitPrice: amount,
        quantity: 1,
        requiresShipping: false,
      },
    ],
  };

  if (primary.customerId) {
    input.customerId = primary.customerId;
  }

  if (address?.address1 && address.city && address.countryCode && address.zip) {
    input.shippingAddress = {
      address1: address.address1,
      address2: address.address2,
      city: address.city,
      provinceCode: address.provinceCode,
      countryCode: address.countryCode,
      zip: address.zip,
      firstName: address.firstName,
      lastName: address.lastName,
      phone: address.phone,
    };
  }

  console.log("Thursday createShippingDraft input", {
    email,
    amount,
    linkedOrderIds,
    customerId: input.customerId,
    hasShippingAddress: Boolean(input.shippingAddress),
    lineItems: input.lineItems,
  });

  const json = await graphqlJson(
    admin,
    `#graphql
      mutation CreateThursdayDraft($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            invoiceUrl
          }
          userErrors { field message }
        }
      }`,
    { input },
  );

  console.log("Thursday draftOrderCreate response", {
    data: json.data,
    errors: json.errors,
  });

  const payload = json.data?.draftOrderCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) {
    const message = userErrors.map((e: { message: string }) => e.message).join(", ");
    console.error("Thursday draftOrderCreate userErrors", { message, userErrors });
    throw new Error(message);
  }

  const draft = payload.draftOrder;
  if (!draft?.id) {
    throw new Error("draftOrderCreate did not return a draft order ID");
  }
  return {
    id: draft.id,
    name: draft.name,
    invoiceUrl: draft.invoiceUrl,
  };
}

/**
 * Thursday cycle: pool preorders + RTW, combine by email, create one draft invoice,
 * email via Klaviyo, tag originals thursday-email-sent, clear hold/pushed tags.
 */
export async function runThursdayCycle(
  admin: AdminGraphql,
  options: { dryRun?: boolean; shop: string },
): Promise<ThursdayCycleResult> {
  const dryRun = Boolean(options.dryRun);
  const settings = await getShopSettings(options.shop);
  const workflowTags: PreorderWorkflowTags = settings.preorderTags;
  const arrivedInCanadaTag = workflowTags.arrivedInCanadaTag;
  const thursdayTemplateId = settings.klaviyoTemplates.thursdayTemplateId;
  const klaviyoApiKey = settings.klaviyoApiKey;
  const gateTags: CycleGateTags = {
    holdForNextCycleTag: workflowTags.holdForNextCycleTag,
    thursdayEmailSentTag: workflowTags.thursdayEmailSentTag,
    shippingPaidTag: workflowTags.shippingPaidTag,
  };

  const [pool1Raw, pool2Raw] = await Promise.all([
    fetchCycleOrders(
      admin,
      [
        "status:open",
        `tag:${arrivedInCanadaTag}`,
        `tag:${workflowTags.readyToShipTag}`,
      ].join(" AND "),
    ),
    fetchCycleOrders(
      admin,
      [
        "status:open",
        "financial_status:paid",
        "fulfillment_status:unfulfilled",
      ].join(" AND "),
    ),
  ]);

  const pool1 = pool1Raw.filter((order) =>
    isPool1Preorder(
      order,
      arrivedInCanadaTag,
      workflowTags.readyToShipTag,
      gateTags,
      workflowTags,
    ),
  );
  const pool2 = pool2Raw.filter((order) =>
    isPool2Rtw(order, gateTags, workflowTags),
  );

  const byId = new Map<string, CycleOrder>();
  for (const order of [...pool1, ...pool2]) {
    byId.set(order.id, order);
  }

  const byEmail = new Map<string, CycleOrder[]>();
  for (const order of byId.values()) {
    if (!order.email) continue;
    const key = order.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push(order);
    byEmail.set(key, list);
  }

  console.log("Thursday cycle candidate summary", {
    pool1: pool1.length,
    pool2: pool2.length,
    combinedCustomers: byEmail.size,
    totalOrders: byId.size,
  });

  const results: ThursdayCustomerResult[] = [];

  for (const [email, orders] of byEmail) {
    const itemCount = orders.reduce(
      (sum, order) => sum + billableItemCount(order),
      0,
    );
    if (itemCount <= 0) continue;

    const shippingAmount = shippingAmountForItemCount(itemCount);
    const orderNames = orders.map((o) => o.name);
    const customerName =
      orders.find((order) => order.customerName)?.customerName || email;
    const row: ThursdayCustomerResult = {
      email,
      orderNames,
      itemCount,
      shippingAmount: `${shippingAmount} ${SHIPPING_CURRENCY}`,
    };

    if (dryRun) {
      results.push(row);
      continue;
    }

    try {
      console.log("Thursday cycle processing customer", {
        email,
        orderIds: orders.map((o) => o.id),
        orderNames,
        itemCount,
        shippingAmount,
      });

      const draft = await createShippingDraft(
        admin,
        orders,
        email,
        shippingAmount,
        orders.map((o) => o.id),
      );
      console.log("Thursday createShippingDraft succeeded", {
        email,
        draftId: draft.id,
        invoiceUrl: draft.invoiceUrl,
        draftName: draft.name,
      });
      row.draftOrderId = draft.id;
      row.invoiceUrl = draft.invoiceUrl || undefined;

      const waitUrl =
        process.env.THURSDAY_WAIT_URL ||
        process.env.SHOPIFY_APP_URL ||
        "";

      console.log("Thursday sending invoice email", {
        email,
        invoiceUrl: draft.invoiceUrl,
        waitUrl,
        templateId: thursdayTemplateId,
        uniqueId: `thursday:${draft.id}`,
      });

      const emailResult = await sendThursdayInvoiceEmail({
        apiKey: klaviyoApiKey,
        email,
        customerName,
        invoiceUrl: draft.invoiceUrl || "",
        waitUrl,
        orderNames,
        itemCount,
        shippingAmount: row.shippingAmount,
        uniqueId: `thursday:${draft.id}`,
        templateId: thursdayTemplateId,
      });

      console.log("Thursday sendThursdayInvoiceEmail result", {
        emailResult,
        email,
        draftId: draft.id,
      });

      if (emailResult.ok && !emailResult.skipped) {
        row.emailSent = true;
      } else {
        const emailError =
          !emailResult.ok && "error" in emailResult
            ? emailResult.error
            : undefined;
        row.error = emailError
          ? `Invoice created; email pending: ${emailError}`
          : "Invoice created; email not sent.";
        row.emailSent = false;
        continue;
      }

      for (const order of orders) {
        await addTags(admin, order.id, [workflowTags.thursdayEmailSentTag]);
        await setDraftMetafield(admin, order.id, draft.id);

        const toRemove: string[] = [];
        if (hasTag(order.tags, workflowTags.pushedToNextWeekendTag)) {
          toRemove.push(workflowTags.pushedToNextWeekendTag);
        }
        if (hasTag(order.tags, workflowTags.holdForNextCycleTag)) {
          toRemove.push(workflowTags.holdForNextCycleTag);
        }
        if (toRemove.length) {
          await removeTags(admin, order.id, toRemove);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Thursday cycle error", {
        email,
        orderIds: orders.map((o) => o.id),
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      row.error = message;
    }

    results.push(row);
  }

  const rowErrors = results
    .map((r) => r.error)
    .filter(Boolean) as string[];

  return {
    ok: rowErrors.length === 0,
    dryRun,
    customersProcessed: results.length,
    results,
    error: rowErrors.length > 0 ? rowErrors.join("; ") : undefined,
    message: dryRun
      ? `Dry run: ${results.length} customer invoice(s) would be created`
      : `Thursday cycle finished: ${results.length} customer invoice(s)`,
  };
}

export async function previewThursdayPools(admin: AdminGraphql, shop: string) {
  const result = await runThursdayCycle(admin, { dryRun: true, shop });
  return result;
}
