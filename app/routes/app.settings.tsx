import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import {
  DEFAULT_KLAVIYO_TEMPLATE_IDS,
  DEFAULT_PREORDER_LABELS,
  DEFAULT_PREORDER_TAGS,
  flattenShopSettings,
  getShopSettings,
  parseShopSettingsForm,
  saveShopSettings,
  type ShopSettingsInput,
} from "../lib/klaviyo-settings.server";
import {
  DEFAULT_SHIPPING_RATE_TABLE_TEXT,
  parseShippingRateTable,
} from "../lib/shipping-rates";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);

  return {
    form: flattenShopSettings(settings),
    klaviyoConfigured: settings.klaviyoApiKeySource !== "none",
    klaviyoApiKeySource: settings.klaviyoApiKeySource,
    defaults: {
      tags: DEFAULT_PREORDER_TAGS,
      labels: DEFAULT_PREORDER_LABELS,
      templates: DEFAULT_KLAVIYO_TEMPLATE_IDS,
      shippingRateTable: DEFAULT_SHIPPING_RATE_TABLE_TEXT,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");

  if (intent === "reset_defaults") {
    await saveShopSettings(session.shop, {
      klaviyoApiKey: "",
      pieceMadeTemplateId: "",
      leavingForCanadaTemplateId: "",
      arrivedInCanadaTemplateId: "",
      thursdayTemplateId: "",
      pieceMade: "",
      leavingForCanada: "",
      arrivedInCanada: "",
      depositFulfilled: "",
      depositFulfilledDone: "",
      pieceMadeTag: "",
      leavingForCanadaTag: "",
      arrivedInCanadaTag: "",
      pieceMadeEmailSentTag: "",
      leavingEmailSentTag: "",
      arrivedEmailSentTag: "",
      readyToShipTag: "",
      groupTag: "",
      partialTag: "",
      depositFulfilledTag: "",
      thursdayEmailSentTag: "",
      shippingPaidTag: "",
      holdForNextCycleTag: "",
      pushedToNextWeekendTag: "",
      canadaItemTag: "",
      dispatchItemTag: "",
      indiaItemTag: "",
      preorderProductTag: "",
      allowedShippingCountryCodes: "",
      shippingRateTable: "",
    });
    const settings = await getShopSettings(session.shop);
    return {
      ok: true as const,
      message: "Reset to built-in defaults",
      form: flattenShopSettings(settings),
    };
  }

  const input = parseShopSettingsForm(formData);
  try {
    parseShippingRateTable(input.shippingRateTable);
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
      form: input,
    };
  }

  await saveShopSettings(session.shop, input);
  const settings = await getShopSettings(session.shop);
  return {
    ok: true as const,
    message: "Settings saved",
    form: flattenShopSettings(settings),
  };
};

function field(
  form: ShopSettingsInput,
  key: keyof ShopSettingsInput,
): string {
  return form[key];
}

function TagChipField({
  label,
  name,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  defaultValue: string;
  onChange: (e: Event & { currentTarget: { value: string } }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!editing) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setEditing(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () =>
      document.removeEventListener("mousedown", handleClickOutside);
  }, [editing]);

  return (
    <s-stack
      ref={containerRef as never}
      direction="block"
      gap="small-200"
    >
      <s-text type="strong">{label}</s-text>
      {editing ? (
        <s-text-field
          label={label}
          labelAccessibilityVisibility="exclusive"
          name={name}
          value={value}
          details={`Default: ${defaultValue}`}
          onChange={onChange}
        />
      ) : (
        <>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              width: "fit-content",
            }}
          >
            <s-badge tone={value ? "info" : "neutral"} color="strong">
              {value || defaultValue}
            </s-badge>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${label}`}
              style={{
                appearance: "none",
                border: "1px solid #D7D7D7",
                background: "#FFFFFF",
                borderRadius: 6,
                width: 28,
                height: 28,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <s-icon type="edit" tone="neutral" size="small" />
            </button>
          </div>
          <input type="hidden" name={name} value={value} />
        </>
      )}
    </s-stack>
  );
}

function PasswordEditField({
  label,
  name,
  value,
  details,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  details: string;
  onChange: (e: Event & { currentTarget: { value: string } }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!editing) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setEditing(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () =>
      document.removeEventListener("mousedown", handleClickOutside);
  }, [editing]);

  return (
    <s-stack ref={containerRef as never} direction="block" gap="small-200">
      <s-text type="strong">{label}</s-text>
      {editing ? (
        <s-password-field
          label={label}
          labelAccessibilityVisibility="exclusive"
          name={name}
          value={value}
          details={details}
          onChange={onChange}
        />
      ) : (
        <>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              width: "fit-content",
            }}
          >
            <s-badge tone={value ? "info" : "neutral"} color="strong">
              {value ? "••••••••••••••••" : "Not set"}
            </s-badge>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${label}`}
              style={{
                appearance: "none",
                border: "1px solid #D7D7D7",
                background: "#FFFFFF",
                borderRadius: 6,
                width: 28,
                height: 28,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <s-icon type="edit" tone="neutral" size="small" />
            </button>
          </div>
          <s-text tone="neutral">{details}</s-text>
          <input type="hidden" name={name} value={value} />
        </>
      )}
    </s-stack>
  );
}

function TextEditField({
  label,
  name,
  value,
  details,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  details: string;
  onChange: (e: Event & { currentTarget: { value: string } }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!editing) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setEditing(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () =>
      document.removeEventListener("mousedown", handleClickOutside);
  }, [editing]);

  return (
    <s-stack ref={containerRef as never} direction="block" gap="small-200">
      <s-text type="strong">{label}</s-text>
      {editing ? (
        <s-text-field
          label={label}
          labelAccessibilityVisibility="exclusive"
          name={name}
          value={value}
          details={details}
          onChange={onChange}
        />
      ) : (
        <>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              width: "fit-content",
            }}
          >
            <s-badge tone={value ? "info" : "neutral"} color="strong">
              {value || "Not set"}
            </s-badge>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${label}`}
              style={{
                appearance: "none",
                border: "1px solid #D7D7D7",
                background: "#FFFFFF",
                borderRadius: 6,
                width: 28,
                height: 28,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <s-icon type="edit" tone="neutral" size="small" />
            </button>
          </div>
          <s-text tone="neutral">{details}</s-text>
          <input type="hidden" name={name} value={value} />
        </>
      )}
    </s-stack>
  );
}

function TextAreaField({
  label,
  name,
  value,
  details,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  details: string;
  onChange: (value: string) => void;
}) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">{label}</s-text>
      <textarea
        name={name}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={label}
        rows={20}
        style={{
          width: "100%",
          minHeight: 360,
          boxSizing: "border-box",
          border: "1px solid #D7D7D7",
          borderRadius: 6,
          padding: 12,
          font: "13px ui-monospace, SFMono-Regular, Consolas, monospace",
          lineHeight: 1.45,
          resize: "vertical",
        }}
      />
      <s-text tone="neutral">{details}</s-text>
    </s-stack>
  );
}

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [form, setForm] = useState(data.form);

  const saving = navigation.state !== "idle";

  useEffect(() => {
    setForm(data.form);
  }, [data.form]);

  useEffect(() => {
    if (actionData?.ok && actionData.message) {
      shopify.toast.show(actionData.message);
      if (actionData.form) {
        setForm(actionData.form);
      }
    }
  }, [actionData, shopify]);

  const update =
    (key: keyof ShopSettingsInput) =>
    (e: Event & { currentTarget: { value: string } }) => {
      setForm((prev) => ({ ...prev, [key]: e.currentTarget.value }));
    };

  return (
    <s-page heading="Settings" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Backend Heroku Klaviyo Manager
      </s-link>

      {!data.klaviyoConfigured && (
        <s-banner heading="Klaviyo API key is missing" tone="warning">
          <s-paragraph>
            Template IDs are saved here, but emails will not send until a
            Klaviyo API key is set below, or as{" "}
            <s-text type="strong">KLAVIYO_API_KEY</s-text> in your app
            environment (Heroku config or .env).
          </s-paragraph>
        </s-banner>
      )}

      {actionData && !actionData.ok && (
        <s-banner heading="Settings not saved" tone="critical">
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      )}

      <s-banner heading="How settings apply" tone="info">
        <s-paragraph>
          Shipping Manager adds status tags to Shopify orders. This app listens
          for those tags, sends the matching Klaviyo event, and adds the
          matching email-sent tag. Leave a field blank to use the built-in
          default shown in the hint.
        </s-paragraph>
      </s-banner>

      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <s-stack direction="block" gap="large">
          <s-section heading="Shopify order tags" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Tags added by Shipping Manager for each preorder workflow step.
                This app listens for these tags and sends the matching Klaviyo
                email event.
              </s-paragraph>
              <TagChipField
                label="Piece Made status tag"
                name="pieceMadeTag"
                value={field(form, "pieceMadeTag")}
                defaultValue={data.defaults.tags.pieceMadeTag}
                onChange={update("pieceMadeTag")}
              />
              <TagChipField
                label="Leaving for Canada status tag"
                name="leavingForCanadaTag"
                value={field(form, "leavingForCanadaTag")}
                defaultValue={data.defaults.tags.leavingForCanadaTag}
                onChange={update("leavingForCanadaTag")}
              />
              <TagChipField
                label="Arrived in Canada status tag"
                name="arrivedInCanadaTag"
                value={field(form, "arrivedInCanadaTag")}
                defaultValue={data.defaults.tags.arrivedInCanadaTag}
                onChange={update("arrivedInCanadaTag")}
              />
              <TagChipField
                label="Piece Made email-sent tag"
                name="pieceMadeEmailSentTag"
                value={field(form, "pieceMadeEmailSentTag")}
                defaultValue={data.defaults.tags.pieceMadeEmailSentTag}
                onChange={update("pieceMadeEmailSentTag")}
              />
              <TagChipField
                label="Leaving email-sent tag"
                name="leavingEmailSentTag"
                value={field(form, "leavingEmailSentTag")}
                defaultValue={data.defaults.tags.leavingEmailSentTag}
                onChange={update("leavingEmailSentTag")}
              />
              <TagChipField
                label="Arrived email-sent tag"
                name="arrivedEmailSentTag"
                value={field(form, "arrivedEmailSentTag")}
                defaultValue={data.defaults.tags.arrivedEmailSentTag}
                onChange={update("arrivedEmailSentTag")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Advanced workflow tags" padding="base">
            <s-stack direction="block" gap="base">
              <s-banner tone="warning" heading="Change with care">
                <s-paragraph>
                  These tags drive the Thursday invoice pool, the Friday
                  reset, and the shipping-paid alert. Changing one only
                  affects new activity — it does not rename the tag on
                  existing orders in Shopify, so mismatched old/new tags can
                  hide orders from these tabs until you re-tag them.
                </s-paragraph>
              </s-banner>
              <TagChipField
                label="Ready to ship tag"
                name="readyToShipTag"
                value={field(form, "readyToShipTag")}
                defaultValue={data.defaults.tags.readyToShipTag}
                onChange={update("readyToShipTag")}
              />
              <TagChipField
                label="Skirt deposit — group tag"
                name="groupTag"
                value={field(form, "groupTag")}
                defaultValue={data.defaults.tags.groupTag}
                onChange={update("groupTag")}
              />
              <TagChipField
                label="Skirt deposit — partial tag"
                name="partialTag"
                value={field(form, "partialTag")}
                defaultValue={data.defaults.tags.partialTag}
                onChange={update("partialTag")}
              />
              <TagChipField
                label="Deposit fulfilled tag"
                name="depositFulfilledTag"
                value={field(form, "depositFulfilledTag")}
                defaultValue={data.defaults.tags.depositFulfilledTag}
                onChange={update("depositFulfilledTag")}
              />
              <TagChipField
                label="Thursday email-sent tag"
                name="thursdayEmailSentTag"
                value={field(form, "thursdayEmailSentTag")}
                defaultValue={data.defaults.tags.thursdayEmailSentTag}
                onChange={update("thursdayEmailSentTag")}
              />
              <TagChipField
                label="Shipping paid tag"
                name="shippingPaidTag"
                value={field(form, "shippingPaidTag")}
                defaultValue={data.defaults.tags.shippingPaidTag}
                onChange={update("shippingPaidTag")}
              />
              <TagChipField
                label="Hold for next cycle tag"
                name="holdForNextCycleTag"
                value={field(form, "holdForNextCycleTag")}
                defaultValue={data.defaults.tags.holdForNextCycleTag}
                onChange={update("holdForNextCycleTag")}
              />
              <TagChipField
                label="Pushed to next weekend tag"
                name="pushedToNextWeekendTag"
                value={field(form, "pushedToNextWeekendTag")}
                defaultValue={data.defaults.tags.pushedToNextWeekendTag}
                onChange={update("pushedToNextWeekendTag")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Retired product item tags" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Product tags used for classification. Product tag india, or
                order tag india-direct, makes the order India Direct and
                excludes it from the Thursday cycle.
              </s-paragraph>
              <TagChipField
                label="Canada item tag"
                name="canadaItemTag"
                value={field(form, "canadaItemTag")}
                defaultValue={data.defaults.tags.canadaItemTag}
                onChange={update("canadaItemTag")}
              />
              <TagChipField
                label="Legacy dispatch item tag"
                name="dispatchItemTag"
                value={field(form, "dispatchItemTag")}
                defaultValue={data.defaults.tags.dispatchItemTag}
                onChange={update("dispatchItemTag")}
              />
              <TagChipField
                label="India item tag"
                name="indiaItemTag"
                value={field(form, "indiaItemTag")}
                defaultValue={data.defaults.tags.indiaItemTag}
                onChange={update("indiaItemTag")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Preorder product eligibility" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Preorder orders are identified when any line item has product
                tag group, dispatch skirt, or this configured preorder product
                tag. Default is Web Saree.
              </s-paragraph>
              <TagChipField
                label="Preorder product tag"
                name="preorderProductTag"
                value={field(form, "preorderProductTag")}
                defaultValue={data.defaults.tags.preorderProductTag}
                onChange={update("preorderProductTag")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Shipping eligibility" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Choose which shipping countries qualify for Thursday invoices
                and shipping-paid alerts. Canada and USA are always included.
                Shipping amounts use the Thursday tiered rate table by country
                and total combined item count.
              </s-paragraph>
              <s-text-field
                label="Allowed shipping country codes"
                name="allowedShippingCountryCodes"
                value={field(form, "allowedShippingCountryCodes")}
                details={`Use 2-letter codes: CA = Canada, US = United States. Separate with commas. Default: ${data.defaults.tags.allowedShippingCountryCodes}`}
                onChange={update("allowedShippingCountryCodes")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Thursday shipping rates" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Edit the CA/US tiered shipping table used by the Thursday
                invoice cycle. The app matches the customer country and total
                combined item count across all qualifying orders for that
                customer.
              </s-paragraph>
              <s-banner tone="warning" heading="Use valid JSON">
                <s-paragraph>
                  Keep country codes as CA/US. Each tier needs min, optional
                  max, and amount. Leave max blank by omitting it for the 20+
                  tier. Leave this setting blank to use the built-in defaults.
                </s-paragraph>
              </s-banner>
              <TextAreaField
                label="Shipping rate table JSON"
                name="shippingRateTable"
                value={field(form, "shippingRateTable")}
                details="Amounts are CAD. Leave blank to use the built-in CA/US defaults."
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    shippingRateTable: value,
                  }))
                }
              />
            </s-stack>
          </s-section>

          <s-section heading="Status email display labels" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Text used when displaying status email jobs. The status buttons
                themselves live in Shipping Manager, not in this app.
              </s-paragraph>
              <TextEditField
                label="Piece Made status label"
                name="pieceMade"
                value={field(form, "pieceMade")}
                details={`Default: ${data.defaults.labels.pieceMade}`}
                onChange={update("pieceMade")}
              />
              <TextEditField
                label="Leaving for Canada status label"
                name="leavingForCanada"
                value={field(form, "leavingForCanada")}
                details={`Default: ${data.defaults.labels.leavingForCanada}`}
                onChange={update("leavingForCanada")}
              />
              <TextEditField
                label="Arrived in Canada status label"
                name="arrivedInCanada"
                value={field(form, "arrivedInCanada")}
                details={`Default: ${data.defaults.labels.arrivedInCanada}`}
                onChange={update("arrivedInCanada")}
              />
              <TextEditField
                label="Skirt deposit label"
                name="depositFulfilled"
                value={field(form, "depositFulfilled")}
                details={`Default: ${data.defaults.labels.depositFulfilled}`}
                onChange={update("depositFulfilled")}
              />
              <TextEditField
                label="Skirt deposit completed label"
                name="depositFulfilledDone"
                value={field(form, "depositFulfilledDone")}
                details={`Default: ${data.defaults.labels.depositFulfilledDone}`}
                onChange={update("depositFulfilledDone")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Klaviyo API key" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Private API key from Klaviyo (Settings → API Keys). Saved per
                store, so each client can connect their own Klaviyo account
                here without editing app environment variables.
              </s-paragraph>
              <PasswordEditField
                label="Klaviyo private API key"
                name="klaviyoApiKey"
                value={field(form, "klaviyoApiKey")}
                details={
                  data.klaviyoApiKeySource === "shop"
                    ? "Using the key saved here."
                    : data.klaviyoApiKeySource === "env"
                      ? "Showing the KLAVIYO_API_KEY from app environment. Change and save to use a different key for this store."
                      : "No key set yet. Emails will not send until one is added here or as KLAVIYO_API_KEY."
                }
                onChange={update("klaviyoApiKey")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Klaviyo template IDs" padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Short ID from the Klaviyo template URL. Sent on each Klaviyo
                event — your Flow must use the matching template.
              </s-paragraph>
              <TextEditField
                label="Piece Made template ID"
                name="pieceMadeTemplateId"
                value={field(form, "pieceMadeTemplateId")}
                details={`Default: ${data.defaults.templates.pieceMade}`}
                onChange={update("pieceMadeTemplateId")}
              />
              <TextEditField
                label="Leaving for Canada template ID"
                name="leavingForCanadaTemplateId"
                value={field(form, "leavingForCanadaTemplateId")}
                details={`Default: ${data.defaults.templates.leavingForCanada}`}
                onChange={update("leavingForCanadaTemplateId")}
              />
              <TextEditField
                label="Arrived in Canada template ID"
                name="arrivedInCanadaTemplateId"
                value={field(form, "arrivedInCanadaTemplateId")}
                details={`Default: ${data.defaults.templates.arrivedInCanada}`}
                onChange={update("arrivedInCanadaTemplateId")}
              />
              <TextEditField
                label="Thursday shipping invoice template ID"
                name="thursdayTemplateId"
                value={field(form, "thursdayTemplateId")}
                details={`Default: ${data.defaults.templates.thursday}`}
                onChange={update("thursdayTemplateId")}
              />
            </s-stack>
          </s-section>

          <s-button-group gap="base" accessibilityLabel="Settings actions">
            <s-button
              slot="primary-action"
              variant="primary"
              type="submit"
              disabled={saving}
              {...(saving ? { loading: true } : {})}
            >
              Save settings
            </s-button>
          </s-button-group>
        </s-stack>
      </Form>

      <s-box paddingBlockStart="large-500">
        <s-section heading="Reset" padding="base">
          <s-paragraph>
            Clears all saved overrides for this shop. The app will use
            built-in defaults and environment variables again.
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="reset_defaults" />
            <s-button
              variant="secondary"
              tone="critical"
              type="submit"
              disabled={saving}
            >
              Reset to defaults
            </s-button>
          </Form>
        </s-section>
      </s-box>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
