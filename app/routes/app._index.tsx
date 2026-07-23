import { useState } from "react";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useLoaderData,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { GraphqlTesterLazy } from "../components/GraphqlTesterLazy";
import { authenticate } from "../shopify.server";

type ShopQueryResponse = {
  data?: {
    shop?: {
      name?: string;
      myshopifyDomain?: string;
    };
  };
  errors?: Array<{
    message?: string;
  }>;
};

const DEFAULT_GRAPHQL_QUERY = `query GetShop {
  shop {
    name
    myshopifyDomain
  }
}`;

const GRAPHQL_MODAL_ID = "graphql-tester-modal";

export async function loader({
  request,
}: LoaderFunctionArgs) {
  const { admin, session } =
    await authenticate.admin(request);

  if (!session.accessToken) {
    throw new Response(
      "Shopify access token not found.",
      {
        status: 401,
      },
    );
  }

  if (session.isOnline) {
    throw Response.json(
      {
        success: false,
        message:
          "Online token received. Set useOnlineTokens to false and reinstall the app.",
        tokenType: "online",
        isOnline: true,
        expires:
          session.expires?.toISOString() ?? null,
      },
      {
        status: 400,
      },
    );
  }

  /*
   * This query verifies that Shopify accepts
   * the saved token for the connected store.
   */
  const response = await admin.graphql(
    `#graphql
      query GetShop {
        shop {
          name
          myshopifyDomain
        }
      }
    `,
  );

  const responseJson =
    (await response.json()) as ShopQueryResponse;

  const shop = responseJson.data?.shop;

  if (responseJson.errors?.length || !shop) {
    throw Response.json(
      {
        success: false,
        message:
          "Shopify rejected the token or the store could not be verified.",
        errors: responseJson.errors ?? [],
      },
      {
        status: 401,
      },
    );
  }

  const isPermanent =
    session.isOnline === false &&
    !session.expires;

  /*
   * Development: token visible by default.
   * Production: set ALLOW_TOKEN_DISPLAY=true
   * only when the token genuinely needs to be copied.
   */
  const canRevealToken =
    process.env.NODE_ENV !== "production" ||
    process.env.ALLOW_TOKEN_DISPLAY === "true";

  const tokenPreview =
    session.accessToken.length > 12
      ? `${session.accessToken.slice(0, 8)}${"•".repeat(
          20,
        )}${session.accessToken.slice(-4)}`
      : "••••••••••••";

  return {
    success: true,
    verifiedByShopify: true,
    verifiedAt: new Date().toISOString(),

    shopName:
      shop.name ?? "Unknown store",

    shopDomain:
      shop.myshopifyDomain ?? session.shop,

    accessToken: canRevealToken
      ? session.accessToken
      : null,

    tokenPreview,
    canRevealToken,

    scopes: session.scope
      ? session.scope
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [],

    tokenType: "offline",
    isOnline: session.isOnline,

    expires:
      session.expires?.toISOString() ?? null,

    isPermanent,

    message: isPermanent
      ? "A real non-expiring offline Shopify access token is active."
      : "The offline access token has an expiration time.",
  };
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const [showToken, setShowToken] =
    useState(false);

  const [isCopying, setIsCopying] =
    useState(false);

  const isVerifying =
    revalidator.state === "loading";

  const handleCopyToken = async () => {
    if (!data.accessToken) {
      shopify.toast.show(
        "Token display is disabled",
        {
          isError: true,
        },
      );

      return;
    }

    try {
      setIsCopying(true);

      await copyToClipboard(
        data.accessToken,
      );

      shopify.toast.show(
        "Access token copied successfully",
      );
    } catch (error) {
      console.error(
        "Unable to copy token:",
        error,
      );

      shopify.toast.show(
        "Unable to copy access token",
        {
          isError: true,
        },
      );
    } finally {
      setIsCopying(false);
    }
  };

  const handleVerifyAgain = () => {
    revalidator.revalidate();
  };

  return (
    <s-page
      heading="Permanent Access Token"
    >
      <s-button
        slot="primary-action"
        onClick={handleVerifyAgain}
        {...(isVerifying
          ? { loading: true }
          : {})}
      >
        Verify again
      </s-button>

      <s-badge
        slot="accessory"
        tone="success"
      >
        Verified
      </s-badge>

      <s-section heading="Admin API access token">
        {data.canRevealToken &&
        data.accessToken ? (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-banner
              heading="Sensitive credential"
              tone="warning"
            >
              <s-paragraph>
                Reveal or copy this token only when
                necessary. Do not include it in
                screenshots, logs or frontend code.
              </s-paragraph>
            </s-banner>

            <s-text-field
              label="Access token"
              value={
                showToken
                  ? data.accessToken
                  : data.tokenPreview
              }
              readOnly
            />

            <s-stack
              direction="inline"
              gap="small"
              alignItems="start"
            >
              <s-button
                onClick={() =>
                  setShowToken(
                    (currentValue) =>
                      !currentValue,
                  )
                }
              >
                {showToken
                  ? "Hide token"
                  : "Show token"}
              </s-button>

              <s-button
                variant="primary"
                onClick={handleCopyToken}
                disabled={isCopying}
                {...(isCopying
                  ? { loading: true }
                  : {})}
              >
                Copy token
              </s-button>

              <s-button
                commandFor={GRAPHQL_MODAL_ID}
                command="--show"
              >
                Open GraphiQL
              </s-button>
            </s-stack>
          </s-stack>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-banner
              heading="Access token protected"
              tone="info"
            >
              <s-paragraph>
                The token is stored in server-side
                Prisma session storage and is not
                being sent to the browser.
              </s-paragraph>

              <s-paragraph>
                Temporarily set
                ALLOW_TOKEN_DISPLAY=true on the
                server only when an authorized person
                needs to copy it.
              </s-paragraph>
            </s-banner>

            <s-stack
              direction="inline"
              gap="small"
              alignItems="start"
            >
              <s-button
                commandFor={GRAPHQL_MODAL_ID}
                command="--show"
              >
                Open GraphiQL
              </s-button>
            </s-stack>
          </s-stack>
        )}

        <s-modal
          id={GRAPHQL_MODAL_ID}
          heading="GraphQL API tester"
          size="large-100"
          accessibilityLabel="Run Admin GraphQL query"
        >
          <s-stack
            direction="block"
            gap="base"
          >
            <s-banner
              heading="Your API access token is working"
              tone="success"
            >
              <s-paragraph>
                This GraphQL tester is connected with
                your store using the saved offline
                Admin API access token.
              </s-paragraph>
            </s-banner>

            <GraphqlTesterLazy
              defaultQuery={DEFAULT_GRAPHQL_QUERY}
            />
          </s-stack>

          <s-button
            slot="secondary-actions"
            variant="secondary"
            commandFor={GRAPHQL_MODAL_ID}
            command="--hide"
          >
            Close
          </s-button>
        </s-modal>
      </s-section>

      <s-section>
        <s-banner
          heading="Connection verified by Shopify"
          tone="success"
        >
          <s-paragraph>
            Shopify successfully accepted the
            Admin API token for{" "}
            {data.shopDomain}.
          </s-paragraph>

          <s-paragraph>
            {data.message}
          </s-paragraph>
        </s-banner>
      </s-section>

      <s-section heading="Store overview">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(210px, 1fr))"
          gap="base"
        >
          <InformationCard
            label="Store name"
            value={data.shopName}
          />

          <InformationCard
            label="Store domain"
            value={data.shopDomain}
          />

          <InformationCard
            label="Authentication"
            value="Offline access"
          />

          <InformationCard
            label="Expiration"
            value={
              data.expires
                ? new Date(
                    data.expires,
                  ).toLocaleString()
                : "No expiration"
            }
          />
        </s-grid>
      </s-section>

      <s-section heading="Connection health">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(210px, 1fr))"
          gap="base"
        >
          <StatusCard
            label="Shopify verification"
            value="Verified"
            tone="success"
            description="The Admin API request completed successfully."
          />

          <StatusCard
            label="Authentication mode"
            value="Offline"
            tone="info"
            description="Suitable for background and server-side tasks."
          />

          <StatusCard
            label="Online session"
            value={
              data.isOnline ? "Yes" : "No"
            }
            tone={
              data.isOnline
                ? "critical"
                : "success"
            }
            description={
              data.isOnline
                ? "This token is tied to a user session."
                : "This token is not tied to a staff session."
            }
          />

          <StatusCard
            label="Token lifetime"
            value={
              data.isPermanent
                ? "Non-expiring"
                : "Expiring"
            }
            tone={
              data.isPermanent
                ? "success"
                : "warning"
            }
            description={
              data.isPermanent
                ? "No time-based expiration is configured."
                : "Shopify has assigned an expiration time."
            }
          />
        </s-grid>
      </s-section>

      <s-section heading="Granted API permissions">
        {data.scopes.length > 0 ? (
          <s-stack
            direction="inline"
            gap="small"
            alignItems="start"
          >
            {data.scopes.map((scope) => (
              <s-badge
                key={scope}
                tone="info"
              >
                {formatScope(scope)}
              </s-badge>
            ))}
          </s-stack>
        ) : (
          <s-banner
            heading="No permissions found"
            tone="warning"
          >
            <s-paragraph>
              No Admin API scopes were found in
              the current Shopify session.
            </s-paragraph>
          </s-banner>
        )}
      </s-section>

      <s-section heading="Verification details">
        <s-box
          padding="base"
          border="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack
            direction="block"
            gap="small"
          >
            <s-text>
              Last verified
            </s-text>

            <s-heading>
              {new Date(
                data.verifiedAt,
              ).toLocaleString()}
            </s-heading>

            <s-text>
              Verification was completed using
              Shopify Admin GraphQL.
            </s-text>
          </s-stack>
        </s-box>
      </s-section>

      <s-section>
        <s-banner
          heading="Production security"
          tone="warning"
        >
          <s-paragraph>
            Keep Shopify sessions in persistent
            PostgreSQL storage. Never expose the
            full token through a public route,
            client-side JavaScript, GitHub,
            screenshots or application logs.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

function InformationCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <s-box
      padding="base"
      border="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack
        direction="block"
        gap="small"
      >
        <s-text>{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

function StatusCard({
  label,
  value,
  tone,
  description,
}: {
  label: string;
  value: string;
  tone:
    | "success"
    | "warning"
    | "critical"
    | "info";
  description: string;
}) {
  return (
    <s-box
      padding="base"
      border="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack
        direction="block"
        gap="small"
      >
        <s-text>{label}</s-text>

        <s-badge tone={tone}>
          {value}
        </s-badge>

        <s-paragraph>
          {description}
        </s-paragraph>
      </s-stack>
    </s-box>
  );
}

function formatScope(scope: string) {
  return scope
    .replace(/^read_/, "Read: ")
    .replace(/^write_/, "Write: ")
    .replaceAll("_", " ");
}

async function copyToClipboard(
  value: string,
) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(
      value,
    );

    return;
  }

  const textarea =
    document.createElement("textarea");

  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.select();

  const copied =
    document.execCommand("copy");

  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error(
      "Clipboard copy failed",
    );
  }
}

export const headers: HeadersFunction = (
  headersArgs,
) => {
  const headers = new Headers(
    boundary.headers(headersArgs),
  );

  headers.set(
    "Cache-Control",
    "private, no-store, max-age=0",
  );

  headers.set("Pragma", "no-cache");
  headers.set(
    "Referrer-Policy",
    "no-referrer",
  );

  return headers;
};
