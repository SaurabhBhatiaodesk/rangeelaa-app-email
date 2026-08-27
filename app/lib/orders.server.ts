import {
  hasTag,
  isSkirtDeposit,
  normalizeTags,
  type StatusAction,
} from "./tags";
import type { PreorderWorkflowTags } from "./klaviyo-settings.server";
import { isAllowedShippingCountry, type LineItemInfo } from "./cycle-shared.server";
import {
  classifyOrder,
  countPreorderProductShippingItems,
  countRtwShippingItems,
  hasAnyPreorderProductTag,
  hasIndiaDirectSignal,
} from "./product-eligibility.server";

export type ShippingOrder = {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  tags: string[];
  displayFulfillmentStatus: string | null;
  customerName: string | null;
  shippingCity: string | null;
  shippingCountryCode: string | null;
  lineItems: LineItemInfo[];
  isSkirtDeposit: boolean;
  needsShippingPaidAlert: boolean;
};

export type ShippingWorkflowSummary = {
  readyToShipCount: number;
  awaitingPaymentCount: number;
  nextShippingLabel: string;
};

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

const ORDER_NODE_FIELDS = `
  id
  name
  email
  createdAt
  tags
  displayFulfillmentStatus
  customer {
    displayName
  }
  shippingAddress {
    city
    countryCodeV2
  }
  lineItems(first: 250) {
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

async function fetchOrdersByQuery(
  admin: AdminGraphql,
  query: string,
  first: number,
  skirtDepositTags: { groupTag: string; partialTag: string },
): Promise<ShippingOrder[]> {
  const response = await admin.graphql(
    `#graphql
      query ShippingManagerOrders($first: Int!, $query: String!) {
        orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              ${ORDER_NODE_FIELDS}
            }
          }
        }
      }`,
    { variables: { first, query } },
  );

  const json = await response.json();

  if (json.errors?.length) {
    const message = json.errors
      .map((e: { message: string }) => e.message)
      .join("; ");
    throw new Error(message);
  }

  const edges = json.data?.orders?.edges ?? [];

  return edges.map((edge: { node: Record<string, unknown> }) => {
    const node = edge.node;
    const tags = normalizeTags(node.tags as string[] | string);
    const customer = node.customer as { displayName?: string } | null;
    const shipping = node.shippingAddress as
      | { city?: string; countryCodeV2?: string }
      | null;
    const lineEdges =
      (
        node.lineItems as {
          edges: { node: Record<string, unknown> }[];
        }
      )?.edges ?? [];

    const lineItems: LineItemInfo[] = lineEdges.map((lineEdge) => {
      const line = lineEdge.node;
      const product = line.product as { tags?: string[] | string } | null;
      return {
        title: String(line.title || ""),
        quantity: Number(line.quantity || 0),
        requiresShipping: line.requiresShipping !== false,
        productTags: normalizeTags(product?.tags),
      };
    });

    return {
      id: node.id as string,
      name: node.name as string,
      email: (node.email as string | null) || null,
      createdAt: node.createdAt as string,
      tags,
      displayFulfillmentStatus:
        (node.displayFulfillmentStatus as string | null) ?? null,
      customerName: customer?.displayName ?? null,
      shippingCity: shipping?.city ?? null,
      shippingCountryCode: shipping?.countryCodeV2 ?? null,
      lineItems,
      isSkirtDeposit: isSkirtDeposit(
        tags,
        skirtDepositTags.groupTag,
        skirtDepositTags.partialTag,
      ),
      needsShippingPaidAlert: false,
    } satisfies ShippingOrder;
  });
}

function hasPreorderProductTag(
  order: ShippingOrder,
  workflowTags: PreorderWorkflowTags,
): boolean {
  return hasAnyPreorderProductTag(order, workflowTags);
}

function isThursdayCandidateOrder(
  order: ShippingOrder,
  workflowTags: PreorderWorkflowTags,
): boolean {
  const classification = classifyOrder(order, workflowTags);
  if (classification === "india_direct") return false;
  if (classification === "preorder") {
    return countPreorderProductShippingItems(order, workflowTags) > 0;
  }
  return countRtwShippingItems(order) > 0;
}

/**
 * Preorders for the status UI: still awaiting readiness, plus recently completed
 * (arrived / ready-to-ship) so the client can see checked steps.
 * Skirt deposits (group + partial) stay until deposit-fulfilled.
 */
export async function fetchAwaitingReadinessOrders(
  admin: AdminGraphql,
  workflowTags: PreorderWorkflowTags,
): Promise<ShippingOrder[]> {
  const skirtDepositTags = {
    groupTag: workflowTags.groupTag,
    partialTag: workflowTags.partialTag,
  };

  const awaitingQuery = [
    "status:open",
    `-tag:${workflowTags.readyToShipTag}`,
    `-tag:${workflowTags.arrivedInCanadaTag}`,
    `-tag:${workflowTags.depositFulfilledTag}`,
  ].join(" AND ");

  const completedQuery = [
    "status:open",
    `(tag:${workflowTags.arrivedInCanadaTag} OR tag:${workflowTags.readyToShipTag})`,
  ].join(" AND ");

  const [awaiting, completed] = await Promise.all([
    fetchOrdersByQuery(admin, awaitingQuery, 75, skirtDepositTags),
    fetchOrdersByQuery(admin, completedQuery, 40, skirtDepositTags),
  ]);

  const awaitingFiltered = awaiting.filter((order) => {
    if (!hasPreorderProductTag(order, workflowTags)) {
      return false;
    }
    if (order.isSkirtDeposit) return true;
    const status = (order.displayFulfillmentStatus || "").toUpperCase();
    return status !== "FULFILLED";
  });

  const byId = new Map<string, ShippingOrder>();
  for (const order of awaitingFiltered) {
    byId.set(order.id, order);
  }
  for (const order of completed) {
    if (!hasPreorderProductTag(order, workflowTags)) {
      continue;
    }
    if (!byId.has(order.id)) {
      byId.set(order.id, order);
    }
  }

  const isComplete = (order: ShippingOrder) =>
    hasTag(order.tags, workflowTags.arrivedInCanadaTag) ||
    hasTag(order.tags, workflowTags.readyToShipTag) ||
    (order.isSkirtDeposit &&
      hasTag(order.tags, workflowTags.depositFulfilledTag));

  return Array.from(byId.values()).sort((a, b) => {
    const aDone = isComplete(a) ? 1 : 0;
    const bDone = isComplete(b) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function formatNextShippingLabel(): string {
  const value =
    process.env.NEXT_SHIPPING_DATE ||
    process.env.THURSDAY_NEXT_SHIPPING_DATE ||
    "";
  if (!value.trim()) return "Not set";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.trim();

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export async function fetchShippingWorkflowSummary(
  admin: AdminGraphql,
  workflowTags: PreorderWorkflowTags,
): Promise<ShippingWorkflowSummary> {
  const skirtDepositTags = {
    groupTag: workflowTags.groupTag,
    partialTag: workflowTags.partialTag,
  };

  const [preorderReadyOrders, rtwReadyOrders, awaitingPaymentOrders] =
    await Promise.all([
    fetchOrdersByQuery(
      admin,
      [
        "status:open",
        `tag:${workflowTags.pieceMadeTag}`,
        `tag:${workflowTags.leavingForCanadaTag}`,
        `tag:${workflowTags.arrivedInCanadaTag}`,
        `-tag:${workflowTags.shippingPaidTag}`,
        `-tag:${workflowTags.holdForNextCycleTag}`,
      ].join(" AND "),
      250,
      skirtDepositTags,
    ),
    fetchOrdersByQuery(
      admin,
      [
        "status:open",
        "financial_status:paid",
        "fulfillment_status:unfulfilled",
        `-tag:${workflowTags.shippingPaidTag}`,
        `-tag:${workflowTags.holdForNextCycleTag}`,
      ].join(" AND "),
      250,
      skirtDepositTags,
    ),
    fetchOrdersByQuery(
      admin,
      [
        "status:open",
        `tag:${workflowTags.thursdayEmailSentTag}`,
        `-tag:${workflowTags.shippingPaidTag}`,
      ].join(" AND "),
      250,
      skirtDepositTags,
    ),
  ]);

  const readyById = new Map<string, ShippingOrder>();
  for (const order of [...preorderReadyOrders, ...rtwReadyOrders]) {
    if (isThursdayCandidateOrder(order, workflowTags)) {
      readyById.set(order.id, order);
    }
  }

  return {
    readyToShipCount: readyById.size,
    awaitingPaymentCount: awaitingPaymentOrders.filter((order) =>
      isThursdayCandidateOrder(order, workflowTags),
    ).length,
    nextShippingLabel: formatNextShippingLabel(),
  };
}

/**
 * Task 3: new qualifying orders placed after the customer already has shipping-paid.
 */
export async function fetchShippingPaidAlerts(
  admin: AdminGraphql,
  workflowTags: PreorderWorkflowTags,
): Promise<ShippingOrder[]> {
  const skirtDepositTags = {
    groupTag: workflowTags.groupTag,
    partialTag: workflowTags.partialTag,
  };

  const paidOrders = await fetchOrdersByQuery(
    admin,
    `tag:${workflowTags.shippingPaidTag}`,
    75,
    skirtDepositTags,
  );
  const eligiblePaidOrders = paidOrders.filter((order) =>
    isThursdayCandidateOrder(order, workflowTags),
  );

  const paidEmails = new Set(
    eligiblePaidOrders
      .map((o) => o.email?.toLowerCase())
      .filter((e): e is string => Boolean(e)),
  );

  if (paidEmails.size === 0) return [];

  const candidates = await fetchOrdersByQuery(
    admin,
    [
      "status:open",
      `-tag:${workflowTags.shippingPaidTag}`,
      `-tag:${workflowTags.holdForNextCycleTag}`,
      `(fulfillment_status:unfulfilled OR fulfillment_status:partial)`,
    ].join(" AND "),
    75,
    skirtDepositTags,
  );

  // Latest shipping-paid date per email — alert only for orders placed after that.
  const latestPaidByEmail = new Map<string, string>();
  for (const paid of eligiblePaidOrders) {
    if (!paid.email) continue;
    const key = paid.email.toLowerCase();
    const existing = latestPaidByEmail.get(key);
    if (!existing || paid.createdAt > existing) {
      latestPaidByEmail.set(key, paid.createdAt);
    }
  }

  return candidates
    .filter((order) => {
      if (!order.email) return false;
      const key = order.email.toLowerCase();
      if (!paidEmails.has(key)) return false;
      const latestPaidAt = latestPaidByEmail.get(key);
      if (!latestPaidAt) return false;
      if (order.createdAt <= latestPaidAt) return false;
      if (!isThursdayCandidateOrder(order, workflowTags)) {
        return false;
      }

      const city = (order.shippingCity || "").toLowerCase();
      if (city === "saskatoon") return false;

      if (!isAllowedShippingCountry(order, workflowTags)) return false;

      if (hasIndiaDirectSignal(order, workflowTags)) return false;

      return true;
    })
    .map((order) => ({ ...order, needsShippingPaidAlert: true }));
}

export async function addOrderTags(
  admin: AdminGraphql,
  orderId: string,
  tags: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await admin.graphql(
    `#graphql
      mutation AddOrderTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node {
            ... on Order {
              id
              tags
            }
          }
          userErrors {
            message
          }
        }
      }`,
    { variables: { id: orderId, tags } },
  );

  const json = await response.json();
  const userErrors = json.data?.tagsAdd?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e: { message: string }) => e.message).join(", ") };
  }
  return { ok: true };
}

async function getOrderSnapshot(
  admin: AdminGraphql,
  orderId: string,
): Promise<{ email: string | null; tags: string[]; lineItems: LineItemInfo[] } | null> {
  const response = await admin.graphql(
    `#graphql
      query OrderSnapshot($id: ID!) {
        order(id: $id) {
          email
          tags
          lineItems(first: 250) {
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
        }
      }`,
    { variables: { id: orderId } },
  );
  const json = await response.json();
  const order = json.data?.order;
  if (!order) return null;
  const lineEdges =
    (
      order.lineItems as {
        edges?: Array<{
          node?: {
            title?: string;
            quantity?: number;
            requiresShipping?: boolean;
            product?: { tags?: string[] | string } | null;
          };
        }>;
      }
    )?.edges ?? [];

  return {
    email: order.email || null,
    tags: normalizeTags(order.tags),
    lineItems: lineEdges.map((lineEdge) => ({
      title: String(lineEdge.node?.title || ""),
      quantity: Number(lineEdge.node?.quantity || 0),
      requiresShipping: lineEdge.node?.requiresShipping !== false,
      productTags: normalizeTags(lineEdge.node?.product?.tags),
    })),
  };
}

export async function applyStatusAction(
  admin: AdminGraphql,
  orderId: string,
  action: StatusAction,
  options: {
    workflowTags: PreorderWorkflowTags;
  },
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { workflowTags } = options;
  const snapshot = await getOrderSnapshot(admin, orderId);
  if (!snapshot) {
    return { ok: false, error: "Order not found" };
  }
  if (
    !hasAnyPreorderProductTag(snapshot, workflowTags) &&
    !isThursdayCandidateOrder(
      { ...snapshot, id: orderId } as ShippingOrder,
      workflowTags,
    )
  ) {
    return {
      ok: false,
      error: "Order is not eligible for this app workflow",
    };
  }

  const { tags } = snapshot;

  if (action === "hold_for_next_cycle") {
    if (hasTag(tags, workflowTags.holdForNextCycleTag)) {
      return { ok: true, message: "Already held for next Thursday" };
    }
    const result = await addOrderTags(admin, orderId, [
      workflowTags.holdForNextCycleTag,
    ]);
    if (!result.ok) return result;
    return { ok: true, message: "Held for next Thursday" };
  }

  return {
    ok: false,
    error:
      "Status tags are added in Shipping Manager. This app only listens for those tags and sends Klaviyo emails.",
  };
}
