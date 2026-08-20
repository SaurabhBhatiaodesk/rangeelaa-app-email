import { hasTag, normalizeTags, type StatusEmailAction } from "./tags";
import { sendStatusEmailIfNeeded } from "./send-status-email.server";
import {
  emailSentTagForAction,
  getShopSettings,
  statusTagForAction,
  templateIdForAction,
} from "./klaviyo-settings.server";
import {
  type AdminGraphql,
  graphqlJson,
} from "./cycle-shared.server";
import { hasConfiguredProductTag } from "./product-eligibility.server";

/**
 * Client Task 1 — Heroku poller (NOT Shopify Flow).
 * Sidekick/buttons add status tags → this job sends Klaviyo + email-sent tags.
 */

type StatusEmailJob = {
  statusAction: StatusEmailAction;
  label: string;
};

const STATUS_EMAIL_ACTIONS: StatusEmailAction[] = [
  "piece_made",
  "leaving_for_canada",
  "arrived_in_canada",
];

export type StatusEmailRow = {
  orderName: string;
  orderId: string;
  email: string | null;
  job: string;
  result: "sent" | "skipped" | "error";
  detail?: string;
};

export type StatusEmailPollResult = {
  ok: boolean;
  dryRun: boolean;
  checked: number;
  sent: number;
  skipped: number;
  errors: number;
  rows: StatusEmailRow[];
  message: string;
};

function buildJobs(settings: Awaited<ReturnType<typeof getShopSettings>>): StatusEmailJob[] {
  return STATUS_EMAIL_ACTIONS.map((statusAction) => {
    switch (statusAction) {
      case "piece_made":
        return { statusAction, label: settings.preorderLabels.pieceMade };
      case "leaving_for_canada":
        return {
          statusAction,
          label: settings.preorderLabels.leavingForCanada,
        };
      case "arrived_in_canada":
        return {
          statusAction,
          label: settings.preorderLabels.arrivedInCanada,
        };
    }
  });
}

async function fetchOrdersNeedingEmail(
  admin: AdminGraphql,
  statusTag: string,
  sentTag: string,
  preorderProductTag: string,
) {
  const query = `tag:${statusTag} AND -tag:${sentTag}`;
  const json = await graphqlJson(
    admin,
    `#graphql
      query StatusEmailOrders($first: Int!, $query: String!) {
        orders(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              email
              tags
              lineItems(first: 250) {
                edges {
                  node {
                    product {
                      tags
                    }
                  }
                }
              }
            }
          }
        }
      }`,
    { first: 50, query },
  );

  return (json.data?.orders?.edges ?? []).map(
    (edge: {
      node: {
        id: string;
        name: string;
        email: string | null;
        tags: string[] | string;
        lineItems?: {
          edges?: Array<{
            node?: { product?: { tags?: string[] | string } | null };
          }>;
        };
      };
    }) => {
      const lineEdges = edge.node.lineItems?.edges ?? [];
      return {
        id: edge.node.id,
        name: edge.node.name,
        email: edge.node.email,
        tags: normalizeTags(edge.node.tags),
        lineItems: lineEdges.map((lineEdge) => ({
          productTags: normalizeTags(lineEdge.node?.product?.tags),
        })),
      };
    },
  ).filter((order: { lineItems: Array<{ productTags: string[] }> }) =>
    hasConfiguredProductTag(order, preorderProductTag),
  );
}

export async function runStatusEmailPoller(
  admin: AdminGraphql,
  options: { dryRun?: boolean; shop: string },
): Promise<StatusEmailPollResult> {
  const dryRun = Boolean(options.dryRun);
  const settings = await getShopSettings(options.shop);
  const jobs = buildJobs(settings);
  const rows: StatusEmailRow[] = [];
  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let checked = 0;

  for (const job of jobs) {
    const statusTag = statusTagForAction(
      settings.preorderTags,
      job.statusAction,
    );
    const sentTag = emailSentTagForAction(
      settings.preorderTags,
      job.statusAction,
    );

    const orders = await fetchOrdersNeedingEmail(
      admin,
      statusTag,
      sentTag,
      settings.preorderTags.preorderProductTag,
    );

    for (const order of orders) {
      checked += 1;

      const statusOk = hasTag(order.tags, statusTag);
      const alreadySent = hasTag(order.tags, sentTag);

      if (!statusOk || alreadySent || !order.email) {
        skipped += 1;
        rows.push({
          orderName: order.name,
          orderId: order.id,
          email: order.email,
          job: job.label,
          result: "skipped",
          detail: !statusOk
            ? "status tag missing"
            : alreadySent
              ? "email-sent already present"
              : "no customer email",
        });
        continue;
      }

      if (dryRun) {
        skipped += 1;
        rows.push({
          orderName: order.name,
          orderId: order.id,
          email: order.email,
          job: job.label,
          result: "skipped",
          detail: `preview only — would send template ${templateIdForAction(settings.klaviyoTemplates, job.statusAction)}`,
        });
        continue;
      }

      const result = await sendStatusEmailIfNeeded(admin, {
        orderId: order.id,
        email: order.email,
        tags: order.tags,
        statusAction: job.statusAction,
        shop: options.shop,
        workflowTags: settings.preorderTags,
      });

      if (!result.ok) {
        errors += 1;
        rows.push({
          orderName: order.name,
          orderId: order.id,
          email: order.email,
          job: job.label,
          result: "error",
          detail: result.error,
        });
        continue;
      }

      if (result.skipped) {
        skipped += 1;
        rows.push({
          orderName: order.name,
          orderId: order.id,
          email: order.email,
          job: job.label,
          result: "skipped",
        });
        continue;
      }

      sent += 1;
      rows.push({
        orderName: order.name,
        orderId: order.id,
        email: order.email,
        job: job.label,
        result: "sent",
        detail: `template ${templateIdForAction(settings.klaviyoTemplates, job.statusAction)}`,
      });
    }
  }

  return {
    ok: errors === 0,
    dryRun,
    checked,
    sent,
    skipped,
    errors,
    rows,
    message: dryRun
      ? `Preview: checked ${checked} order(s) — no emails were sent`
      : errors > 0
        ? `Status emails: sent ${sent}, skipped ${skipped}, failed ${errors}. ${
            rows
              .filter((r) => r.result === "error")
              .map((r) => `${r.orderName} (${r.job}): ${r.detail}`)
              .slice(0, 2)
              .join(" | ")
          }`
        : `Status emails: sent ${sent}, skipped ${skipped}`,
  };
}
