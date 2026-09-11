import type { LoaderFunctionArgs } from "react-router";
import { applyThursdayWaitChoice } from "../lib/friday-reset.server";
import { verifyThursdayWaitUrl } from "../lib/thursday-wait-link.server";
import { unauthenticated } from "../shopify.server";

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
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
        border-radius: 12px;
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
      <h1>${title}</h1>
      <p>${body}</p>
    </main>
  </body>
</html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const verified = verifyThursdayWaitUrl(new URL(request.url));
  if (!verified.ok) {
    return page("Link unavailable", verified.error, 400);
  }

  try {
    const { admin } = await unauthenticated.admin(verified.shop);
    const result = await applyThursdayWaitChoice(admin, {
      shop: verified.shop,
      orderIds: verified.orderIds,
    });

    if (!result.ok) {
      console.error("Thursday wait choice failed", {
        shop: verified.shop,
        draftId: verified.draftId,
        orderIds: verified.orderIds,
        errors: result.errors,
      });
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
