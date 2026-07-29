import {
  KLAVIYO_STATUS_EMAIL_META,
  KLAVIYO_THURSDAY_METRIC,
  type StatusEmailAction,
} from "./tags";

export type KlaviyoSendResult =
  | { ok: true; skipped?: boolean; reason?: string }
  | { ok: false; error: string };

const KLAVIYO_REVISION = "2024-10-15";

function trimOrEmpty(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * Creates a Klaviyo event. A metric-triggered Flow must send the email.
 * Direct template send (/api/messages/send/) does not exist on current API.
 */
async function createKlaviyoEvent(options: {
  apiKey: string;
  email: string;
  metricName: string;
  properties?: Record<string, string>;
  uniqueId?: string;
}): Promise<KlaviyoSendResult> {
  const apiKey = trimOrEmpty(options.apiKey);
  if (!apiKey) {
    return {
      ok: false,
      error:
        "Klaviyo API key is not set. Add it in Settings or as KLAVIYO_API_KEY in your app environment.",
    };
  }

  const attributes: Record<string, unknown> = {
    properties: options.properties ?? {},
    metric: {
      data: {
        type: "metric",
        attributes: { name: options.metricName },
      },
    },
    profile: {
      data: {
        type: "profile",
        attributes: { email: options.email },
      },
    },
  };

  if (options.uniqueId) {
    attributes.unique_id = options.uniqueId;
  }

  console.log("Klaviyo create event", { email: options.email, metricName: options.metricName, uniqueId: options.uniqueId, properties: options.properties });

  const response = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes,
      },
    }),
  });

  if (response.status !== 202 && !response.ok) {
    const body = await response.text();
    console.error("Klaviyo create event failed", { status: response.status, body: body.slice(0, 300) });
    return {
      ok: false,
      error: `Klaviyo ${response.status}: ${body.slice(0, 300)}`,
    };
  }

  console.log("Klaviyo create event succeeded", { status: response.status });
  return { ok: true };
}

/**
 * Fires a preorder status metric so the matching Klaviyo Flow can email.
 */
export async function sendPreorderStatusEmail(options: {
  apiKey: string;
  email: string | null | undefined;
  statusAction: StatusEmailAction;
  statusTag: string;
  alreadySent: boolean;
  uniqueId?: string;
  templateId: string;
}): Promise<KlaviyoSendResult> {
  const { apiKey, email, statusAction, statusTag, alreadySent, templateId } =
    options;

  if (alreadySent) {
    return { ok: true, skipped: true, reason: "already_sent" };
  }

  if (!email) {
    return { ok: false, error: "Order has no customer email" };
  }

  const meta = KLAVIYO_STATUS_EMAIL_META[statusAction];
  if (!meta) {
    return { ok: false, error: `Unknown status action: ${statusAction}` };
  }

  const resolvedTemplateId = trimOrEmpty(templateId);
  if (!resolvedTemplateId) {
    return {
      ok: false,
      error: `Klaviyo template ID is not set for ${statusAction}.`,
    };
  }

  return createKlaviyoEvent({
    apiKey,
    email,
    metricName: meta.metricName,
    uniqueId: options.uniqueId,
    properties: {
      status_tag: statusTag,
      template_id: resolvedTemplateId,
      subject: meta.subject,
    },
  });
}

/**
 * Thursday combined shipping invoice — triggers metric
 * `Rangeela Thursday Shipping Invoice` (Flow uses template from settings).
 */
export async function sendThursdayInvoiceEmail(options: {
  apiKey: string;
  email: string;
  invoiceUrl: string;
  waitUrl: string;
  orderNames: string[];
  shippingAmount: string;
  uniqueId?: string;
  templateId: string;
}): Promise<KlaviyoSendResult> {
  const templateId = trimOrEmpty(options.templateId);
  if (!templateId) {
    return {
      ok: false,
      error:
        "Thursday invoice template ID is not set. Add it under Settings → Klaviyo template IDs.",
    };
  }
  if (!options.invoiceUrl) {
    return { ok: false, error: "Draft order has no invoiceUrl" };
  }


  return createKlaviyoEvent({
    apiKey: options.apiKey,
    email: options.email,
    metricName: KLAVIYO_THURSDAY_METRIC,
    uniqueId: options.uniqueId,
    properties: {
      template_id: templateId,
      invoice_url: options.invoiceUrl,
      wait_url: options.waitUrl,
      order_names: options.orderNames.join(", "),
      shipping_amount: options.shippingAmount,
    },
  });
}
