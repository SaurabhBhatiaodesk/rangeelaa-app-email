import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { applyThursdayWaitChoice } from "../lib/friday-reset.server";
import { verifyThursdayWaitUrl } from "../lib/thursday-wait-link.server";
import { unauthenticated } from "../shopify.server";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function page(title: string, body: string, status = 200, formAction?: string) {
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
      button { margin-top: 24px; padding: 12px 20px; border: 0; border-radius: 4px; background: #242124; color: #fff; font: inherit; cursor: pointer; }
      button:focus-visible { outline: 3px solid #237f88; outline-offset: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
      ${formAction ? `<form method="post" action="${escapeHtml(formAction)}"><button type="submit" name="confirm" value="wait">Yes, hold my items</button></form>` : ""}
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const verified = verifyThursdayWaitUrl(url);
  if (!verified.ok) {
    return page("Link unavailable", verified.error, 400);
  }

  // Email link scanners can issue GET requests; only an explicit POST changes orders.
  return page(
    "Wait for the next shipping cycle?",
    "We will cancel this shipping invoice and hold your items for a future shipping cycle.",
    200,
    `${url.pathname}${url.search}`,
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return page("Request unavailable", "Please open the link in your shipping email.", 405);
  }
  const url = new URL(request.url);
  const verified = verifyThursdayWaitUrl(url);
  if (!verified.ok) {
    return page("Link unavailable", verified.error, 400);
  }

  // No origin/CSRF check here: email clients, link scanners, and proxies
  // send this request from all kinds of contexts (missing Origin, "null"
  // Origin, mismatched proxy protocol/host), so any such check ends up
  // rejecting real customer confirmations. The link itself is signed,
  // time-limited, and re-validated against live order/draft state below,
  // which is what actually protects this endpoint.
  let confirmed = false;
  try {
    confirmed = (await request.formData()).get("confirm") === "wait";
  } catch {
    // A malformed form is not a customer confirmation.
  }
  if (!confirmed) {
    return page("Confirmation required", "Please open the link and confirm that you would like to wait.", 400);
  }

  try {
    const { admin } = await unauthenticated.admin(verified.shop);
    const result = await applyThursdayWaitChoice(admin, {
      shop: verified.shop,
      draftId: verified.draftId,
      orderIds: verified.orderIds,
    });

    if (!result.ok) {
      console.error("Thursday wait choice failed", {
        shop: verified.shop,
        draftId: verified.draftId,
        orderIds: verified.orderIds,
        errors: result.errors,
      });
      if (result.unavailable) {
        return page(
          "Invoice no longer available",
          "This invoice can no longer be postponed. Please use your latest shipping email or contact Rangeelaa support.",
          409,
        );
      }
      return page(
        "We could not update this request",
        "Please contact Rangeelaa support and we will hold your pieces for the next shipping cycle.",
        500,
      );
    }

    return page(
      "No worries, we will wait",
      "Your pieces will be held for the next Thursday shipping cycle. We will send a fresh shipping invoice when they are ready again.",
    );
  } catch (error) {
    console.error("Thursday wait route error", {
      shop: verified.shop,
      draftId: verified.draftId,
      orderIds: verified.orderIds,
      error: error instanceof Error ? error.message : String(error),
    });
    return page(
      "We could not update this request",
      "Please contact Rangeelaa support and we will hold your pieces for the next shipping cycle.",
      500,
    );
  }
};
