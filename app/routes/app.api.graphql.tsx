import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  let body: {
    query?: string;
    variables?: Record<string, unknown> | null;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      {
        errors: [
          {
            message: "Request body must be valid JSON.",
          },
        ],
      },
      { status: 400 },
    );
  }

  const query = body.query?.trim();

  if (!query) {
    return Response.json(
      {
        errors: [
          {
            message: "GraphQL query is required.",
          },
        ],
      },
      { status: 400 },
    );
  }

  try {
    const response = await admin.graphql(
      query,
      body.variables
        ? { variables: body.variables }
        : undefined,
    );

    return Response.json(await response.json());
  } catch (error) {
    return Response.json(
      {
        errors: [
          {
            message:
              error instanceof Error
                ? error.message
                : "GraphQL request failed.",
          },
        ],
      },
      { status: 500 },
    );
  }
}
