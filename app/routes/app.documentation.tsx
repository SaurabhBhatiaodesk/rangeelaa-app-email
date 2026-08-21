import { useState, type ReactNode } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

type AccordionItem = {
  id: string;
  title: string;
  tone?: "info" | "success" | "warning" | "caution" | "neutral";
  content: ReactNode;
};

const TONE_ICON: Record<
  NonNullable<AccordionItem["tone"]>,
  "info" | "check-circle-filled" | "alert-triangle" | "alert-diamond" | "circle"
> = {
  info: "info",
  success: "check-circle-filled",
  warning: "alert-triangle",
  caution: "alert-diamond",
  neutral: "circle",
};

function DocAccordion({ items }: { items: AccordionItem[] }) {
  const [openId, setOpenId] = useState<string>(items[0]?.id ?? "");

  return (
    <s-stack gap="small-400">
      {items.map((item, index) => {
        const open = openId === item.id;
        const badgeTone = item.tone ?? "info";

        return (
          <s-box
            key={item.id}
            background="base"
            borderWidth="base"
            borderStyle="solid"
            borderColor={open ? "strong" : "subdued"}
            borderRadius="base"
            padding="none"
            overflow="hidden"
          >
            <s-clickable
              padding="base"
              inlineSize="100%"
              background={open ? "subdued" : "transparent"}
              accessibilityLabel={`${open ? "Collapse" : "Expand"} ${item.title}`}
              onClick={() => setOpenId(open ? "" : item.id)}
            >
              <s-stack
                direction="inline"
                justifyContent="space-between"
                alignItems="center"
                gap="base"
                inlineSize="100%"
              >
                <s-stack direction="inline" alignItems="center" gap="base">
                  <s-badge
                    tone={open ? badgeTone : "neutral"}
                    color="strong"
                    icon={TONE_ICON[badgeTone]}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </s-badge>
                  <s-text type="strong">{item.title}</s-text>
                </s-stack>
                <s-icon
                  type={open ? "caret-up" : "caret-down"}
                  tone={open ? badgeTone : "neutral"}
                  size="base"
                />
              </s-stack>
            </s-clickable>
            {open ? (
              <>
                <s-divider />
                <s-box background="base" padding="base">
                  {item.content}
                </s-box>
              </>
            ) : null}
          </s-box>
        );
      })}
    </s-stack>
  );
}

export default function DocumentationPage() {
  const tabItems: AccordionItem[] = [
    {
      id: "tab-01",
      title: "01. Preorders - Awaiting Readiness",
      tone: "info",
      content: (
        <s-stack gap="base">
          <s-banner tone="info" heading="Kaam kya hai">
            <s-paragraph>
              This tab shows only orders where the customer bought a product
              with the configured product tag. Default tag is{" "}
              <s-text type="strong">Web Saree</s-text>.
            </s-paragraph>
          </s-banner>
          <s-unordered-list>
            <s-list-item>
              <s-text type="strong">Piece Made</s-text>: click this when the
              piece is made. App adds the status tag and immediately sends the
              Piece Made Klaviyo event.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Leaving for Canada</s-text>: unlocks after
              Piece Made. Click it when the item is leaving for Canada. App adds
              the status tag and immediately sends the Leaving for Canada
              Klaviyo event.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Arrived in Canada</s-text>: unlocks after
              Leaving for Canada. Click it when the item arrives in Canada. App
              adds Arrived in Canada and Ready to Ship tags, then immediately
              sends the Arrived in Canada Klaviyo event.
            </s-list-item>
            <s-list-item>
              Completed steps show as colored badges. Badge state does not
              resend email.
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      ),
    },
    {
      id: "tab-02",
      title: "02. Status emails (Klaviyo)",
      tone: "neutral",
      content: (
        <s-stack gap="base">
          <s-banner tone="info" heading="Kaam kya hai">
            <s-paragraph>
              This tab is a backup for status emails. Normal emails already
              send from Tab 01 button clicks. Use this tab only to preview or
              retry pending status emails.
            </s-paragraph>
          </s-banner>
          <s-unordered-list>
            <s-list-item>
              <s-text type="strong">Preview only</s-text>: checks pending
              status emails. No email is sent.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Send pending emails now</s-text>: sends
              emails for Web Saree orders where status tag is present but the
              matching email-sent tag is missing.
            </s-list-item>
            <s-list-item>
              After a successful Klaviyo event, app adds the matching email-sent
              tag so the same email is not sent again.
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      ),
    },
    {
      id: "tab-03",
      title: "03. Thursday invoice",
      tone: "success",
      content: (
        <s-stack gap="base">
          <s-banner tone="success" heading="Kaam kya hai">
            <s-paragraph>
              This tab creates the shipping payment invoice for eligible Web
              Saree orders. Same customer orders are combined into one draft
              shipping invoice.
            </s-paragraph>
          </s-banner>
          <s-unordered-list>
            <s-list-item>
              <s-text type="strong">Automatic schedule</s-text>: Heroku
              Scheduler calls the app. The app only processes on Thursday in
              the configured timezone.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Manual run</s-text>: staff can run the
              Thursday cycle manually.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Dry Run on</s-text>: preview only. It shows
              customer, orders, Web Saree item count, and shipping amount. No
              invoice, email, or tag changes.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Dry Run off</s-text>: real run. App creates
              a Shopify draft order, sends the Thursday Klaviyo event with the
              invoice URL, and adds the thursday-email-sent tag.
            </s-list-item>
            <s-list-item>
              Shipping amount is read from Shopify Shipping profiles using only
              the Web Saree item quantity. No hardcoded fallback rate is used.
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      ),
    },
    {
      id: "tab-04",
      title: "04. After shipping paid",
      tone: "info",
      content: (
        <s-stack gap="base">
          <s-banner tone="info" heading="Kaam kya hai">
            <s-paragraph>
              This tab shows Web Saree orders bought after the same customer
              already paid shipping once.
            </s-paragraph>
          </s-banner>
          <s-unordered-list>
            <s-list-item>
              <s-text type="strong">Ship now (manual)</s-text>: opens the exact
              Shopify order. Staff manually fulfils it, adds tracking, and
              notifies the customer. App does not send email here.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Hold for next Thursday</s-text>: app adds
              the hold-for-next-cycle tag. The alert hides, and the order can
              join the next Thursday invoice cycle.
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      ),
    },
    {
      id: "tab-05",
      title: "05. Friday reset",
      tone: "caution",
      content: (
        <s-stack gap="base">
          <s-banner tone="warning" heading="Kaam kya hai">
            <s-paragraph>
              This tab resets unpaid Thursday shipping invoices for Web Saree
              orders, so they can be invoiced again next Thursday.
            </s-paragraph>
          </s-banner>
          <s-unordered-list>
            <s-list-item>
              <s-text type="strong">Preview only</s-text>: shows how many unpaid
              Thursday orders would reset. No changes.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Run Friday backup now</s-text>: deletes the
              old unpaid draft invoice, removes thursday-email-sent, adds
              pushed-to-next-weekend, and clears the saved draft invoice ID.
            </s-list-item>
            <s-list-item>
              This is a manual backup if the automatic Friday/Flow process did
              not run.
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      ),
    },
  ];

  const referenceItems: AccordionItem[] = [
    {
      id: "full-cycle",
      title: "Full app flow",
      tone: "info",
      content: (
        <s-ordered-list>
          <s-list-item>
            Tab 01 moves Web Saree preorder status and triggers customer status
            emails.
          </s-list-item>
          <s-list-item>
            Tab 02 is only a backup for pending Klaviyo status emails.
          </s-list-item>
          <s-list-item>
            Tab 03 creates the Thursday shipping invoice and sends the payment
            email.
          </s-list-item>
          <s-list-item>
            Tab 04 handles new Web Saree orders bought after shipping was
            already paid.
          </s-list-item>
          <s-list-item>
            Tab 05 resets unpaid Thursday invoices so they can try again next
            week.
          </s-list-item>
        </s-ordered-list>
      ),
    },
    {
      id: "settings",
      title: "Settings",
      tone: "info",
      content: (
        <s-paragraph>
          Open <s-link href="/app/settings">Settings</s-link> to change product
          tag, order tags, button labels, Klaviyo API key, Klaviyo template IDs,
          and allowed shipping countries. Product tag default is{" "}
          <s-text type="strong">Web Saree</s-text>.
        </s-paragraph>
      ),
    },
    {
      id: "important",
      title: "Important checks",
      tone: "warning",
      content: (
        <s-unordered-list>
          <s-list-item>
            If an order is not showing, check the purchased product has the
            configured product tag.
          </s-list-item>
          <s-list-item>
            If email event was sent but customer did not receive email, check
            the matching Klaviyo Flow is Live.
          </s-list-item>
          <s-list-item>
            If Thursday invoice does not run, check shipping country,
            Saskatoon, india-direct tag, read_shipping permission, and Shopify
            Shipping profile rates.
          </s-list-item>
        </s-unordered-list>
      ),
    },
  ];

  return (
    <s-page heading="Documentation" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Backend Heroku Klaviyo Manager
      </s-link>

      <s-section heading="Tab Based Workflow" padding="base">
        <s-stack gap="base">
          <s-paragraph>
            This guide explains the app based on the same five tabs shown on the
            Home page.
          </s-paragraph>
          <DocAccordion items={tabItems} />
        </s-stack>
      </s-section>

      <s-section heading="Quick Reference" padding="base">
        <DocAccordion items={referenceItems} />
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
