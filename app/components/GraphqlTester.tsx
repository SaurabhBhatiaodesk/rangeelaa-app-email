import { useMemo } from "react";
import { GraphiQL } from "graphiql";
import type { Fetcher } from "@graphiql/toolkit";
import { useAppBridge } from "@shopify/app-bridge-react";
import "graphiql/style.css";
import "./graphql-tester.css";

type GraphqlTesterProps = {
  defaultQuery: string;
};

type GraphqlPayload = {
  data?: unknown;
  errors?: Array<{ message?: string }>;
};

function isIntrospectionQuery(query: string) {
  return (
    query.includes("__schema") ||
    query.includes("__type")
  );
}

export function GraphqlTester({
  defaultQuery,
}: GraphqlTesterProps) {
  const shopify = useAppBridge();

  const fetcher = useMemo<Fetcher>(() => {
    return async (graphQLParams) => {
      const query = graphQLParams.query ?? "";
      const skipToast =
        isIntrospectionQuery(query);

      const headers: HeadersInit = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };

      try {
        const token = await (
          shopify as {
            idToken: () => Promise<string>;
          }
        ).idToken();
        headers.Authorization = `Bearer ${token}`;
      } catch {
        // Session cookie auth still works for same-origin requests.
      }

      try {
        const response = await fetch(
          "/app/api/graphql",
          {
            method: "POST",
            headers,
            credentials: "same-origin",
            body: JSON.stringify({
              query,
              variables: graphQLParams.variables,
            }),
          },
        );

        const payload =
          (await response.json()) as GraphqlPayload;

        if (!skipToast) {
          if (
            !response.ok ||
            payload.errors?.length
          ) {
            shopify.toast.show(
              "GraphQL request failed",
              { isError: true },
            );
          } else {
            shopify.toast.show(
              "Your API access token is working",
            );
          }
        }

        return payload;
      } catch {
        if (!skipToast) {
          shopify.toast.show(
            "Unable to run GraphQL request",
            { isError: true },
          );
        }

        return {
          errors: [
            {
              message:
                "Unable to run GraphQL request",
            },
          ],
        };
      }
    };
  }, [shopify]);

  return (
    <div className="graphql-tester">
      <GraphiQL
        fetcher={fetcher}
        defaultQuery={defaultQuery}
        isHeadersEditorEnabled={false}
        defaultEditorToolsVisibility={false}
      >
        <GraphiQL.Logo>GraphiQL</GraphiQL.Logo>
      </GraphiQL>
    </div>
  );
}
