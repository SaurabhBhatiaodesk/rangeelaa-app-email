import type { LoaderFunctionArgs } from "react-router";
import { verifyThursdayPayUrl } from "../lib/thursday-wait-link.server";
import { graphqlJson } from "../lib/cycle-shared.server";
import { unauthenticated } from "../shopify.server";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Arial, Helvetica, sans-serif;
        background: #f6f1eb;
        color: #242124;
      }
      main {
        width: min(560px, calc(100% - 32px));
        background: #fff;
        border: 1px solid #eadfd5;
        border-radius: 8px;
        padding: 32px;
        text-align: center;
        box-shadow: 0 12px 34px rgba(40, 28, 20, 0.08);
      }
      h1 { margin: 0 0 12px; font-size: 26px; }
      p { margin: 0; line-height: 1.55; font-size: 16px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}

/**
 * The invoiceUrl captured when the Thursday email was sent can go dead later
 * (Friday reset deletes unpaid drafts, or the draft gets completed/voided).
 * Re-check the draft's live state here and redirect to a fresh invoiceUrl
 * instead of baking a possibly-stale checkout link directly into the email.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const verified = verifyThursdayPayUrl(url);
  if (!verified.ok) {
    return page("Link unavailable", verified.error, 400);
  }

  try {
    const { admin } = await unauthenticated.admin(verified.shop);
    const json = await graphqlJson(admin, `#graphql
      query ThursdayPayDraft($id: ID!) {
        draftOrder(id: $id) { id status invoiceUrl order { id } }
      }`, { id: verified.draftId });
    const draft = json.data?.draftOrder;

    if (!draft) {
      return page(
        "Invoice no longer available",
        "This shipping invoice is no longer available. Please use your latest shipping email or contact Rangeelaa support.",
        409,
      );
    }
    if (draft.order || !["OPEN", "INVOICE_SENT"].includes(draft.status)) {
      return page(
        "Invoice no longer available",
        "This shipping invoice has already been paid or is no longer open. Please contact Rangeelaa support if you still need to pay.",
        409,
      );
    }
    if (!draft.invoiceUrl) {
      return page(
        "Payment unavailable",
        "We could not open this payment page. Please contact Rangeelaa support and we will help you complete payment.",
        500,
      );
    }

    return new Response(null, {
      status: 302,
      headers: { location: draft.invoiceUrl, "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Thursday pay route error", {
      shop: verified.shop,
      draftId: verified.draftId,
      error: error instanceof Error ? error.message : String(error),
    });
    return page(
      "We could not open this request",
      "Please contact Rangeelaa support and we will help you complete payment.",
      500,
    );
  }
};
