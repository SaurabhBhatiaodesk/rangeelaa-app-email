import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  processShippingPaidTagging,
  processStatusEmailTags,
} from "../lib/orders-updated-webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, admin, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    console.error(
      `[orders/create] No admin API client for ${shop} (offline session missing?)`,
    );
    return new Response("Admin API unavailable", { status: 503 });
  }

  const orderPayload = payload as {
    id?: number | string;
    admin_graphql_api_id?: string;
    financial_status?: string;
    note?: string | null;
    note_attributes?: Array<{ name: string; value: string }>;
    tags?: string | string[];
    email?: string | null;
  };

  try {
    await processStatusEmailTags(admin, orderPayload, shop);
  } catch (error) {
    console.error(`[orders/create] handler error:`, error);
  }

  try {
    await processShippingPaidTagging(admin, orderPayload, shop);
  } catch (error) {
    console.error(`[orders/create] shipping payment reconciliation failed:`, error);
    return new Response("Shipping payment reconciliation failed", { status: 503 });
  }

  return new Response();
};
