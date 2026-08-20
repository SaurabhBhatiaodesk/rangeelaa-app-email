/* eslint-disable react/no-unescaped-entities */
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
      title: "01. Preorders — Awaiting Readiness",
      tone: "info",
      content: (
        <s-stack gap="base">
          <s-paragraph>
            Tracks each preorder through 3 production stages, and automatically
            emails the customer at every stage — nothing else needs to be
            clicked.
          </s-paragraph>
          <s-banner tone="info" heading="Only configured preorder products appear here">
            <s-paragraph>
              This tab only shows orders that include at least one purchased
              product with the Shopify product tag{" "}
              <s-text type="strong">Web Saree</s-text> by default. You can
              change this product tag in Settings. If an order does not include
              a product with the configured preorder product tag, it is hidden
              from this preorder readiness list.
            </s-paragraph>
          </s-banner>
          <s-ordered-list>
            <s-list-item>
              <s-text type="strong">Piece Made</s-text> — tags the order and
              instantly sends the Piece Made email only when this button is
              clicked.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Leaving for Canada</s-text> — tags the order
              and instantly sends the Leaving for Canada email only when this
              button is clicked.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Arrived in Canada</s-text> — tags the order
              and instantly sends the Arrived in Canada email only when this
              button is clicked. The order is now ready for its Thursday
              shipping invoice.
            </s-list-item>
          </s-ordered-list>
          <s-banner tone="success" heading="Emails send from button clicks">
            <s-paragraph>
              The customer email is triggered by clicking the matching status
              button: Piece Made, Leaving for Canada, or Arrived in Canada. Once
              a step is already complete, it shows as a colored badge and does
              not send the email again.
            </s-paragraph>
          </s-banner>
          <s-paragraph>
            Steps must be done in order — the next button only unlocks once the
            previous one is done. Skirt deposit orders skip this sequence and
            get a single <s-text type="strong">Mark Deposit Fulfilled</s-text>{" "}
            button instead.
          </s-paragraph>
        </s-stack>
      ),
    },
    {
      id: "tab-02",
      title: "02. Status Emails (Klaviyo)",
      tone: "neutral",
      content: (
        <s-stack gap="base">
          <s-banner tone="info" heading="Usually nothing to do here">
            <s-paragraph>
              This is a backup and monitoring tab. The 3 emails from Tab 01
              already send themselves the moment a status button is clicked —
              you don't need to visit this tab as part of the normal routine.
            </s-paragraph>
          </s-banner>
          <s-ordered-list>
            <s-list-item>
              <s-text type="strong">Preview only (no emails sent)</s-text> —
              shows how many emails are currently pending. Sends nothing.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Send pending emails now</s-text> — retries
              any order where the app has not yet successfully sent its status
              email (for example, a tag added directly in Shopify Admin instead
              of through Tab 01, or a one-off send failure).
            </s-list-item>
          </s-ordered-list>
          <s-banner tone="info" heading="Email-sent tag">
            <s-paragraph>
              The email-sent tag only confirms the app successfully handed the
              email off to Klaviyo — it does not guarantee the customer's inbox
              received it. Actual delivery depends on the matching Klaviyo Flow
              being switched on (Live). If a customer says they never got an
              email but the tag is present, check that Flow in Klaviyo first.
            </s-paragraph>
          </s-banner>
        </s-stack>
      ),
    },
    {
      id: "tab-03",
      title: "03. Thursday Invoice",
      tone: "success",
      content: (
        <s-stack gap="base">
          <s-paragraph>
            Once a week, this combines everything a customer owes shipping on
            into <s-text type="strong">one single invoice</s-text> — this is
            different from the status emails in Tab 01/02, which just update the
            customer on progress. This tab is the one that asks them to actually
            pay for shipping.
          </s-paragraph>
          <s-ordered-list>
            <s-list-item>
              <s-text type="strong">Automatic schedule</s-text> — shows the
              current Heroku Scheduler status. The scheduler calls the app
              daily, but the backend only processes orders on Thursday in the
              configured cron time zone.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Manual run</s-text> — shows the manual
              controls for staff. Use this when you need to preview or run the
              Thursday cycle immediately.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Dry Run on</s-text> — preview only. It shows
              which customers would be processed, their combined item count, and
              the shipping total. No invoices are created and no emails are
              sent.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Dry Run off</s-text> — live run. It creates
              the draft invoice(s), sends one combined Klaviyo email per
              customer with a Pay Shipping link, and updates the matching
              orders.
            </s-list-item>
          </s-ordered-list>
          <s-banner tone="info" heading="Automatic or manual mode">
            <s-paragraph>
              Selecting Automatic schedule or Manual run opens the Shopify Save
              bar. Click Save to remember that tab preference in this browser,
              or Discard to go back to the previous selection. The real schedule
              is still managed in Heroku.
            </s-paragraph>
          </s-banner>
          <s-banner
            tone="warning"
            heading="Ready orders do not invoice by themselves"
          >
            <s-paragraph>
              An order becoming "ready" in Tab 01 does not, by itself, send an
              invoice. It is invoiced by the automatic Thursday scheduler, or by
              a staff member choosing Manual run and clicking{" "}
              <s-text type="strong">Run Thursday Cycle</s-text>.
            </s-paragraph>
          </s-banner>
          <s-banner tone="info" heading="What qualifies">
            <s-paragraph>
              Pool 1 includes preorder orders tagged arrived in Canada and ready
              to ship. Pool 2 includes paid, unfulfilled RTW orders with at
              least one physical item that requires shipping. Saskatoon is
              excluded, shipping country must match Settings, and orders tagged
              india-direct are excluded. The invoice amount is read from the
              matching Shopify Shipping profile rate.
            </s-paragraph>
          </s-banner>
        </s-stack>
      ),
    },
    {
      id: "tab-04",
      title: "04. After Shipping Paid",
      tone: "info",
      content: (
        <s-stack gap="base">
          <s-paragraph>
            Alerts staff whenever a customer buys something new{" "}
            <s-text type="strong">after</s-text> they already paid for shipping
            on an earlier order — so staff can decide how to handle the new
            item.
          </s-paragraph>
          <s-ordered-list>
            <s-list-item>
              <s-text type="strong">Ship now (manual)</s-text> — opens that
              exact order in Shopify Admin. Staff fulfils it, adds tracking, and
              notifies the customer themselves — the app does not touch any tags
              or send anything automatically here.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Hold for next cycle</s-text> — tags the
              order so it automatically joins the next Thursday combined invoice
              (Tab 03) instead, even though shipping was already paid once.
            </s-list-item>
          </s-ordered-list>
        </s-stack>
      ),
    },
    {
      id: "tab-05",
      title: "05. Friday Reset",
      tone: "caution",
      content: (
        <s-stack gap="base">
          <s-paragraph>
            A weekly safety net. Some customers don't pay their Thursday invoice
            — this resets those orders so they cleanly go through the whole
            process again next week, with a fresh invoice.
          </s-paragraph>
          <s-ordered-list>
            <s-list-item>
              <s-text type="strong">Preview only (no changes)</s-text> — shows
              how many unpaid orders would be reset. Changes nothing.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Run Friday backup now</s-text> — cancels the
              old unpaid invoice and clears its tags, so the order is ready to
              be picked up by next Thursday's cycle.
            </s-list-item>
          </s-ordered-list>
          <s-banner tone="info" heading="Backup, not the only path">
            <s-paragraph>
              This now runs automatically from Heroku Scheduler. The scheduler
              calls the app daily at 6:00 AM UTC, and the app only performs the
              reset when it is Friday in the configured cron time zone. Use this
              button only if the automatic job did not run and unpaid orders are
              stuck.
            </s-paragraph>
          </s-banner>
        </s-stack>
      ),
    },
  ];

  const referenceItems: AccordionItem[] = [
    {
      id: "flow-summary",
      title: "How the 5 tabs connect (one full cycle)",
      tone: "info",
      content: (
        <s-ordered-list>
          <s-list-item>
            Staff moves a preorder through Tab 01 — customer gets 3 progress
            emails automatically.
          </s-list-item>
          <s-list-item>
            Tab 02 sits in the background as a backup — usually untouched.
          </s-list-item>
          <s-list-item>
            On Thursday, Tab 03 combines that customer's ready orders into one
            shipping invoice and emails it, either from the automatic scheduler
            or from Manual run.
          </s-list-item>
          <s-list-item>
            If the same customer buys something new after paying, Tab 04 alerts
            staff to Ship now or Hold it for the next invoice.
          </s-list-item>
          <s-list-item>
            If a Thursday invoice goes unpaid, Tab 05 resets it on Friday so it
            tries again cleanly the following Thursday.
          </s-list-item>
        </s-ordered-list>
      ),
    },
    {
      id: "klaviyo-account",
      title: "Important: correct Klaviyo account",
      tone: "warning",
      content: (
        <s-banner heading="Use the Rangeelaa account" tone="warning">
          <s-paragraph>
            The API key and templates belong to{" "}
            <s-text type="strong">
              Rangeelaa — Ethnic Home Decor and Women&apos;s Apparel
            </s-text>
            . Always confirm you're in that account (bottom-left of Klaviyo)
            before changing anything Klaviyo-related.
          </s-paragraph>
        </s-banner>
      ),
    },
    {
      id: "settings",
      title: "Where to change tags, labels & templates",
      tone: "info",
      content: (
        <s-paragraph>
          Open <s-link href="/app/settings">Settings</s-link> to rename any
          Shopify tag, change button/badge text, connect a Klaviyo API key, or
          update Klaviyo template IDs — all changes are saved per store.
          Renaming a tag only affects new activity going forward; it does not
          rename that tag on orders that already have the old one.
        </s-paragraph>
      ),
    },
    {
      id: "product-item-tags",
      title: "India direct routing and physical-item count",
      tone: "info",
      content: (
        <s-paragraph>
          Open <s-link href="/app/settings">Settings</s-link> to review the
          India direct order tag. Thursday invoices and shipping-paid alerts now
          count physical items that require shipping, instead of Canada,
          dispatch, or India product tags. The shipping amount comes from
          Shopify Shipping profiles.
        </s-paragraph>
      ),
    },
    {
      id: "problems",
      title: "Common problems",
      tone: "warning",
      content: (
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Tag added but no email arrived</s-text> —
            check the matching Klaviyo Flow is Live, in the Rangeelaa account
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Order not showing in Tab 03 preview</s-text> —
            it needs every condition at once (paid, unfulfilled, allowed
            shipping country, not Saskatoon, not india-direct, and at least one
            physical item that requires shipping)
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Order not showing in Tab 01</s-text> - check
            that at least one product in the order has the preorder product tag
            configured in Settings. The default is{" "}
            <s-text type="strong">Web Saree</s-text>. Order tags do not count
            for this filter.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">
              Friday reset shows a red "issue(s)" toast
            </s-text>{" "}
            — check the listed reason; "draft already gone" is harmless
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Klaviyo 404 on messages/send</s-text> —
            expected; that endpoint is retired, the app uses Klaviyo events +
            Flows instead
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Wrong products are qualifying</s-text> - check
            whether the order is tagged india-direct or whether the item is
            marked as not requiring shipping
          </s-list-item>
        </s-unordered-list>
      ),
    },
  ];

  return (
    <s-page heading="Documentation" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Shipping Manager
      </s-link>

      <s-section heading="Your 5-Step Weekly Workflow" padding="base">
        <s-stack gap="base">
          <s-paragraph>
            Rangeela Shipping Manager automates preorder status updates, weekly
            combined shipping invoices, the "bought again after paying" alert,
            and the Friday cleanup for unpaid invoices.
          </s-paragraph>
          <DocAccordion items={tabItems} />
        </s-stack>
      </s-section>

      <s-section heading="Good to Know" padding="base">
        <DocAccordion items={referenceItems} />
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
