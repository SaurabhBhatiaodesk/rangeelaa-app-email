import { hasTag, normalizeTags } from "./tags";
import {
  type AdminGraphql,
  type LineItemInfo,
  graphqlJson,
} from "./cycle-shared.server";
import type { PreorderWorkflowTags } from "./klaviyo-settings.server";

export type ProductTaggedOrder = {
  tags?: string[];
  lineItems: Array<
    Pick<LineItemInfo, "productTags"> &
      Partial<Pick<LineItemInfo, "quantity" | "requiresShipping">>
  >;
};

export type OrderClassification = "preorder" | "rtw" | "india_direct";

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

export function preorderProductTags(
  workflowTags: Pick<
    PreorderWorkflowTags,
    "groupTag" | "preorderProductTag"
  >,
): string[] {
  return uniqueTags([
    workflowTags.groupTag || "group",
    "dispatch skirt",
    workflowTags.preorderProductTag || "Web Saree",
  ]);
}

export function hasAnyPreorderProductTag(
  order: ProductTaggedOrder,
  workflowTags: Pick<
    PreorderWorkflowTags,
    "groupTag" | "preorderProductTag"
  >,
): boolean {
  const tags = preorderProductTags(workflowTags);
  return order.lineItems.some((lineItem) =>
    tags.some((tag) => hasTag(lineItem.productTags, tag)),
  );
}

export function hasConfiguredProductTag(
  order: ProductTaggedOrder,
  productTag: string,
): boolean {
  return order.lineItems.some((lineItem) =>
    hasTag(lineItem.productTags, productTag),
  );
}

export function countConfiguredProductShippingItems(
  order: ProductTaggedOrder,
  productTag: string,
): number {
  return order.lineItems.reduce((sum, lineItem) => {
    if (lineItem.requiresShipping === false) return sum;
    if (!hasTag(lineItem.productTags, productTag)) return sum;
    return sum + Number(lineItem.quantity || 0);
  }, 0);
}

export function hasIndiaDirectSignal(
  order: ProductTaggedOrder,
  workflowTags: Pick<PreorderWorkflowTags, "indiaItemTag">,
): boolean {
  if (hasTag(order.tags ?? [], "india-direct")) return true;
  const indiaTag = workflowTags.indiaItemTag || "india";
  return order.lineItems.some((lineItem) =>
    hasTag(lineItem.productTags, indiaTag),
  );
}

export function classifyOrder(
  order: ProductTaggedOrder,
  workflowTags: Pick<
    PreorderWorkflowTags,
    "groupTag" | "preorderProductTag" | "indiaItemTag"
  >,
): OrderClassification {
  if (hasIndiaDirectSignal(order, workflowTags)) return "india_direct";
  if (hasAnyPreorderProductTag(order, workflowTags)) return "preorder";
  return "rtw";
}

export function countPreorderProductShippingItems(
  order: ProductTaggedOrder,
  workflowTags: Pick<
    PreorderWorkflowTags,
    "groupTag" | "preorderProductTag"
  >,
): number {
  const tags = preorderProductTags(workflowTags);
  return order.lineItems.reduce((sum, lineItem) => {
    if (lineItem.requiresShipping === false) return sum;
    if (!tags.some((tag) => hasTag(lineItem.productTags, tag))) return sum;
    return sum + Number(lineItem.quantity || 0);
  }, 0);
}

export function countRtwShippingItems(order: ProductTaggedOrder): number {
  return order.lineItems.reduce((sum, lineItem) => {
    if (lineItem.requiresShipping === false) return sum;
    return sum + Number(lineItem.quantity || 0);
  }, 0);
}

export async function orderHasConfiguredProductTag(
  admin: AdminGraphql,
  orderId: string,
  productTag: string,
): Promise<boolean> {
  const json = await graphqlJson(
    admin,
    `#graphql
      query ProductEligibilityOrder($id: ID!) {
        order(id: $id) {
          lineItems(first: 250) {
            edges {
              node {
                product {
                  tags
                }
              }
            }
          }
        }
      }`,
    { id: orderId },
  );

  const edges =
    (
      json.data?.order?.lineItems as {
        edges?: Array<{ node?: { product?: { tags?: string[] | string } | null } }>;
      }
    )?.edges ?? [];

  return edges.some((edge) =>
    hasTag(normalizeTags(edge.node?.product?.tags), productTag),
  );
}
