import {
  hasTag,
  isSkirtDeposit,
  normalizeTags,
  TAGS,
  type StatusAction,
  type StatusEmailAction,
} from "./tags";
import type {
  PreorderWorkflowLabels,
  PreorderWorkflowTags,
} from "./klaviyo-settings.server";
import { sendStatusEmailIfNeeded } from "./send-status-email.server";
import {
  countBillablePhysicalShippingItems,
  isAllowedShippingCountry,
  type LineItemInfo,
} from "./cycle-shared.server";

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
      return {
        title: String(line.title || ""),
        quantity: Number(line.quantity || 0),
        requiresShipping: line.requiresShipping !== false,
        productTags: [],
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
    if (order.isSkirtDeposit) return true;
    const status = (order.displayFulfillmentStatus || "").toUpperCase();
    return status !== "FULFILLED";
  });

  const byId = new Map<string, ShippingOrder>();
  for (const order of awaitingFiltered) {
    byId.set(order.id, order);
  }
  for (const order of completed) {
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

async function fetchOrderCount(
  admin: AdminGraphql,
  query: string,
): Promise<number> {
  const response = await admin.graphql(
    `#graphql
      query ShippingWorkflowOrderCount($query: String!) {
        ordersCount(query: $query) {
          count
        }
      }`,
    { variables: { query } },
  );

  const json = await response.json();
  if (json.errors?.length) {
    const message = json.errors
      .map((e: { message: string }) => e.message)
      .join("; ");
    throw new Error(message);
  }

  return Number(json.data?.ordersCount?.count ?? 0);
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
  const [readyToShipCount, awaitingPaymentCount] = await Promise.all([
    fetchOrderCount(
      admin,
      [
        "status:open",
        `tag:${workflowTags.readyToShipTag}`,
        `-tag:${workflowTags.shippingPaidTag}`,
        `-tag:${workflowTags.holdForNextCycleTag}`,
      ].join(" AND "),
    ),
    fetchOrderCount(
      admin,
      [
        "status:open",
        `tag:${workflowTags.thursdayEmailSentTag}`,
        `-tag:${workflowTags.shippingPaidTag}`,
      ].join(" AND "),
    ),
  ]);

  return {
    readyToShipCount,
    awaitingPaymentCount,
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

  const paidEmails = new Set(
    paidOrders
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
  for (const paid of paidOrders) {
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

      const city = (order.shippingCity || "").toLowerCase();
      if (city === "saskatoon") return false;

      if (!isAllowedShippingCountry(order, workflowTags)) return false;

      if (hasTag(order.tags, TAGS.INDIA_DIRECT)) return false;
      if (countBillablePhysicalShippingItems(order.lineItems) < 1) {
        return false;
      }

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
): Promise<{ email: string | null; tags: string[] } | null> {
  const response = await admin.graphql(
    `#graphql
      query OrderSnapshot($id: ID!) {
        order(id: $id) {
          email
          tags
        }
      }`,
    { variables: { id: orderId } },
  );
  const json = await response.json();
  const order = json.data?.order;
  if (!order) return null;
  return {
    email: order.email || null,
    tags: normalizeTags(order.tags),
  };
}

async function sendStatusEmailNow(
  admin: AdminGraphql,
  options: {
    orderId: string;
    email: string | null;
    tagsAfterUpdate: string[];
    statusAction: StatusEmailAction;
    shop: string;
    workflowTags: PreorderWorkflowTags;
  },
): Promise<string> {
  const result = await sendStatusEmailIfNeeded(admin, {
    orderId: options.orderId,
    email: options.email,
    tags: options.tagsAfterUpdate,
    statusAction: options.statusAction,
    shop: options.shop,
    workflowTags: options.workflowTags,
  });

  if (!result.ok) return `email failed: ${result.error}`;
  if (result.skipped) return "email already sent or unavailable";
  return "Klaviyo email sent";
}

export async function applyStatusAction(
  admin: AdminGraphql,
  orderId: string,
  action: StatusAction,
  options: {
    workflowTags: PreorderWorkflowTags;
    labels: PreorderWorkflowLabels;
    shop: string;
  },
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { workflowTags, labels, shop } = options;
  const snapshot = await getOrderSnapshot(admin, orderId);
  if (!snapshot) {
    return { ok: false, error: "Order not found" };
  }

  const { tags } = snapshot;

  if (action === "deposit_fulfilled") {
    if (!isSkirtDeposit(tags, workflowTags.groupTag, workflowTags.partialTag)) {
      return { ok: false, error: "Order is not a skirt deposit (group + partial)" };
    }
    const result = await addOrderTags(admin, orderId, [
      workflowTags.depositFulfilledTag,
    ]);
    if (!result.ok) return result;
    return { ok: true, message: "Deposit marked fulfilled" };
  }

  if (action === "hold_for_next_cycle") {
    if (hasTag(tags, workflowTags.holdForNextCycleTag)) {
      return { ok: true, message: "Already held for next Thursday cycle" };
    }
    const result = await addOrderTags(admin, orderId, [
      workflowTags.holdForNextCycleTag,
    ]);
    if (!result.ok) return result;
    return { ok: true, message: "Held for next Thursday cycle" };
  }

  if (action === "piece_made") {
    if (hasTag(tags, workflowTags.pieceMadeTag)) {
      return { ok: false, error: `${labels.pieceMade} already marked` };
    }
    const tagResult = await addOrderTags(admin, orderId, [
      workflowTags.pieceMadeTag,
    ]);
    if (!tagResult.ok) return tagResult;
    const emailStatus = await sendStatusEmailNow(admin, {
      orderId,
      email: snapshot.email,
      tagsAfterUpdate: [...tags, workflowTags.pieceMadeTag],
      statusAction: "piece_made",
      shop,
      workflowTags,
    });
    return {
      ok: true,
      message: `${labels.pieceMade} tagged (${emailStatus})`,
    };
  }

  if (action === "leaving_for_canada") {
    if (!hasTag(tags, workflowTags.pieceMadeTag)) {
      return { ok: false, error: `Complete ${labels.pieceMade} first` };
    }
    if (hasTag(tags, workflowTags.leavingForCanadaTag)) {
      return {
        ok: false,
        error: `${labels.leavingForCanada} already marked`,
      };
    }
    const tagResult = await addOrderTags(admin, orderId, [
      workflowTags.leavingForCanadaTag,
    ]);
    if (!tagResult.ok) return tagResult;
    const emailStatus = await sendStatusEmailNow(admin, {
      orderId,
      email: snapshot.email,
      tagsAfterUpdate: [...tags, workflowTags.leavingForCanadaTag],
      statusAction: "leaving_for_canada",
      shop,
      workflowTags,
    });
    return {
      ok: true,
      message: `${labels.leavingForCanada} tagged (${emailStatus})`,
    };
  }

  if (action === "arrived_in_canada") {
    if (!hasTag(tags, workflowTags.leavingForCanadaTag)) {
      return {
        ok: false,
        error: `Complete ${labels.leavingForCanada} first`,
      };
    }
    if (hasTag(tags, workflowTags.arrivedInCanadaTag)) {
      return { ok: false, error: `${labels.arrivedInCanada} already marked` };
    }
    const tagResult = await addOrderTags(admin, orderId, [
      workflowTags.arrivedInCanadaTag,
      workflowTags.readyToShipTag,
    ]);
    if (!tagResult.ok) return tagResult;
    const emailStatus = await sendStatusEmailNow(admin, {
      orderId,
      email: snapshot.email,
      tagsAfterUpdate: [
        ...tags,
        workflowTags.arrivedInCanadaTag,
        workflowTags.readyToShipTag,
      ],
      statusAction: "arrived_in_canada",
      shop,
      workflowTags,
    });
    return {
      ok: true,
      message: `${labels.arrivedInCanada} + ready-to-ship tagged (${emailStatus})`,
    };
  }

  return { ok: false, error: "Unknown action" };
}
