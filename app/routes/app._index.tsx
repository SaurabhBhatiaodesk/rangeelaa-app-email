/* eslint-disable react/no-unescaped-entities */
import { useEffect, useRef, useState, startTransition } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { PreorderStatusButtons } from "../components/PreorderStatusButtons";
import { ShippingPaidAlert } from "../components/ShippingPaidAlert";
import {
  applyStatusAction,
  fetchAwaitingReadinessOrders,
  fetchShippingWorkflowSummary,
  fetchShippingPaidAlerts,
} from "../lib/orders.server";
import {
  previewThursdayPools,
  runThursdayCycle,
} from "../lib/thursday-cycle.server";
import { parseAllowedShippingCountryCodes } from "../lib/cycle-shared.server";
import { getCronTimeZone } from "../lib/cron-schedule.server";
import { runFridayReset } from "../lib/friday-reset.server";
import { runStatusEmailPoller } from "../lib/status-emails.server";
import {
  hasTag,
  KLAVIYO_STATUS_EMAIL_META,
  type StatusAction,
} from "../lib/tags";
import { authenticate } from "../shopify.server";
import { getShopSettings } from "../lib/klaviyo-settings.server";

type TabId = "preorders" | "emails" | "thursday" | "alerts" | "friday";
type ThursdayRunMode = "automatic" | "manual";
type SessionWithUser = { user?: { id?: string | number } };
type FetcherResultWithRows = {
  rows?: Array<{
    orderName: string;
    job: string;
    result: string;
    detail?: string;
  }>;
  results?: Array<{ error?: string }>;
};

const ALERT_HIDE_ACTIONS = ["hold_for_next_cycle"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = (url.searchParams.get("tab") || "preorders") as TabId;

  const shopSettings = await getShopSettings(session.shop);

  let shopName = session.shop;
  try {
    const shopResponse = await admin.graphql(
      `#graphql
          query ShippingManagerShopName {
            shop {
              name
            }
          }`,
    );
    const shopJson = await shopResponse.json();
    shopName = shopJson.data?.shop?.name || session.shop;
  } catch {
    shopName = session.shop;
  }

  let workflowSummary = {
    readyToShipCount: 0,
    awaitingPaymentCount: 0,
    nextShippingLabel: "Not set",
  };
  try {
    workflowSummary = await fetchShippingWorkflowSummary(
      admin,
      shopSettings.preorderTags,
    );
  } catch (error) {
    console.warn("Unable to load shipping workflow summary", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const cronConfigured = Boolean(
    process.env.CRON_SECRET && process.env.CRON_SHOP,
  );
  const thursdayAutomationEnabled =
    cronConfigured && process.env.THURSDAY_AUTOMATION_ENABLED !== "false";

  const base = {
    shop: session.shop,
    shopName,
    workflowSummary,
    allowedCountryCodesLabel: parseAllowedShippingCountryCodes(
      shopSettings.preorderTags.allowedShippingCountryCodes,
    ).join("/"),
    klaviyoConfigured: shopSettings.klaviyoApiKeySource !== "none",
    thursdayTemplateConfigured: Boolean(
      shopSettings.klaviyoTemplates.thursdayTemplateId,
    ),
    klaviyoTemplates: shopSettings.klaviyoTemplates,
    preorderLabels: shopSettings.preorderLabels,
    preorderTags: shopSettings.preorderTags,
    cronConfigured,
    thursdayAutomationEnabled,
    cronTimeZone: getCronTimeZone(),
    loadError: null as string | null,
  };

  try {
    if (tab === "alerts") {
      const alerts = await fetchShippingPaidAlerts(
        admin,
        shopSettings.preorderTags,
      );
      return { ...base, tab, preorders: [], alerts, thursdayPreview: null };
    }

    if (tab === "thursday") {
      const thursdayPreview = await previewThursdayPools(admin, session.shop);
      return {
        ...base,
        tab,
        preorders: [],
        alerts: [],
        thursdayPreview,
      };
    }

    if (tab === "friday" || tab === "emails") {
      return {
        ...base,
        tab,
        preorders: [],
        alerts: [],
        thursdayPreview: null,
      };
    }

    const preorders = await fetchAwaitingReadinessOrders(
      admin,
      shopSettings.preorderTags,
    );
    return {
      ...base,
      tab,
      preorders,
      alerts: [],
      thursdayPreview: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load data";
    return {
      ...base,
      tab,
      preorders: [],
      alerts: [],
      thursdayPreview: null,
      loadError: message,
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "status");
  const actionLog: Record<string, unknown> = {
    intent,
    shop: session.shop,
    formKeys: Array.from(formData.keys()),
  };
  if (typeof session === "object" && session !== null && "user" in session) {
    actionLog.userId = (session as SessionWithUser).user?.id;
  }
  console.log("App action received", actionLog);

  if (intent === "thursday_run") {
    const dryRun = formData.get("dryRun") === "1";
    console.log("Thursday cycle action start", { dryRun, shop: session.shop });
    return runThursdayCycle(admin, { dryRun, shop: session.shop });
  }

  if (intent === "friday_run") {
    const dryRun = formData.get("dryRun") === "1";
    return runFridayReset(admin, { dryRun, shop: session.shop });
  }

  if (intent === "status_emails_run") {
    const dryRun = formData.get("dryRun") === "1";
    return runStatusEmailPoller(admin, { dryRun, shop: session.shop });
  }

  const orderId = String(formData.get("orderId") || "");
  const actionName = String(formData.get("actionName") || "") as StatusAction;

  if (!orderId || !actionName) {
    return { ok: false as const, error: "Missing orderId or action" };
  }

  const shopSettings = await getShopSettings(session.shop);
  return applyStatusAction(admin, orderId, actionName, {
    workflowTags: shopSettings.preorderTags,
    labels: shopSettings.preorderLabels,
    shop: session.shop,
  });
};

const AVATAR_PALETTE = [
  { bg: "#E3F5EA", fg: "#2E8F4C" },
  { bg: "#EAF1FE", fg: "#4A6FE0" },
  { bg: "#FDF1E3", fg: "#B9740B" },
  { bg: "#FBE9EE", fg: "#C43D6B" },
  { bg: "#F0E9FE", fg: "#7C4FD6" },
  { bg: "#E3F6F5", fg: "#2A9D96" },
];

function CustomerAvatar({ name }: { name: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";
  const paletteIndex =
    name.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0) %
    AVATAR_PALETTE.length;
  const { bg, fg } = AVATAR_PALETTE[paletteIndex];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: "50%",
        background: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}

function TabButton({
  active,
  number,
  label,
  onClick,
}: {
  active: boolean;
  number: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <s-button
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
      accessibilityLabel={`${number}. ${label}${active ? " (selected)" : ""}`}
    >
      {number}. {label}
    </s-button>
  );
}

export default function ShippingManagerIndex() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [heldOrderIds, setHeldOrderIds] = useState<Set<string>>(new Set());
  const processedFetcherDataRef = useRef<unknown>(null);
  const [lastEmailRun, setLastEmailRun] = useState<{
    rows?: Array<{
      orderName: string;
      job: string;
      result: string;
      detail?: string;
    }>;
  } | null>(null);
  const [lastThursdayRun, setLastThursdayRun] = useState<{
    dryRun: boolean;
    customersProcessed: number;
    results: Array<{
      email: string;
      orderNames: string[];
      itemCount: number;
      shippingAmount: string;
      invoiceUrl?: string;
      error?: string;
    }>;
  } | null>(null);

  const [preorderSearch, setPreorderSearch] = useState("");
  const filteredPreorders = (() => {
    const q = preorderSearch.trim().toLowerCase();
    if (!q) return data.preorders;
    return data.preorders.filter((order) => {
      return (
        order.name.toLowerCase().includes(q) ||
        (order.customerName ?? "").toLowerCase().includes(q) ||
        (order.email ?? "").toLowerCase().includes(q)
      );
    });
  })();

  const pageSize = 10;
  const currentPage = Math.max(1, Number(searchParams.get("page") || "1"));
  const totalPages = Math.max(
    1,
    Math.ceil(filteredPreorders.length / pageSize),
  );
  const page = Math.min(currentPage, totalPages);

  const pagedPreorders = filteredPreorders.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );

  const setPage = (nextPage: number) => {
    startTransition(() => {
      const params = new URLSearchParams(searchParams);
      if (nextPage <= 1) {
        params.delete("page");
      } else {
        params.set("page", String(nextPage));
      }
      setSearchParams(params);
    });
  };

  const handlePreorderSearch = (
    e: Event & { currentTarget: { value: string } },
  ) => {
    setPreorderSearch(e.currentTarget.value);
    setPage(1);
  };

  const tab = (searchParams.get("tab") || data.tab || "preorders") as TabId;
  const cycleBusy = fetcher.state !== "idle";
  const [manualTestOpen, setManualTestOpen] = useState(false);
  const [thursdayDryRun, setThursdayDryRun] = useState(true);
  const defaultThursdayRunMode: ThursdayRunMode = data.thursdayAutomationEnabled
    ? "automatic"
    : "manual";
  const thursdayRunModeStorageKey = `rangeelaa:thursdayRunMode:${data.shop}`;
  const [savedThursdayRunMode, setSavedThursdayRunMode] =
    useState<ThursdayRunMode>(defaultThursdayRunMode);
  const [thursdayRunMode, setThursdayRunMode] = useState<ThursdayRunMode>(
    defaultThursdayRunMode,
  );
  const thursdayRunModeDirty = thursdayRunMode !== savedThursdayRunMode;

  useEffect(() => {
    const stored = window.localStorage.getItem(thursdayRunModeStorageKey);
    if (stored === "automatic" || stored === "manual") {
      setSavedThursdayRunMode(stored);
      setThursdayRunMode(stored);
    } else {
      setSavedThursdayRunMode(defaultThursdayRunMode);
      setThursdayRunMode(defaultThursdayRunMode);
    }
  }, [defaultThursdayRunMode, thursdayRunModeStorageKey]);

  const saveThursdayRunMode = () => {
    window.localStorage.setItem(thursdayRunModeStorageKey, thursdayRunMode);
    setSavedThursdayRunMode(thursdayRunMode);
    shopify.toast.show("Thursday cycle preference saved.");
  };

  const discardThursdayRunMode = () => {
    setThursdayRunMode(savedThursdayRunMode);
  };

  useEffect(() => {
    const freshAlertIds = new Set(data.alerts.map((order) => order.id));
    setHeldOrderIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (freshAlertIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [data.alerts]);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (!fetcher.data) return;
    if (processedFetcherDataRef.current === fetcher.data) return;
    processedFetcherDataRef.current = fetcher.data;

    const finishedAction = busyAction;
    setBusyAction(null);

    const succeeded = "ok" in fetcher.data && fetcher.data.ok;
    const hideAction = ALERT_HIDE_ACTIONS.find((action) =>
      finishedAction?.endsWith(`:${action}`),
    );
    if (hideAction && !succeeded) {
      const orderId = finishedAction!.slice(0, -`:${hideAction}`.length);
      setHeldOrderIds((prev) => {
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
    }

    if (finishedAction?.endsWith(":hold_for_next_cycle") && succeeded) {
      navigate(
        {
          search: `?tab=thursday`,
        },
        { replace: true },
      );
    }

    if ("rows" in fetcher.data && Array.isArray(fetcher.data.rows)) {
      setLastEmailRun({ rows: fetcher.data.rows });
    }

    if (
      "dryRun" in fetcher.data &&
      "customersProcessed" in fetcher.data &&
      "results" in fetcher.data &&
      Array.isArray(fetcher.data.results)
    ) {
      setLastThursdayRun({
        dryRun: Boolean(fetcher.data.dryRun),
        customersProcessed: Number(fetcher.data.customersProcessed || 0),
        results: fetcher.data.results,
      });
    }

    if ("message" in fetcher.data && fetcher.data.message) {
      const isError = "ok" in fetcher.data && fetcher.data.ok === false;
      shopify.toast.show(String(fetcher.data.message).slice(0, 200), {
        isError,
      });
      return;
    }

    if ("ok" in fetcher.data && fetcher.data.ok) {
      shopify.toast.show(
        "message" in fetcher.data && fetcher.data.message
          ? String(fetcher.data.message)
          : "Done",
      );
    } else if ("error" in fetcher.data && fetcher.data.error) {
      shopify.toast.show(String(fetcher.data.error), { isError: true });
    } else if ("ok" in fetcher.data && fetcher.data.ok === false) {
      const resultRows = (fetcher.data as FetcherResultWithRows).results;
      const rowError = Array.isArray(resultRows)
        ? resultRows.find((r) => r?.error)?.error
        : undefined;
      shopify.toast.show(
        String(rowError ?? "Thursday cycle failed. Check details."),
        { isError: true },
      );
    }
  }, [fetcher.state, fetcher.data, shopify, busyAction, navigate]);

  const setTab = (next: TabId) => {
    startTransition(() => {
      const params = new URLSearchParams(searchParams);
      if (next === "preorders") params.delete("tab");
      else params.set("tab", next);
      setSearchParams(params);
    });
  };

  const runAction = (orderId: string, actionName: StatusAction) => {
    setBusyAction(`${orderId}:${actionName}`);
    if ((ALERT_HIDE_ACTIONS as readonly string[]).includes(actionName)) {
      setHeldOrderIds((prev) => new Set(prev).add(orderId));
    }
    fetcher.submit(
      { intent: "status", orderId, actionName },
      { method: "POST" },
    );
  };

  const runCycle = (
    intent: "thursday_run" | "friday_run" | "status_emails_run",
    dryRun: boolean,
  ) => {
    setBusyAction(`${intent}:${dryRun ? "preview" : "run"}`);
    fetcher.submit({ intent, dryRun: dryRun ? "1" : "0" }, { method: "POST" });
  };

  const isBusy = (key: string) => busyAction === key && cycleBusy;
  const thursdayResult = lastThursdayRun ?? data.thursdayPreview;

  return (
    <s-page heading="Backend Heroku Klaviyo Manager" inlineSize="large">
      <SaveBar open={thursdayRunModeDirty}>
        <button variant="primary" onClick={saveThursdayRunMode}>
          Save
        </button>
        <button onClick={discardThursdayRunMode}>Discard</button>
      </SaveBar>

      <s-box paddingBlockEnd="small-200">
        <s-stack
          direction="inline"
          alignItems="center"
          justifyContent="space-between"
          gap="base"
        >
          <s-stack direction="inline" alignItems="center" gap="small-200">
          <s-icon type="wand" tone="info" size="base" />
          <span style={{ fontSize: 20, fontWeight: 700, color: "#1A1F36" }}>
            Welcome back — here's your shipping overview.
          </span>
          </s-stack>
          <s-badge tone="info" color="strong">
            Web Saree tag based app (preorder)
          </s-badge>
        </s-stack>
      </s-box>
      <s-box paddingBlockEnd="large">
        <div
          style={{
            background: "#FFFFFF",
            border: "1px solid #E3E8EF",
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          <s-box padding="base">
            <s-grid
              gridTemplateColumns="44px 1fr auto"
              alignItems="center"
              columnGap="base"
            >
              <s-box inlineSize="44px" blockSize="44px" overflow="hidden">
                <svg
                  width="44"
                  height="44"
                  viewBox="0 0 56 56"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <circle cx="28" cy="28" r="28" fill="#E3F5EA" />
                  <rect
                    x="13"
                    y="15"
                    width="30"
                    height="21"
                    rx="4"
                    fill="#FFFFFF"
                    stroke="#B4E0C4"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M13 19a4 4 0 0 1 4-4h22a4 4 0 0 1 4 4v2H13v-2Z"
                    fill="#34A853"
                    opacity="0.18"
                  />
                  <circle cx="17.5" cy="17.5" r="1" fill="#2E8F4C" />
                  <circle cx="20.5" cy="17.5" r="1" fill="#2E8F4C" />
                  <rect
                    x="18"
                    y="25"
                    width="17"
                    height="2"
                    rx="1"
                    fill="#CFEBDA"
                  />
                  <rect
                    x="18"
                    y="29.5"
                    width="11"
                    height="2"
                    rx="1"
                    fill="#CFEBDA"
                  />
                  <circle
                    cx="41"
                    cy="39"
                    r="10"
                    fill="#34A853"
                    stroke="#F4FBF7"
                    strokeWidth="2.5"
                  />
                  <path
                    d="M37 39.3l2.6 2.6 5.4-5.6"
                    fill="none"
                    stroke="#FFFFFF"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </s-box>
              <s-stack direction="block" gap="small-200">
                <span
                  style={{ fontSize: 16, fontWeight: 700, color: "#1A1F36" }}
                >
                  Store connected
                </span>
                <s-text color="subdued">
                  {data.shopName} — {data.shop}
                </s-text>
              </s-stack>
              <s-badge tone="success" color="strong" icon="check-circle-filled">
                Live
              </s-badge>
            </s-grid>
          </s-box>
          <s-divider color="base" />
          <s-box padding="base">
            <s-grid
              gridTemplateColumns="44px 1fr"
              alignItems="start"
              columnGap="base"
            >
              <s-box inlineSize="44px" blockSize="44px" overflow="hidden">
                <svg
                  width="44"
                  height="44"
                  viewBox="0 0 56 56"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <circle cx="28" cy="28" r="28" fill="#EAF1FE" />
                  <path
                    d="M28 14l12 6v12l-12 6-12-6V20l12-6Z"
                    fill="#FFFFFF"
                    stroke="#B9CDF7"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M16 20l12 6 12-6"
                    fill="none"
                    stroke="#6A8DF0"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path d="M28 26v12" stroke="#6A8DF0" strokeWidth="1.5" />
                  <circle
                    cx="41"
                    cy="39"
                    r="10"
                    fill="#4A6FE0"
                    stroke="#F4F7FE"
                    strokeWidth="2.5"
                  />
                  <path
                    d="M37 39h8M41 35v8"
                    stroke="#FFFFFF"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </s-box>
              <s-stack direction="block" gap="small-200">
                <span
                  style={{ fontSize: 16, fontWeight: 700, color: "#1A1F36" }}
                >
                  Shipping workflow
                </span>
                <s-paragraph>
                  Manage preorders, status emails, Thursday invoices,
                  shipping-paid alerts, and Friday reset. Use the steps below in
                  order — when you mark a preorder step, the matching Shopify
                  tag is added and Klaviyo sends the customer email. Tags,
                  button labels, and template IDs are configured in{" "}
                  <s-link href="/app/settings">Settings</s-link>.
                </s-paragraph>
              </s-stack>
            </s-grid>
          </s-box>
        </div>
      </s-box>

      <s-box paddingBlockEnd="large">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone="info" color="strong">
            {data.workflowSummary.readyToShipCount} orders ready to ship
          </s-badge>
          <s-badge tone="warning" color="strong">
            {data.workflowSummary.awaitingPaymentCount} awaiting payment
          </s-badge>
          <s-badge tone="neutral">
            Next shipping: {data.workflowSummary.nextShippingLabel}
          </s-badge>
        </s-stack>
      </s-box>

      {data.loadError && (
        <s-banner heading="Could not load data" tone="critical">
          <s-paragraph>{data.loadError}</s-paragraph>
          <s-paragraph>
            Reopen or reinstall the app and approve the{" "}
            <s-text type="strong">read_shipping</s-text> permission if prompted.
          </s-paragraph>
        </s-banner>
      )}

      {tab === "preorders" && (
        <s-banner heading="Preorder status workflow" tone="success">
          Update each preorder in order: {data.preorderLabels.pieceMade} →{" "}
          {data.preorderLabels.leavingForCanada} →{" "}
          {data.preorderLabels.arrivedInCanada}. Completed steps show as green
          success badges. Skirt deposits use{" "}
          {data.preorderLabels.depositFulfilled}.
          <s-button
            slot="secondary-actions"
            variant="secondary"
            href="/app/settings"
          >
            Edit button labels &amp; order tags
          </s-button>
        </s-banner>
      )}

      <s-section padding="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <TabButton
            active={tab === "preorders"}
            number="01"
            label="Preorders — Awaiting Readiness"
            onClick={() => setTab("preorders")}
          />
          <TabButton
            active={tab === "emails"}
            number="02"
            label="Status emails (Klaviyo)"
            onClick={() => setTab("emails")}
          />
          <TabButton
            active={tab === "thursday"}
            number="03"
            label="Thursday invoice"
            onClick={() => setTab("thursday")}
          />
          <TabButton
            active={tab === "alerts"}
            number="04"
            label="After shipping paid"
            onClick={() => setTab("alerts")}
          />
          <TabButton
            active={tab === "friday"}
            number="05"
            label="Friday reset"
            onClick={() => setTab("friday")}
          />
        </s-stack>
      </s-section>

      {tab === "preorders" && (
        <s-section heading="Preorders — Awaiting Readiness" padding="base">
          <s-stack direction="block" gap="large">
            <s-banner tone="info" heading="What this tab shows">
              <s-stack gap="small-200">
                <s-paragraph>
                  This tab shows only orders that include a product with the
                  configured Shopify product tag, normally Web Saree. Orders
                  without that product tag are hidden from this app.
                </s-paragraph>
                <s-paragraph>
                  Staff should move each preorder through the status buttons in
                  order: Piece Made, Leaving for Canada, then Arrived in Canada.
                </s-paragraph>
              </s-stack>
            </s-banner>

            <s-box
              background="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
              borderRadius="large-100"
              padding="base"
            >
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Button and email flow</s-text>
                <s-unordered-list>
                  <s-list-item>
                    Clicking a status button adds the matching Shopify order tag
                    and sends the matching Klaviyo event immediately.
                  </s-list-item>
                  <s-list-item>
                    The next button unlocks only after the previous step is
                    completed, so staff can follow the correct order.
                  </s-list-item>
                  <s-list-item>
                    Completed steps display as badges. A completed badge does
                    not resend the customer email.
                  </s-list-item>
                  <s-list-item>
                    Arrived in Canada also adds the Ready to Ship tag so the
                    order can qualify for the Thursday shipping invoice cycle.
                  </s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-box>

            {data.preorders.length === 0 ? (
              <s-banner heading="No preorders yet" tone="info">
                <s-paragraph>
                  Create a test order in the store to see status actions here.
                </s-paragraph>
              </s-banner>
            ) : (
              <s-stack direction="block" gap="base">
                <s-table>
                  <s-search-field
                    slot="filters"
                    label="Search preorders"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search by order #, customer, or email"
                    value={preorderSearch}
                    onChange={handlePreorderSearch}
                    onInput={handlePreorderSearch}
                  />
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Order</s-table-header>
                    <s-table-header listSlot="secondary">
                      Customer
                    </s-table-header>
                    <s-table-header listSlot="labeled">Type</s-table-header>
                    <s-table-header listSlot="inline">Actions</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {pagedPreorders.map((order) => (
                      <s-table-row key={order.id}>
                        <s-table-cell>
                          <s-link
                            href={`shopify://admin/orders/${order.id
                              .split("/")
                              .pop()}`}
                          >
                            {order.name}
                          </s-link>
                        </s-table-cell>
                        <s-table-cell>
                          {order.customerName || order.email ? (
                            <s-stack
                              direction="inline"
                              alignItems="center"
                              gap="small-200"
                            >
                              <CustomerAvatar
                                name={order.customerName || order.email || "?"}
                              />
                              <s-text>
                                {order.customerName || order.email}
                              </s-text>
                            </s-stack>
                          ) : (
                            "—"
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          {order.isSkirtDeposit ? (
                            hasTag(
                              order.tags,
                              data.preorderTags.depositFulfilledTag,
                            ) ? (
                              <s-badge
                                tone="neutral"
                                color="strong"
                                icon="check-circle"
                              >
                                Skirt deposit
                              </s-badge>
                            ) : (
                              <s-badge tone="info" color="strong">
                                Skirt deposit
                              </s-badge>
                            )
                          ) : hasTag(
                              order.tags,
                              data.preorderTags.arrivedInCanadaTag,
                            ) ||
                            hasTag(
                              order.tags,
                              data.preorderTags.readyToShipTag,
                            ) ? (
                            <s-badge
                              tone="neutral"
                              color="strong"
                              icon="check-circle"
                            >
                              Preorder
                            </s-badge>
                          ) : hasTag(
                              order.tags,
                              data.preorderTags.leavingForCanadaTag,
                            ) ? (
                            <s-badge tone="caution" color="strong">
                              Preorder
                            </s-badge>
                          ) : hasTag(
                              order.tags,
                              data.preorderTags.pieceMadeTag,
                            ) ? (
                            <s-badge tone="info" color="strong">
                              Preorder
                            </s-badge>
                          ) : (
                            <s-badge tone="neutral">Preorder</s-badge>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          <PreorderStatusButtons
                            order={order}
                            busyAction={busyAction}
                            onAction={runAction}
                            labels={data.preorderLabels}
                            workflowTags={data.preorderTags}
                          />
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>

                {filteredPreorders.length === 0 && (
                  <s-paragraph>
                    No preorders match "{preorderSearch}".
                  </s-paragraph>
                )}

                {totalPages > 1 && (
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="center"
                    inlineSize="100%"
                  >
                    <s-button
                      variant="secondary"
                      disabled={page <= 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </s-button>
                    <s-text color="subdued">
                      Page {page} of {totalPages}
                    </s-text>
                    <s-button
                      variant="secondary"
                      disabled={page >= totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </s-button>
                  </s-stack>
                )}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      {tab === "emails" && (
        <s-section heading="Status emails" padding="base">
          <s-stack direction="block" gap="large">
            <s-box
              background="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
              borderRadius="large-100"
              padding="large"
            >
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" alignItems="center" gap="small-200">
                  <s-badge tone="info" color="strong">
                    How it works
                  </s-badge>
                </s-stack>
                <s-paragraph>
                  When a status tag is added, the app creates a Klaviyo event. A
                  live Klaviyo Flow for that metric sends the email, then the
                  app adds an email-sent tag so it is not sent again.
                </s-paragraph>
                <s-unordered-list>
                  <s-list-item>
                    {data.preorderLabels.pieceMade} → tag{" "}
                    <s-text type="strong">
                      {data.preorderTags.pieceMadeTag}
                    </s-text>{" "}
                    → metric "{KLAVIYO_STATUS_EMAIL_META.piece_made.metricName}"
                    → template {data.klaviyoTemplates.pieceMadeTemplateId} →
                    email-sent tag{" "}
                    <s-text type="strong">
                      {data.preorderTags.pieceMadeEmailSentTag}
                    </s-text>
                  </s-list-item>
                  <s-list-item>
                    {data.preorderLabels.leavingForCanada} → tag{" "}
                    <s-text type="strong">
                      {data.preorderTags.leavingForCanadaTag}
                    </s-text>{" "}
                    → metric "
                    {KLAVIYO_STATUS_EMAIL_META.leaving_for_canada.metricName}" →
                    template {data.klaviyoTemplates.leavingForCanadaTemplateId}{" "}
                    → email-sent tag{" "}
                    <s-text type="strong">
                      {data.preorderTags.leavingEmailSentTag}
                    </s-text>
                  </s-list-item>
                  <s-list-item>
                    {data.preorderLabels.arrivedInCanada} → tag{" "}
                    <s-text type="strong">
                      {data.preorderTags.arrivedInCanadaTag}
                    </s-text>{" "}
                    → metric "
                    {KLAVIYO_STATUS_EMAIL_META.arrived_in_canada.metricName}" →
                    template {data.klaviyoTemplates.arrivedInCanadaTemplateId} →
                    email-sent tag{" "}
                    <s-text type="strong">
                      {data.preorderTags.arrivedEmailSentTag}
                    </s-text>
                  </s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-box>

            <s-box
              background="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
              borderRadius="large-100"
              padding="base"
            >
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Preview and retry rules</s-text>
                <s-unordered-list>
                  <s-list-item>
                    Preview only checks which Web Saree orders still need a
                    status email event. It does not send emails and does not
                    update tags.
                  </s-list-item>
                  <s-list-item>
                    Send pending emails now sends only missing Klaviyo events
                    where the status tag exists but the matching email-sent tag
                    is missing.
                  </s-list-item>
                  <s-list-item>
                    After Klaviyo accepts the event, the app adds the matching
                    email-sent tag so the same status email is not retried again.
                  </s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-box>

            <s-banner heading="Tags, labels &amp; templates" tone="info">
              Configure Shopify order tags, button labels, and Klaviyo template
              IDs on the Settings page.
              <s-button
                slot="secondary-actions"
                variant="secondary"
                href="/app/settings"
              >
                Open Settings
              </s-button>
            </s-banner>

            <s-banner
              heading={
                data.klaviyoConfigured
                  ? "Klaviyo is connected"
                  : "Klaviyo API key is missing"
              }
              tone={data.klaviyoConfigured ? "success" : "warning"}
            >
              To test: in Shopify Admin, add the tag{" "}
              <s-text type="strong">piece-made-notified</s-text> to an order.
              Confirm the customer receives the email and the order gets{" "}
              <s-text type="strong">piece-made-email-sent</s-text>.
              <s-button
                slot="secondary-actions"
                variant="secondary"
                href="/app/documentation"
              >
                View setup guide
              </s-button>
            </s-banner>

            <s-stack direction="block" gap="base">
              <s-paragraph>
                These buttons retry orders where the app has not yet
                successfully sent the Klaviyo event for a status tag (the
                email-sent tag is still missing) — for example a failed
                real-time send, or a tag added directly in Shopify Admin. They
                can't tell whether Klaviyo's Flow actually delivered an email it
                already accepted — check the Flow itself for that.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant={
                    isBusy("status_emails_run:preview")
                      ? "primary"
                      : "secondary"
                  }
                  disabled={cycleBusy}
                  {...(isBusy("status_emails_run:preview")
                    ? { loading: true }
                    : {})}
                  onClick={() => runCycle("status_emails_run", true)}
                >
                  Preview only (no emails sent)
                </s-button>
                <s-button
                  variant="primary"
                  disabled={cycleBusy}
                  {...(isBusy("status_emails_run:run")
                    ? { loading: true }
                    : {})}
                  onClick={() => runCycle("status_emails_run", false)}
                >
                  Send pending emails now
                </s-button>
              </s-stack>

              {lastEmailRun?.rows && lastEmailRun.rows.length > 0 && (
                <s-box
                  background="base"
                  borderWidth="base"
                  borderStyle="solid"
                  borderColor="subdued"
                  borderRadius="large-100"
                  padding="none"
                  overflow="hidden"
                >
                  <s-box padding="base">
                    <s-text type="strong">Last check result</s-text>
                  </s-box>
                  <s-divider color="base" />
                  <s-table>
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Order</s-table-header>
                      <s-table-header listSlot="secondary">Job</s-table-header>
                      <s-table-header listSlot="labeled">Result</s-table-header>
                      <s-table-header listSlot="inline">Detail</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {lastEmailRun.rows.map((row, i) => {
                        const isPreview = row.detail?.includes("preview only");
                        const label =
                          row.result === "sent"
                            ? "Email sent"
                            : row.result === "error"
                              ? "Failed"
                              : isPreview
                                ? "Preview only"
                                : "Skipped";
                        const tone =
                          row.result === "sent"
                            ? "success"
                            : row.result === "error"
                              ? "critical"
                              : isPreview
                                ? "info"
                                : "neutral";
                        const extra =
                          row.result === "error"
                            ? row.detail
                            : row.detail?.includes("would send template")
                              ? row.detail.replace("preview only — ", "")
                              : undefined;
                        return (
                          <s-table-row key={`${row.orderName}-${row.job}-${i}`}>
                            <s-table-cell>{row.orderName}</s-table-cell>
                            <s-table-cell>{row.job}</s-table-cell>
                            <s-table-cell>
                              <s-badge tone={tone} color="strong">
                                {label}
                              </s-badge>
                            </s-table-cell>
                            <s-table-cell>{extra || "—"}</s-table-cell>
                          </s-table-row>
                        );
                      })}
                    </s-table-body>
                  </s-table>
                </s-box>
              )}
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {tab === "thursday" && (
        <s-section heading="Thursday shipping invoice" padding="base">
          <s-stack direction="block" gap="large">
            <s-paragraph>
              Combines eligible preorder and ready-to-wear orders for the same
              customer into one draft shipping invoice. Uses the allowed
              shipping countries from Settings ({data.allowedCountryCodesLabel}
              ). Excludes Saskatoon and India-only / mixed India orders.
            </s-paragraph>

            <s-box
              background="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
              borderRadius="large-100"
              padding="base"
            >
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Which orders qualify for this cycle</s-text>
                <s-unordered-list>
                  <s-list-item>
                    Preorder orders qualify after Arrived in Canada and Ready to
                    Ship are completed.
                  </s-list-item>
                  <s-list-item>
                    Ready-to-wear Web Saree orders qualify when they are paid
                    and still unfulfilled.
                  </s-list-item>
                  <s-list-item>
                    The order must include a Web Saree tagged product that
                    requires shipping.
                  </s-list-item>
                  <s-list-item>
                    The app excludes Saskatoon, India-direct, unsupported
                    shipping countries, already shipping-paid orders, and orders
                    already marked thursday-email-sent.
                  </s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-box>

            <s-box
              background={manualTestOpen ? "subdued" : "base"}
              borderWidth="base"
              borderStyle="solid"
              borderColor={manualTestOpen ? "strong" : "subdued"}
              borderRadius="large"
              padding="none"
              overflow="hidden"
            >
              <s-clickable
                padding="base"
                inlineSize="100%"
                background={manualTestOpen ? "subdued" : "transparent"}
                accessibilityLabel={`${manualTestOpen ? "Collapse" : "Expand"} Manual Test — Thursday Shipping Invoice`}
                onClick={() => setManualTestOpen(!manualTestOpen)}
              >
                <s-stack
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="center"
                  gap="base"
                  inlineSize="100%"
                >
                  <s-stack
                    direction="inline"
                    alignItems="center"
                    gap="small-200"
                  >
                    <s-badge
                      tone={manualTestOpen ? "info" : "neutral"}
                      color={manualTestOpen ? "strong" : "base"}
                    >
                      TEST
                    </s-badge>
                    <s-text type="strong">
                      Manual Test — Thursday Shipping Invoice
                    </s-text>
                  </s-stack>
                  <s-icon type={manualTestOpen ? "caret-up" : "caret-down"} />
                </s-stack>
              </s-clickable>

              {manualTestOpen ? (
                <>
                  <s-divider color="strong" />
                  <s-box background="base" padding="base">
                    <s-stack gap="small-200">
                      <s-unordered-list>
                        <s-list-item>
                          Create a fresh normal Shopify order.
                        </s-list-item>
                        <s-list-item>
                          Use customer email:{" "}
                          <s-text type="strong">test@gmail.com</s-text>
                        </s-list-item>
                        <s-list-item>
                          Use a Canadian shipping address (not Saskatoon).
                        </s-list-item>
                        <s-list-item>
                          Keep the order Paid and Unfulfilled.
                        </s-list-item>
                        <s-list-item>
                          For isolated testing, add these Shopify tags:
                        </s-list-item>
                        <s-list-item>
                          <s-unordered-list>
                            <s-list-item>
                              arrived-in-canada-notified
                            </s-list-item>
                            <s-list-item>ready-to-ship</s-list-item>
                          </s-unordered-list>
                        </s-list-item>
                        <s-list-item>
                          Do NOT add: thursday-email-sent, shipping-paid,
                          pushed-to-next-weekend, hold-for-next-cycle,
                          india-direct
                        </s-list-item>
                        <s-list-item>
                          Open: Backend Heroku Klaviyo Manager → 03. Thursday invoice
                        </s-list-item>
                        <s-list-item>
                          Select: Manual run. If the Shopify Save bar appears,
                          click Save.
                        </s-list-item>
                        <s-list-item>
                          Keep Dry Run on, then click: Run Thursday Cycle (Dry
                          Run)
                        </s-list-item>
                        <s-list-item>
                          Confirm Preview shows: 1 customer, customer email,
                          order number, item count, shipping amount
                        </s-list-item>
                        <s-list-item>
                          If Preview shows 1 customer, turn Dry Run off and
                          click: Run Thursday Cycle
                        </s-list-item>
                      </s-unordered-list>

                      <s-heading>Expected Result</s-heading>
                      <s-unordered-list>
                        <s-list-item>
                          A new Shopify Draft Order is created.
                        </s-list-item>
                        <s-list-item>
                          The draft invoice amount matches the active Shopify
                          shipping profile rate for the shipping address and is
                          not $0.00.
                        </s-list-item>
                        <s-list-item>
                          The customer receives the Klaviyo Thursday shipping
                          invoice email.
                        </s-list-item>
                        <s-list-item>
                          The original order receives the tag:{" "}
                          <s-text type="strong">thursday-email-sent</s-text>.
                        </s-list-item>
                        <s-list-item>
                          The email displays: customer name, item count,
                          shipping total, working Pay Shipping button, working
                          invoice URL.
                        </s-list-item>
                      </s-unordered-list>

                      <s-banner tone="warning" heading="Warning">
                        <s-paragraph>
                          Use these manual tags only for isolated testing. In
                          the real workflow, status and readiness tags should
                          normally come from the app buttons or the configured
                          automation.
                        </s-paragraph>
                      </s-banner>

                      <s-banner tone="info" heading="Troubleshooting">
                        <s-paragraph>
                          If Preview shows 0 customers, check:
                        </s-paragraph>
                        <s-unordered-list>
                          <s-list-item>
                            order is a normal order, not a draft;
                          </s-list-item>
                          <s-list-item>order is Paid;</s-list-item>
                          <s-list-item>order is Unfulfilled;</s-list-item>
                          <s-list-item>shipping country is Canada;</s-list-item>
                          <s-list-item>city is not Saskatoon;</s-list-item>
                          <s-list-item>required tags are present;</s-list-item>
                          <s-list-item>
                            thursday-email-sent is not already present.
                          </s-list-item>
                        </s-unordered-list>
                      </s-banner>
                    </s-stack>
                  </s-box>
                </>
              ) : null}
            </s-box>

            <s-box
              background="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
              borderRadius="large-100"
              padding="base"
            >
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">Thursday Cycle</s-text>
                  <s-paragraph>
                    Use Dry Run to preview the orders that would be processed.
                    Turn it off to create draft invoices, send emails, and
                    update orders.
                  </s-paragraph>
                </s-stack>

                <s-stack direction="inline" gap="small-200">
                  <s-button
                    variant={
                      thursdayRunMode === "automatic" ? "primary" : "secondary"
                    }
                    onClick={() => setThursdayRunMode("automatic")}
                  >
                    Automatic schedule
                  </s-button>
                  <s-button
                    variant={
                      thursdayRunMode === "manual" ? "primary" : "secondary"
                    }
                    onClick={() => setThursdayRunMode("manual")}
                  >
                    Manual run
                  </s-button>
                </s-stack>

                {thursdayRunMode === "automatic" ? (
                  <s-box
                    background="subdued"
                    borderWidth="base"
                    borderStyle="solid"
                    borderColor="subdued"
                    borderRadius="base"
                    padding="base"
                  >
                    <s-stack direction="block" gap="small-200">
                      <s-badge
                        tone={
                          data.thursdayAutomationEnabled ? "success" : "warning"
                        }
                        color="strong"
                      >
                        {data.thursdayAutomationEnabled
                          ? "Automatic schedule enabled"
                          : "Automatic schedule disabled"}
                      </s-badge>
                      <s-paragraph>
                        {data.cronConfigured
                          ? `Heroku Scheduler calls this daily. The app only processes orders on Thursday in ${data.cronTimeZone}.`
                          : "Set CRON_SECRET and CRON_SHOP before using automatic Thursday runs."}
                      </s-paragraph>
                      <s-paragraph>
                        Schedule settings are managed in Heroku.
                      </s-paragraph>
                    </s-stack>
                  </s-box>
                ) : (
                  <s-stack direction="block" gap="base">
                    <s-checkbox
                      label="Dry Run"
                      checked={thursdayDryRun}
                      onChange={(event) =>
                        setThursdayDryRun(event.currentTarget.checked)
                      }
                    />

                    <s-paragraph>
                      {thursdayDryRun
                        ? "When on, the cycle only previews which orders would be processed. No emails are sent and no invoices are created."
                        : "When off, the cycle creates draft invoices, sends emails, and updates the matching orders."}
                    </s-paragraph>

                    <s-button
                      variant="primary"
                      disabled={cycleBusy}
                      {...(isBusy(
                        `thursday_run:${thursdayDryRun ? "preview" : "run"}`,
                      )
                        ? { loading: true }
                        : {})}
                      onClick={() => runCycle("thursday_run", thursdayDryRun)}
                    >
                      {thursdayDryRun
                        ? "Run Thursday Cycle (Dry Run)"
                        : "Run Thursday Cycle"}
                    </s-button>
                  </s-stack>
                )}
              </s-stack>
            </s-box>

            {!data.thursdayTemplateConfigured && (
              <s-banner
                heading="Thursday email template ID is missing"
                tone="warning"
              >
                <s-paragraph>
                  Open Settings and set the Thursday shipping invoice template
                  ID, then save. Preview and draft orders still work; invoice
                  emails send after the ID is set.
                </s-paragraph>
              </s-banner>
            )}

            {thursdayResult && (
              <s-box
                background="base"
                borderWidth="base"
                borderStyle="solid"
                borderColor="subdued"
                borderRadius="large-100"
                padding="none"
                overflow="hidden"
              >
                <s-box padding="base">
                  <s-text type="strong">
                    {thursdayResult.dryRun ? "Preview" : "Last run"}:{" "}
                    {thursdayResult.customersProcessed} customer(s)
                  </s-text>
                </s-box>
                {thursdayResult.results.length === 0 ? (
                  <>
                    <s-divider color="base" />
                    <s-box padding="base">
                      <s-paragraph>
                        No qualifying orders this cycle.
                      </s-paragraph>
                    </s-box>
                  </>
                ) : (
                  <>
                    <s-divider color="base" />
                    <s-table>
                      <s-table-header-row>
                        <s-table-header listSlot="primary">
                          Email
                        </s-table-header>
                        <s-table-header listSlot="secondary">
                          Orders
                        </s-table-header>
                        <s-table-header listSlot="labeled">
                          Items
                        </s-table-header>
                        <s-table-header listSlot="inline">
                          Shipping
                        </s-table-header>
                      </s-table-header-row>
                      <s-table-body>
                        {thursdayResult.results.map((row) => (
                          <s-table-row key={row.email}>
                            <s-table-cell>
                              <s-stack
                                direction="inline"
                                alignItems="center"
                                gap="small-200"
                              >
                                <CustomerAvatar name={row.email} />
                                <s-text>{row.email}</s-text>
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              <s-text>{row.orderNames.join(", ")}</s-text>
                            </s-table-cell>
                            <s-table-cell>
                              <s-badge tone="info" color="strong">
                                {row.itemCount}
                              </s-badge>
                            </s-table-cell>
                            <s-table-cell>
                              <s-badge tone="success" color="strong">
                                {row.shippingAmount}
                              </s-badge>
                            </s-table-cell>
                          </s-table-row>
                        ))}
                      </s-table-body>
                    </s-table>
                  </>
                )}
              </s-box>
            )}

            <s-banner tone="info" heading="How shipping is calculated">
              <s-stack gap="small-200">
                <s-paragraph>
                  The Items count includes only Web Saree tagged line items that
                  require shipping. If the same customer has multiple eligible
                  orders, the app combines those Web Saree item quantities into
                  one count.
                </s-paragraph>
                <s-paragraph>
                  The Shipping amount is then read from Shopify Shipping
                  profiles using the customer shipping country/province and that
                  Web Saree item count. The app does not use a hardcoded
                  fallback rate.
                </s-paragraph>
              </s-stack>
            </s-banner>
          </s-stack>
        </s-section>
      )}

      {tab === "alerts" &&
        (() => {
          const visibleAlerts = data.alerts.filter(
            (order) => !heldOrderIds.has(order.id),
          );
          return (
            <s-section heading="New item after shipping paid" padding="base">
              <s-stack direction="block" gap="large">
                <s-box
                  background="base"
                  borderWidth="base"
                  borderStyle="solid"
                  borderColor="subdued"
                  borderRadius="large-100"
                  padding="large"
                >
                  <s-stack direction="block" gap="base">
                    <s-badge
                      tone={visibleAlerts.length > 0 ? "warning" : "success"}
                      color="strong"
                    >
                      {visibleAlerts.length} pending
                    </s-badge>
                    <s-paragraph>
                      Ship now opens the exact order in Shopify Admin so staff
                      can fulfil it, add tracking, and notify the customer
                      manually. Hold for next Thursday adds the tag{" "}
                      <s-text type="strong">hold-for-next-cycle</s-text>.
                    </s-paragraph>
                  </s-stack>
                </s-box>

                <s-box
                  background="base"
                  borderWidth="base"
                  borderStyle="solid"
                  borderColor="subdued"
                  borderRadius="large-100"
                  padding="base"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">How this tab decides alerts</s-text>
                    <s-unordered-list>
                      <s-list-item>
                        The customer must already have a Web Saree order marked
                        shipping-paid.
                      </s-list-item>
                      <s-list-item>
                        The newer order must also contain a Web Saree tagged
                        product, must need shipping, and must be in an allowed
                        shipping country.
                      </s-list-item>
                      <s-list-item>
                        Ship now opens Shopify Admin for manual fulfilment. The
                        app does not calculate a new shipping invoice from that
                        button.
                      </s-list-item>
                      <s-list-item>
                        Hold for next Thursday adds hold-for-next-cycle, hides
                        the alert, and lets the order join the next Thursday
                        invoice run where shipping is calculated.
                      </s-list-item>
                    </s-unordered-list>
                  </s-stack>
                </s-box>

                {visibleAlerts.length === 0 ? (
                  <s-paragraph>No alerts right now.</s-paragraph>
                ) : (
                  <s-stack direction="block" gap="base">
                    {visibleAlerts.map((order) => (
                      <ShippingPaidAlert
                        key={order.id}
                        order={order}
                        busy={busyAction === `${order.id}:hold_for_next_cycle`}
                        onHold={(orderId) =>
                          runAction(orderId, "hold_for_next_cycle")
                        }
                      />
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-section>
          );
        })()}

      {tab === "friday" && (
        <s-section heading="Friday reset" padding="base">
          <s-stack direction="block" gap="large">
            <s-box
              background="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
              borderRadius="large-100"
              padding="large"
            >
              <s-stack direction="block" gap="base">
                <s-badge tone="success" color="strong">
                  Automatic via Shopify Flow
                </s-badge>
                <s-paragraph>
                  On Friday midnight (CST), Shopify Flow removes{" "}
                  <s-text type="strong">thursday-email-sent</s-text> and adds{" "}
                  <s-text type="strong">pushed-to-next-weekend</s-text>. The app
                  then cancels the old unpaid draft invoice.
                </s-paragraph>
                <s-paragraph>
                  Use the buttons below only as a manual backup if Flow did not
                  run.
                </s-paragraph>
              </s-stack>
            </s-box>

            <s-box
              background="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
              borderRadius="large-100"
              padding="base"
            >
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">What the backup reset changes</s-text>
                <s-unordered-list>
                  <s-list-item>
                    Preview only shows how many unpaid Thursday invoice orders
                    would be reset. It makes no changes.
                  </s-list-item>
                  <s-list-item>
                    Run Friday backup now removes thursday-email-sent, adds
                    pushed-to-next-weekend, clears the saved Thursday draft ID,
                    and cancels the old unpaid draft invoice.
                  </s-list-item>
                  <s-list-item>
                    Orders that already have shipping-paid are not reset. Paid
                    shipping stays completed.
                  </s-list-item>
                  <s-list-item>
                    After reset, the order can be included again in a future
                    Thursday shipping invoice cycle.
                  </s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-box>

            <s-button-group
              gap="base"
              accessibilityLabel="Friday reset actions"
            >
              <s-button
                slot="secondary-actions"
                variant={isBusy("friday_run:preview") ? "primary" : "secondary"}
                disabled={cycleBusy}
                {...(isBusy("friday_run:preview") ? { loading: true } : {})}
                onClick={() => runCycle("friday_run", true)}
              >
                Preview only (no changes)
              </s-button>
              <s-button
                slot="primary-action"
                variant="primary"
                tone="critical"
                disabled={cycleBusy}
                {...(isBusy("friday_run:run") ? { loading: true } : {})}
                onClick={() => runCycle("friday_run", false)}
              >
                Run Friday backup now
              </s-button>
            </s-button-group>
            {!data.cronConfigured && (
              <s-banner heading="Scheduler settings incomplete" tone="warning">
                <s-paragraph>
                  Set <s-text type="strong">CRON_SECRET</s-text> and{" "}
                  <s-text type="strong">CRON_SHOP</s-text> for automated
                  Thursday runs.
                </s-paragraph>
              </s-banner>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
