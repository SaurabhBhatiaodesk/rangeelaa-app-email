import {
  graphqlJson,
  isCancelledOrRefundedOrder,
  type AdminGraphql,
} from "./cycle-shared.server";
import { classifyOrder } from "./product-eligibility.server";
import { hasTag, normalizeTags } from "./tags";
import type { PreorderWorkflowTags } from "./klaviyo-settings.server";

type RefundReceipt = {
  invoiceId: string;
  draftId: string;
  state: "pending" | "complete";
};

async function saveRefundReceipt(
  admin: AdminGraphql,
  orderId: string,
  receipt: RefundReceipt,
) {
  const json = await graphqlJson(
    admin,
    `#graphql
    mutation ShippingRefundReceipt($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    {
      metafields: [
        {
          ownerId: orderId,
          namespace: "rangeela",
          key: "shipping_refund_state",
          type: "json",
          value: JSON.stringify(receipt),
        },
      ],
    },
  );
  assertMutation(json.data?.metafieldsSet, "save shipping refund state");
}

function assertMutation(
  payload: { userErrors?: Array<{ message: string }> } | undefined,
  action: string,
) {
  if (!payload || payload.userErrors?.length) {
    throw new Error(
      `Cannot ${action}: ${payload?.userErrors?.map((error) => error.message).join("; ") || "missing response"}`,
    );
  }
}

/** Payment updates only reconcile state. Creating invoices and emailing stays in the manual cycle. */
export async function reconcileLinkedShippingOrders(
  admin: AdminGraphql,
  invoice: {
    id: string;
    financialStatus: "PAID" | "REFUNDED";
    linkedOrderIds: string[];
  },
  workflowTags: PreorderWorkflowTags,
) {
  const failures: string[] = [];
  const draftInvoices = new Map<string, string>();
  for (const orderId of invoice.linkedOrderIds) {
    try {
      const json = await graphqlJson(
        admin,
        `#graphql
        query ShippingPaymentOriginal($id: ID!) {
          order(id: $id) {
            id tags cancelledAt displayFinancialStatus displayFulfillmentStatus
            draft: metafield(namespace: "rangeela", key: "thursday_draft_id") { value }
            legacyDraft: metafield(namespace: "sidekick", key: "draft_order_id") { value }
            legacyThursdayDraft: metafield(namespace: "sidekick", key: "thursday_draft_id") { value }
            refund: metafield(namespace: "rangeela", key: "shipping_refund_state") { value }
            lineItems(first: 250) {
              edges { node { currentQuantity requiresShipping product { tags } } }
              pageInfo { hasNextPage }
            }
          }
        }`,
        { id: orderId },
      );
      const order = json.data?.order;
      if (!order) throw new Error(`Cannot load linked order ${orderId}`);
      if (isCancelledOrRefundedOrder(order)) {
        console.warn("Shipping invoice reconcile skipped: original order is cancelled/refunded", {
          orderId,
          invoiceId: invoice.id,
        });
        continue;
      }
      if (order.lineItems?.pageInfo?.hasNextPage) {
        throw new Error(
          `Cannot safely classify more than 250 line items on ${orderId}`,
        );
      }
      const taggedOrder = {
        tags: normalizeTags(order.tags),
        lineItems: (order.lineItems?.edges ?? [])
          .map(
            (edge: {
              node: {
                currentQuantity: number;
                requiresShipping: boolean;
                product?: { tags: string[] };
              };
            }) => ({
              quantity: edge.node.currentQuantity,
              requiresShipping: edge.node.requiresShipping,
              productTags: normalizeTags(edge.node.product?.tags),
            }),
          )
          .filter((item: { quantity: number }) => item.quantity > 0),
      };
      if (classifyOrder(taggedOrder, workflowTags) === "india_direct") {
        console.warn("Shipping invoice reconcile skipped: original order is India Direct", {
          orderId,
          invoiceId: invoice.id,
        });
        continue;
      }

      // Do not let an old payment/refund change an original that now belongs to a newer invoice.
      const draftIds = [
        ...new Set<string>(
          [
            order.draft?.value,
            order.legacyDraft?.value,
            order.legacyThursdayDraft?.value,
          ].filter(Boolean),
        ),
      ];
      if (draftIds.length !== 1) {
        throw new Error(`Cannot verify shipping invoice link for ${orderId}`);
      }
      const draftId = draftIds[0];
      if (!draftInvoices.has(draftId)) {
        const draftJson = await graphqlJson(
          admin,
          `#graphql
          query ShippingPaymentDraft($id: ID!) {
            draftOrder(id: $id) { id order { id } }
          }`,
          { id: draftId },
        );
        if (!draftJson.data?.draftOrder)
          throw new Error(`Cannot load shipping draft ${draftId}`);
        const paidOrderId = draftJson.data.draftOrder.order?.id;
        if (!paidOrderId) {
          throw new Error(`Cannot verify completed order for shipping draft ${draftId}`);
        }
        draftInvoices.set(draftId, paidOrderId);
      }
      if (draftInvoices.get(draftId) !== invoice.id) {
        console.warn(
          "Shipping invoice reconcile skipped: linked draft's completed order does not match this invoice",
          {
            orderId,
            draftId,
            invoiceId: invoice.id,
            draftResolvedToOrderId: draftInvoices.get(draftId),
          },
        );
        continue;
      }

      if (invoice.financialStatus === "PAID") {
        if (!hasTag(taggedOrder.tags, workflowTags.shippingPaidTag)) {
          const paid = await graphqlJson(
            admin,
            `#graphql
            mutation ShippingPaymentTagsAdd($id: ID!, $tags: [String!]!) {
              tagsAdd(id: $id, tags: $tags) { userErrors { message } }
            }`,
            { id: orderId, tags: [workflowTags.shippingPaidTag] },
          );
          assertMutation(paid.data?.tagsAdd, "mark shipping paid");
        }
        continue;
      }

      if (order.displayFulfillmentStatus === "FULFILLED") {
        console.warn("Shipping invoice refund reopen skipped: original order is already fulfilled", {
          orderId,
          invoiceId: invoice.id,
        });
        continue;
      }
      const previous: RefundReceipt | null = order.refund?.value
        ? JSON.parse(order.refund.value)
        : null;
      if (previous?.invoiceId === invoice.id && previous.state === "complete") {
        console.warn("Shipping invoice refund reopen skipped: already reconciled for this invoice", {
          orderId,
          invoiceId: invoice.id,
        });
        continue;
      }
      const receipt: RefundReceipt = {
        invoiceId: invoice.id,
        draftId,
        state: "pending",
      };
      await saveRefundReceipt(admin, orderId, receipt);
      const refunded = await graphqlJson(
        admin,
        `#graphql
        mutation ShippingRefundTagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) { userErrors { message } }
        }`,
        {
          id: orderId,
          tags: [
            workflowTags.shippingPaidTag,
            workflowTags.thursdayEmailSentTag,
          ],
        },
      );
      assertMutation(refunded.data?.tagsRemove, "reopen refunded shipping");
      // Keep the completed draft reference as history and retry identity. The next cycle
      // ignores fully refunded completed drafts and replaces the link with a fresh draft.
      await saveRefundReceipt(admin, orderId, {
        ...receipt,
        state: "complete",
      });
    } catch (error) {
      failures.push(
        `${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}
