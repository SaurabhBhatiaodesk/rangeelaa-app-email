import { hasTag, normalizeTags } from "./tags";
import {
  type AdminGraphql,
  type LineItemInfo,
  graphqlJson,
} from "./cycle-shared.server";

export type ProductTaggedOrder = {
  lineItems: Array<Pick<LineItemInfo, "productTags">>;
};

export function hasConfiguredProductTag(
  order: ProductTaggedOrder,
  productTag: string,
): boolean {
  return order.lineItems.some((lineItem) =>
    hasTag(lineItem.productTags, productTag),
  );
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
