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
          <s-banner tone="info" heading="What this tab does">
            <s-paragraph>
              This tab is a read-only view. Status buttons live in the Shipping
              Manager app. This app does not add Piece Made, Leaving for Canada,
              or Arrived in Canada tags from this page.
            </s-paragraph>
          </s-banner>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">How status emails are triggered</s-text>
              <s-unordered-list>
                <s-list-item>
                  Staff clicks the status button in the Shipping Manager app.
                </s-list-item>
                <s-list-item>
                  Shipping Manager adds the matching Shopify order tag:
                  piece-made-notified, leaving-for-canada-notified, or
                  arrived-in-canada-notified.
                </s-list-item>
                <s-list-item>
                  This app listens for the tag, sends the matching Klaviyo
                  event, then adds the matching email-sent tag so it is not sent
                  again.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Preorder classification</s-text>
              <s-ordered-list>
                <s-list-item>
                  An order is Preorder when any line item has product tag group,
                  dispatch skirt, or the configured preorder product tag
                  normally Web Saree.
                </s-list-item>
                <s-list-item>
                  An order is RTW when it is not India Direct and does not have
                  preorder product tags.
                </s-list-item>
                <s-list-item>
                  An order is India Direct when any line item has product tag
                  india or the order has order tag india-direct.
                </s-list-item>
              </s-ordered-list>
            </s-stack>
          </s-box>
          <s-banner tone="warning" heading="Good to know">
            <s-paragraph>
              This app should not duplicate Shipping Manager buttons. It only
              reacts after the tags already exist on the Shopify order.
            </s-paragraph>
          </s-banner>
        </s-stack>
      ),
    },
    {
      id: "tab-02",
      title: "02. Status emails (Klaviyo)",
      tone: "neutral",
      content: (
        <s-stack gap="base">
          <s-banner tone="info" heading="What this tab does">
            <s-paragraph>
              This tab is a Klaviyo backup tool. Normal status emails are sent
              by the orders/updated webhook when Shipping Manager adds a status
              tag. This tab can preview or retry any status email that did not
              finish.
            </s-paragraph>
          </s-banner>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">How pending emails are detected</s-text>
              <s-paragraph>
                The app checks preorder-tagged orders where a status tag exists
                but the matching email-sent tag is still missing. That means the
                order needs a Klaviyo event retry.
              </s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Buttons on this tab</s-text>
              <s-unordered-list>
                <s-list-item>
                  <s-text type="strong">Preview only</s-text>: shows pending
                  status emails without sending anything or changing tags.
                </s-list-item>
                <s-list-item>
                  <s-text type="strong">Send pending emails now</s-text>: sends
                  the missing Klaviyo events and then adds the correct
                  email-sent tag to prevent another retry.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
          <s-banner tone="warning" heading="Good to know">
            <s-paragraph>
              This tab confirms that the app sent the event to Klaviyo. Final
              inbox delivery still depends on the matching Klaviyo Flow being
              Live and configured with the correct metric/template.
            </s-paragraph>
          </s-banner>
        </s-stack>
      ),
    },
    {
      id: "tab-03",
      title: "03. Thursday invoice",
      tone: "success",
      content: (
        <s-stack gap="base">
          <s-banner tone="success" heading="What this tab does">
            <s-paragraph>
              This tab creates shipping payment invoices for eligible RTW and
              Preorder orders. Orders for the same customer are combined into
              one Shopify draft shipping invoice.
            </s-paragraph>
          </s-banner>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Which orders qualify</s-text>
              <s-unordered-list>
                <s-list-item>
                  Preorder orders qualify only when all three status tags are
                  present: piece-made-notified, leaving-for-canada-notified, and
                  arrived-in-canada-notified.
                </s-list-item>
                <s-list-item>
                  RTW orders qualify directly when they are not India Direct.
                  No three-step process and no ready-to-ship tag is required.
                </s-list-item>
                <s-list-item>
                  India Direct orders never qualify. The app also excludes
                  Saskatoon, unsupported shipping countries, already
                  shipping-paid orders, and orders already marked
                  thursday-email-sent.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Automatic schedule and manual run</s-text>
              <s-unordered-list>
                <s-list-item>
                  <s-text type="strong">Automatic schedule</s-text>: Heroku
                  Scheduler calls the app daily. The app only processes real
                  invoices on Thursday in the configured timezone.
                </s-list-item>
                <s-list-item>
                  <s-text type="strong">Manual run</s-text>: staff can run the
                  same Thursday cycle manually from the app when needed.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Dry Run and real run</s-text>
              <s-unordered-list>
                <s-list-item>
                  <s-text type="strong">Dry Run on</s-text>: preview only. It
                  shows customer email, order numbers, item count, and
                  shipping amount. No invoice, email, or tag changes are made.
                </s-list-item>
                <s-list-item>
                  <s-text type="strong">Dry Run off</s-text>: real run. The app
                  creates or reuses one Shopify draft order, sends the Thursday
                  Klaviyo event with the invoice URL, saves the draft ID on the
                  original orders, and adds thursday-email-sent after Klaviyo
                  accepts the event.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
          <s-banner tone="warning" heading="Shipping calculation">
            <s-paragraph>
              For Preorder orders, item count uses preorder-tagged line items
              that require shipping. For RTW orders, item count uses physical
              line items that require shipping. The shipping amount is read from
              Shopify Shipping profiles for the customer country/province and
              item quantity. No hardcoded fallback rate is used.
            </s-paragraph>
          </s-banner>
        </s-stack>
      ),
    },
    {
      id: "tab-04",
      title: "04. After shipping paid",
      tone: "info",
      content: (
        <s-stack gap="base">
          <s-banner tone="info" heading="What this tab does">
            <s-paragraph>
              This tab catches the special case where a customer already paid a
              Thursday shipping invoice, then later buys another eligible item.
            </s-paragraph>
          </s-banner>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Why an alert appears</s-text>
              <s-paragraph>
                The app looks for a customer who has an eligible order
                already tagged shipping-paid. If the same customer places a
                newer eligible order, the app shows that newer order
                here for staff review.
              </s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Buttons on this tab</s-text>
              <s-unordered-list>
                <s-list-item>
                  <s-text type="strong">Ship now (manual)</s-text>: opens the
                  exact Shopify order. Staff manually fulfils it, adds tracking,
                  and notifies the customer from Shopify. The app does not
                  calculate shipping or send a Klaviyo email from this button.
                </s-list-item>
                <s-list-item>
                  <s-text type="strong">Hold for next Thursday</s-text>: adds
                  the hold-for-next-cycle tag. The alert hides, and the order
                  becomes eligible to join the next Thursday invoice cycle.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
          <s-banner tone="warning" heading="Good to know">
            <s-paragraph>
              Shipping is not calculated immediately on this tab. If staff holds
              the order for next Thursday, shipping is calculated later in Tab
              03 using Shopify Shipping profile rates.
            </s-paragraph>
          </s-banner>
        </s-stack>
      ),
    },
    {
      id: "tab-05",
      title: "05. Friday reset",
      tone: "caution",
      content: (
        <s-stack gap="base">
          <s-banner tone="warning" heading="What this tab does">
            <s-paragraph>
              This tab is the backup reset for unpaid Thursday shipping
              invoices. It prepares unpaid shipping invoices to be
              tried again in the next weekly cycle.
            </s-paragraph>
          </s-banner>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">When this tab is used</s-text>
              <s-paragraph>
                Use this when the customer did not pay the Thursday shipping
                draft invoice and the automatic Friday reset did not run. The
                normal process is automatic; this tab is the manual backup.
              </s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text type="strong">Buttons on this tab</s-text>
              <s-unordered-list>
                <s-list-item>
                  <s-text type="strong">Preview only</s-text>: shows how many
                  unpaid Thursday orders would reset. No invoice, tag, or
                  metafield changes are made.
                </s-list-item>
                <s-list-item>
                  <s-text type="strong">Run Friday backup now</s-text>: deletes
                  the old unpaid draft invoice, removes thursday-email-sent,
                  adds pushed-to-next-weekend, and clears the saved draft
                  invoice ID.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
          <s-banner tone="warning" heading="Good to know">
            <s-paragraph>
              Paid invoices are not reset here. Orders with shipping-paid stay
              completed and are excluded from the next Thursday invoice cycle.
            </s-paragraph>
          </s-banner>
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
            Shipping Manager adds status tags. This app listens for those tags
            and triggers customer status emails.
          </s-list-item>
          <s-list-item>
            Tab 02 is only a backup for pending Klaviyo status emails.
          </s-list-item>
          <s-list-item>
            Tab 03 creates the Thursday shipping invoice and sends the payment
            email.
          </s-list-item>
          <s-list-item>
            Tab 04 handles new eligible orders bought after shipping was
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
          tag, order tags, Klaviyo API key, Klaviyo template IDs,
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
            If an order is not showing, check whether it matches the expected
            classification: Preorder, RTW, or India Direct.
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
          <s-box
            background="base"
            borderWidth="base"
            borderStyle="solid"
            borderColor="subdued"
            borderRadius="large-100"
            padding="none"
            overflow="hidden"
          >
            <div
              style={{
                background: "#8FD3FF",
                padding: "14px 16px",
              }}
            >
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="info" tone="info" />
                <s-text type="strong">What this app tracks</s-text>
              </s-stack>
            </div>
            <s-box padding="base">
              <s-paragraph>
                This app has two jobs: listen for Shipping Manager status tags
                and send Klaviyo status emails, then run the Thursday shipping
                invoice cycle. Orders are classified as Preorder, RTW, or India
                Direct using product tags and order tags. India Direct orders
                are always excluded from the Thursday cycle.
              </s-paragraph>
            </s-box>
          </s-box>
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
