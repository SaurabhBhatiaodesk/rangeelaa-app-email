import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  processPushedToNextWeekendVoid,
  processShippingPaidTagging,
} from "../lib/orders-updated-webhook.server";

/**
 * orders/updated webhook
 * - Task 1: status tags → Klaviyo email + email-sent tags
 * - Task 4b: pushed-to-next-weekend → void Thursday draft via metafield
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, admin, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    console.error(`[orders/updated] No admin API client available for ${shop}`);
    return new Response();
  }

  try {
    await processShippingPaidTagging(admin, payload, shop);
  } catch (error) {
    console.error(`[orders/updated] shipping-paid tagging failed:`, error);
  }

  try {
    await processPushedToNextWeekendVoid(admin, payload, shop);
  } catch (error) {
    console.error(`[orders/updated] pushed-to-next-weekend void failed:`, error);
  }

  return new Response();
};
