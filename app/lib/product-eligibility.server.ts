import { hasTag, normalizeTags } from "./tags";
import {
  type AdminGraphql,
  type LineItemInfo,
  graphqlJson,
} from "./cycle-shared.server";

export type ProductTaggedOrder = {
  lineItems: Array<
    Pick<LineItemInfo, "productTags"> &
      Partial<Pick<LineItemInfo, "quantity" | "requiresShipping">>
  >;
};

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
