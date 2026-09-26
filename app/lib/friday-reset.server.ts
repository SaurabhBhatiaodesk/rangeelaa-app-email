import { hasTag, normalizeTags } from "./tags";
import {
  type AdminGraphql,
  graphqlJson,
} from "./cycle-shared.server";
import { getShopSettings } from "./klaviyo-settings.server";

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

export type MutationOutcome = { ok: true } | { ok: false; error: string };

function userErrorsToMessage(
  userErrors: Array<{ message: string }> | undefined,
): string | null {
  if (!userErrors || userErrors.length === 0) return null;
  return userErrors.map((e) => e.message).join(", ");
}

function isDraftNotFoundMessage(message: string): boolean {
  return /draft order not found/i.test(message);
}

export async function deleteDraftOrder(
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

export async function applyThursdayWaitChoice(
  admin: AdminGraphql,
  options: { shop: string; draftId: string; orderIds: string[] },
): Promise<{
  ok: boolean;
  ordersProcessed: number;
  draftsDeleted: number;
  errors: string[];
  unavailable?: boolean;
}> {
  const settings = await getShopSettings(options.shop);
  const thursdayEmailSentTag = settings.preorderTags.thursdayEmailSentTag;
  const pushedToNextWeekendTag = settings.preorderTags.pushedToNextWeekendTag;
  const errors: string[] = [];
  let ordersProcessed = 0;
  let draftsDeleted = 0;
  const pendingOrderIds: string[] = [];

  if (!options.draftId || options.orderIds.length === 0) {
    return { ok: false, unavailable: true, ordersProcessed, draftsDeleted, errors: ["Missing invoice details"] };
  }

  // Validate every original before deleting the single shared invoice.
  for (const orderId of new Set(options.orderIds)) {
    const json = await graphqlJson(admin, `#graphql
      query ThursdayWaitOrder($id: ID!) {
        order(id: $id) {
          tags
          cancelledAt
          metafield(namespace: "${META_NAMESPACE}", key: "${META_DRAFT_KEY}") { value }
        }
      }`, { id: orderId });
    const order = json.data?.order;
    const tags = normalizeTags(order?.tags);
    const currentDraftId = order?.metafield?.value;
    if (!order || order.cancelledAt || hasTag(tags, settings.preorderTags.shippingPaidTag)) {
      errors.push(`${orderId}: order is missing, cancelled, or shipping is already paid`);
    } else if (currentDraftId && currentDraftId !== options.draftId) {
      errors.push(`${orderId}: this link belongs to an older shipping invoice`);
    } else if (!currentDraftId) {
      if (!hasTag(tags, pushedToNextWeekendTag)) {
        errors.push(`${orderId}: this invoice is no longer linked to the order`);
      } else if (hasTag(tags, thursdayEmailSentTag)) {
        // Resume cleanup if the webhook already removed the deleted draft reference.
        pendingOrderIds.push(orderId);
      }
    } else {
      pendingOrderIds.push(orderId);
    }
  }
  if (errors.length) {
    return { ok: false, unavailable: true, ordersProcessed, draftsDeleted, errors };
  }
  if (pendingOrderIds.length === 0) {
    return { ok: true, ordersProcessed, draftsDeleted, errors };
  }

  const json = await graphqlJson(admin, `#graphql
    query ThursdayWaitDraft($id: ID!) {
      draftOrder(id: $id) { id status order { id } }
    }`, { id: options.draftId });
  const draft = json.data?.draftOrder;
  if (draft && (!['OPEN', 'INVOICE_SENT'].includes(draft.status) || draft.order)) {
    return { ok: false, unavailable: true, ordersProcessed, draftsDeleted, errors: ["This shipping invoice has already been completed"] };
  }
  // Always attempt the delete rather than trusting this read to have found
  // the draft: a stale/missing read here must not silently skip deletion
  // while still clearing every order's reference to it below.
  const deleted = await deleteDraftOrder(admin, options.draftId);
  if (!deleted.ok) {
    return { ok: false, ordersProcessed, draftsDeleted, errors: [deleted.error] };
  }
  draftsDeleted = 1;

  for (const orderId of pendingOrderIds) {
    try {
      // Keep the sent tag until cleanup succeeds, so a retry cannot create another invoice.
      const added = await addTag(admin, orderId, pushedToNextWeekendTag);
      if (!added.ok) {
        errors.push(`${orderId}: ${added.error}`);
        continue;
      }

      const cleared = await clearThursdayDraftMetafield(admin, orderId);
      if (!cleared.ok) {
        errors.push(`${orderId}: ${cleared.error}`);
        continue;
      }

      const removed = await removeTag(admin, orderId, thursdayEmailSentTag);
      if (!removed.ok) {
        errors.push(`${orderId}: ${removed.error}`);
        continue;
      }
      ordersProcessed += 1;
    } catch (error) {
      errors.push(
        `${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    ordersProcessed,
    draftsDeleted,
    errors,
  };
}

/**
 * Disabled: a shipping invoice must never auto-expire. It stays open until
 * the customer pays, or someone deliberately uses the Wait link / deletes
 * the draft themselves — never on a schedule.
 */
export async function runFridayReset(
  admin: AdminGraphql,
  options: { dryRun?: boolean; shop: string },
): Promise<FridayResetResult> {
  return {
    ok: true,
    dryRun: Boolean(options.dryRun),
    ordersProcessed: 0,
    draftsDeleted: 0,
    errors: [],
    message:
      "Friday reset is disabled: shipping invoices no longer auto-expire and stay open until paid.",
  };
}
