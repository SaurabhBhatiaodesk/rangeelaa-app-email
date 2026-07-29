import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processShippingPaidTagging } from "../lib/orders-updated-webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, admin, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    console.error(
      `[orders/create] No admin API client for ${shop} (offline session missing?)`,
    );
    return new Response();
  }

  const orderPayload = payload as {
    id?: number | string;
    admin_graphql_api_id?: string;
    financial_status?: string;
    note?: string | null;
    note_attributes?: Array<{ name: string; value: string }>;
    tags?: string | string[];
  };

  try {
    await processShippingPaidTagging(admin, orderPayload, shop);
  } catch (error) {
    console.error(`[orders/create] handler error:`, error);
  }

  return new Response();
};
