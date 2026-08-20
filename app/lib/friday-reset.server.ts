import { hasTag, normalizeTags } from "./tags";
import {
  type AdminGraphql,
  graphqlJson,
} from "./cycle-shared.server";
import { getShopSettings } from "./klaviyo-settings.server";
import { hasConfiguredProductTag } from "./product-eligibility.server";

const META_NAMESPACE = "rangeela";
const META_DRAFT_KEY = "thursday_draft_id";
const SIDEKICK_META_NAMESPACE = "sidekick";
const SIDEKICK_META_DRAFT_KEY = "draft_order_id";
const SIDEKICK_META_THURSDAY_DRAFT_KEY = "thursday_draft_id";

export type FridayResetResult = {
  ok: boolean;
  dryRun: boolean;
  ordersProcessed: number;
  draftsDeleted: number;
  errors: string[];
  message: string;
};

type MutationOutcome = { ok: true } | { ok: false; error: string };

function userErrorsToMessage(
  userErrors: Array<{ message: string }> | undefined,
): string | null {
  if (!userErrors || userErrors.length === 0) return null;
  return userErrors.map((e) => e.message).join(", ");
}

function isDraftNotFoundMessage(message: string): boolean {
  return /draft order not found/i.test(message);
}

async function deleteDraftOrder(
  admin: AdminGraphql,
  draftId: string,
): Promise<MutationOutcome> {
  const del = await graphqlJson(
    admin,
    `#graphql
      mutation DeleteThursdayDraft($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) {
          deletedId
          userErrors { message }
        }
      }`,
    { input: { id: draftId } },
  );
  const error = userErrorsToMessage(del.data?.draftOrderDelete?.userErrors);
  if (error && isDraftNotFoundMessage(error)) return { ok: true };
  if (error) return { ok: false, error: `draft delete: ${error}` };
  return { ok: true };
}

async function removeTag(
  admin: AdminGraphql,
  orderId: string,
  tag: string,
): Promise<MutationOutcome> {
  const res = await graphqlJson(
    admin,
    `#graphql
      mutation FridayRemoveTag($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
    { id: orderId, tags: [tag] },
  );
  const error = userErrorsToMessage(res.data?.tagsRemove?.userErrors);
  if (error) return { ok: false, error: `remove tag "${tag}": ${error}` };
  return { ok: true };
}

async function addTag(
  admin: AdminGraphql,
  orderId: string,
  tag: string,
): Promise<MutationOutcome> {
  const res = await graphqlJson(
    admin,
    `#graphql
      mutation FridayAddTag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
    { id: orderId, tags: [tag] },
  );
  const error = userErrorsToMessage(res.data?.tagsAdd?.userErrors);
  if (error) return { ok: false, error: `add tag "${tag}": ${error}` };
  return { ok: true };
}

async function clearThursdayDraftMetafield(
  admin: AdminGraphql,
  orderId: string,
): Promise<MutationOutcome> {
  const res = await graphqlJson(
    admin,
    `#graphql
      mutation ClearThursdayDraftMetafield($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { key }
          userErrors { message }
        }
      }`,
    {
      metafields: [
        { ownerId: orderId, namespace: META_NAMESPACE, key: META_DRAFT_KEY },
        {
          ownerId: orderId,
          namespace: SIDEKICK_META_NAMESPACE,
          key: SIDEKICK_META_DRAFT_KEY,
        },
        {
          ownerId: orderId,
          namespace: SIDEKICK_META_NAMESPACE,
          key: SIDEKICK_META_THURSDAY_DRAFT_KEY,
        },
      ],
    },
  );
  const error = userErrorsToMessage(res.data?.metafieldsDelete?.userErrors);
  if (error) return { ok: false, error: `clear draft metafield: ${error}` };
  return { ok: true };
}

async function fetchOrderDraftMetafield(
  admin: AdminGraphql,
  orderId: string,
): Promise<{ id?: string; value?: string } | null> {
  const json = await graphqlJson(
    admin,
    `#graphql
      query OrderThursdayDraftMetafield($id: ID!) {
        order(id: $id) {
          metafield(namespace: "${META_NAMESPACE}", key: "${META_DRAFT_KEY}") {
            id
            value
          }
        }
      }`,
    { id: orderId },
  );
  return json.data?.order?.metafield ?? null;
}

/**
 * Voids (deletes) the Thursday draft order linked to `orderId`, if one is
 * still linked via the thursday_draft_id metafield. Idempotent — a no-op
 * (ok: true, voided: false) if there is no linked draft (already cleared).
 *
 * Shared by:
 * - the bulk Friday backup sweep (runFridayReset)
 * - the orders/updated webhook, which calls this when Shopify Flow adds
 *   `pushed-to-next-weekend` directly (Flow flips the tags; the app voids
 *   the draft since Flow cannot call the Admin API draft mutation itself).
 */
export async function voidThursdayDraftForOrder(
  admin: AdminGraphql,
  orderId: string,
): Promise<{ ok: boolean; voided: boolean; error?: string }> {
  const metafield = await fetchOrderDraftMetafield(admin, orderId);
  const draftId = metafield?.value;
  if (!draftId) {
    return { ok: true, voided: false };
  }

  const del = await deleteDraftOrder(admin, draftId);
  if (!del.ok) {
    return { ok: false, voided: false, error: del.error };
  }

  const cleared = await clearThursdayDraftMetafield(admin, orderId);
  if (!cleared.ok) {
    return { ok: false, voided: true, error: cleared.error };
  }

  return { ok: true, voided: true };
}

/**
 * Friday backup reset (primary path = Shopify Flow tags + orders/updated void).
 *
 * Backup when Flow did not run:
 * - delete linked draft order
 * - remove thursday-email-sent
 * - add pushed-to-next-weekend
 * - clear thursday draft metafield
 *
 * Note: adding pushed-to-next-weekend also triggers orders/updated, which voids
 * the draft if metafield still present — safe if draft already deleted here
 * (voidThursdayDraftForOrder is idempotent).
 */
export async function runFridayReset(
  admin: AdminGraphql,
  options: { dryRun?: boolean; shop: string },
): Promise<FridayResetResult> {
  const dryRun = Boolean(options.dryRun);
  const errors: string[] = [];
  let ordersProcessed = 0;
  let draftsDeleted = 0;

  const settings = await getShopSettings(options.shop);
  const thursdayEmailSentTag = settings.preorderTags.thursdayEmailSentTag;
  const shippingPaidTag = settings.preorderTags.shippingPaidTag;
  const pushedToNextWeekendTag = settings.preorderTags.pushedToNextWeekendTag;
  const preorderProductTag = settings.preorderTags.preorderProductTag;

  const json = await graphqlJson(
    admin,
    `#graphql
      query FridayUnpaidThursdayOrders($first: Int!, $query: String!) {
        orders(first: $first, query: $query) {
          edges {
            node {
              id
              name
              tags
              lineItems(first: 250) {
                edges {
                  node {
                    product {
                      tags
                    }
                  }
                }
              }
              metafield(namespace: "${META_NAMESPACE}", key: "${META_DRAFT_KEY}") {
                id
                value
              }
            }
          }
        }
      }`,
    {
      first: 100,
      query: `tag:${thursdayEmailSentTag} AND -tag:${shippingPaidTag}`,
    },
  );

  const edges = json.data?.orders?.edges ?? [];
  const deletedDrafts = new Set<string>();

  for (const edge of edges) {
    const order = edge.node as {
      id: string;
      name: string;
      tags: string[] | string;
      lineItems?: {
        edges?: Array<{
          node?: { product?: { tags?: string[] | string } | null };
        }>;
      };
      metafield: { id?: string; value?: string } | null;
    };

    const tags = normalizeTags(order.tags);
    if (!hasTag(tags, thursdayEmailSentTag)) continue;
    if (hasTag(tags, shippingPaidTag)) continue;
    const lineItems = (order.lineItems?.edges ?? []).map((lineEdge) => ({
      productTags: normalizeTags(lineEdge.node?.product?.tags),
    }));
    if (!hasConfiguredProductTag({ lineItems }, preorderProductTag)) continue;

    ordersProcessed += 1;
    const draftId = order.metafield?.value;

    if (dryRun) continue;

    try {
      if (draftId && !deletedDrafts.has(draftId)) {
        const del = await deleteDraftOrder(admin, draftId);
        if (!del.ok) {
          errors.push(`${order.name}: ${del.error}`);
        } else {
          draftsDeleted += 1;
          deletedDrafts.add(draftId);
        }
      }

      const removed = await removeTag(admin, order.id, thursdayEmailSentTag);
      if (!removed.ok) errors.push(`${order.name}: ${removed.error}`);

      const added = await addTag(admin, order.id, pushedToNextWeekendTag);
      if (!added.ok) errors.push(`${order.name}: ${added.error}`);

      if (order.metafield?.id) {
        const cleared = await clearThursdayDraftMetafield(admin, order.id);
        if (!cleared.ok) errors.push(`${order.name}: ${cleared.error}`);
      }
    } catch (error) {
      errors.push(
        `${order.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const summary = dryRun
    ? `Dry run: ${ordersProcessed} unpaid thursday order(s) would reset`
    : `Friday reset: ${ordersProcessed} order(s), ${draftsDeleted} draft(s) deleted`;

  const message =
    errors.length > 0
      ? `${summary} — ${errors.length} issue(s): ${errors.slice(0, 3).join("; ")}${
          errors.length > 3 ? `; +${errors.length - 3} more` : ""
        }`
      : summary;

  return {
    ok: errors.length === 0,
    dryRun,
    ordersProcessed,
    draftsDeleted: dryRun ? 0 : draftsDeleted,
    errors,
    message,
  };
}
