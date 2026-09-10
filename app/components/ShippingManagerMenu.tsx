export type ShippingMenuStep =
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
    id: "emails",
    number: "01",
    label: "Status emails (Klaviyo)",
    href: "/app",
  },
  {
    id: "thursday",
    number: "02",
    label: "Thursday invoice",
    href: "/app?tab=thursday",
  },
  {
    id: "alerts",
    number: "03",
    label: "After shipping paid",
    href: "/app?tab=alerts",
  },
  {
    id: "friday",
    number: "04",
    label: "Friday reset",
    href: "/app?tab=friday",
  },
  {
    id: "settings",
    number: "05",
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
