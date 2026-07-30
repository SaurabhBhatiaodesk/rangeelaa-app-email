export type ShippingMenuStep =
  | "preorders"
  | "emails"
  | "thursday"
  | "alerts"
  | "friday"
  | "settings";

const MENU_ITEMS: Array<{
  id: ShippingMenuStep;
  number: string;
  label: string;
  href: string;
}> = [
  {
    id: "preorders",
    number: "01",
    label: "Preorders — Awaiting Readiness",
    href: "/app",
  },
  {
    id: "emails",
    number: "02",
    label: "Status emails (Klaviyo)",
    href: "/app?tab=emails",
  },
  {
    id: "thursday",
    number: "03",
    label: "Thursday invoice",
    href: "/app?tab=thursday",
  },
  {
    id: "alerts",
    number: "04",
    label: "After shipping paid",
    href: "/app?tab=alerts",
  },
  {
    id: "friday",
    number: "05",
    label: "Friday reset",
    href: "/app?tab=friday",
  },
  {
    id: "settings",
    number: "06",
    label: "Settings",
    href: "/app/settings",
  },
];

export function ShippingManagerMenu({
  active,
}: {
  active: ShippingMenuStep;
}) {
  return (
    <s-section heading="Menu" padding="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        {MENU_ITEMS.map((item) => (
          <s-button
            key={item.id}
            href={item.href}
            variant={active === item.id ? "primary" : "secondary"}
            accessibilityLabel={`${item.number}. ${item.label}${
              active === item.id ? " (selected)" : ""
            }`}
          >
            {item.number}. {item.label}
          </s-button>
        ))}
      </s-stack>
    </s-section>
  );
}
