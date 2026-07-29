import { hasTag } from "./tags";
import { sendPreorderStatusEmail } from "./klaviyo.server";
import {
  emailSentTagForAction,
  getShopSettings,
  statusTagForAction,
  templateIdForAction,
  type PreorderWorkflowTags,
} from "./klaviyo-settings.server";
import type { StatusEmailAction } from "./tags";
import { graphqlJson, type AdminGraphql } from "./cycle-shared.server";

async function addTags(admin: AdminGraphql, id: string, tags: string[]) {
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation SendStatusEmailTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
    { id, tags },
  );
  const errors = json.data?.tagsAdd?.userErrors ?? [];
  if (errors.length) {
    return {
      ok: false as const,
      error: errors.map((e: { message: string }) => e.message).join(", "),
    };
  }
  return { ok: true as const };
}

/**
 * Client Task 1 rules for one order + one status:
 * status tag present, email-sent absent, email available → send → add sent tag
 */
export async function sendStatusEmailIfNeeded(
  admin: AdminGraphql,
  options: {
    orderId: string;
    email: string | null | undefined;
    tags: string[];
    statusAction: StatusEmailAction;
    shop: string;
    workflowTags: PreorderWorkflowTags;
  },
): Promise<{ ok: true; skipped?: boolean } | { ok: false; error: string }> {
  const { orderId, email, tags, statusAction, shop, workflowTags } = options;

  const statusTag = statusTagForAction(workflowTags, statusAction);
  const sentTag = emailSentTagForAction(workflowTags, statusAction);

  if (!hasTag(tags, statusTag)) {
    return { ok: true, skipped: true };
  }
  if (hasTag(tags, sentTag)) {
    return { ok: true, skipped: true };
  }
  if (!email) {
    return { ok: false, error: "Order has no customer email" };
  }

  const settings = await getShopSettings(shop);

  const emailResult = await sendPreorderStatusEmail({
    apiKey: settings.klaviyoApiKey,
    email,
    statusAction,
    statusTag,
    alreadySent: false,
    uniqueId: `${orderId}:${statusTag}`,
    templateId: templateIdForAction(settings.klaviyoTemplates, statusAction),
  });

  if (!emailResult.ok) {
    return emailResult;
  }

  const tagResult = await addTags(admin, orderId, [sentTag]);
  if (!tagResult.ok) return tagResult;

  return { ok: true };
}
