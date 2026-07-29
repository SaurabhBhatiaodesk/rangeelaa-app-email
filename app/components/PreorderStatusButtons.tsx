import { hasTag } from "../lib/tags";
import type { ShippingOrder } from "../lib/orders.server";
import type { StatusAction } from "../lib/tags";
import type { PreorderWorkflowLabels, PreorderWorkflowTags } from "../lib/klaviyo-settings.server";

type Props = {
  order: ShippingOrder;
  busyAction: string | null;
  onAction: (orderId: string, action: StatusAction) => void;
  labels: PreorderWorkflowLabels;
  workflowTags: PreorderWorkflowTags;
};

function DoneBadge({
  children,
  tone = "success",
}: {
  children: string;
  tone?: "info" | "caution" | "success";
}) {
  return (
    <s-badge tone={tone} color="strong" icon="check-circle">
      {children}
    </s-badge>
  );
}

export function PreorderStatusButtons({
  order,
  busyAction,
  onAction,
  labels,
  workflowTags,
}: Props) {
  const { tags, id, isSkirtDeposit } = order;
  const busy = busyAction?.startsWith(id) ?? false;

  if (isSkirtDeposit) {
    const done = hasTag(tags, workflowTags.depositFulfilledTag);
    if (done) {
      return <DoneBadge>{labels.depositFulfilledDone}</DoneBadge>;
    }
    return (
      <s-button
        variant="primary"
        disabled={busy}
        {...(busyAction === `${id}:deposit_fulfilled` ? { loading: true } : {})}
        onClick={() => onAction(id, "deposit_fulfilled")}
      >
        {labels.depositFulfilled}
      </s-button>
    );
  }

  const pieceMade = hasTag(tags, workflowTags.pieceMadeTag);
  const leaving = hasTag(tags, workflowTags.leavingForCanadaTag);
  const arrived = hasTag(tags, workflowTags.arrivedInCanadaTag);

  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      {pieceMade ? (
        <DoneBadge tone="info">{labels.pieceMade}</DoneBadge>
      ) : (
        <s-button
          variant="primary"
          disabled={busy}
          {...(busyAction === `${id}:piece_made` ? { loading: true } : {})}
          onClick={() => onAction(id, "piece_made")}
        >
          {labels.pieceMade}
        </s-button>
      )}

      {leaving ? (
        <DoneBadge tone="caution">{labels.leavingForCanada}</DoneBadge>
      ) : (
        <s-button
          variant={pieceMade ? "primary" : "tertiary"}
          disabled={!pieceMade || busy}
          {...(busyAction === `${id}:leaving_for_canada`
            ? { loading: true }
            : {})}
          onClick={() => onAction(id, "leaving_for_canada")}
        >
          {labels.leavingForCanada}
        </s-button>
      )}

      {arrived ? (
        <DoneBadge>{labels.arrivedInCanada}</DoneBadge>
      ) : (
        <s-button
          variant={leaving ? "primary" : "tertiary"}
          disabled={!leaving || busy}
          {...(busyAction === `${id}:arrived_in_canada`
            ? { loading: true }
            : {})}
          onClick={() => onAction(id, "arrived_in_canada")}
        >
          {labels.arrivedInCanada}
        </s-button>
      )}
    </s-stack>
  );
}
