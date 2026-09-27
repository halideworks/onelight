import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import type { RouteDoc } from "../schemas.js";
import { routeDocs, errorEnvelope } from "../schemas.js";
import type { AppEnv, ApiRouter } from "../types.js";

export const registerOpenapiRoutes = (
  api: ApiRouter,
  root: ApiRouter,
  env: AppEnv,
) => {
  // The OpenAPI document is generated from the routes registered on the Hono
  // app (the REST API is a public contract; a hand-maintained map drifts).
  // Request and response schemas come from the shared registry in schemas.ts,
  // whose request entries are the SAME zod objects the routes validate with,
  // so the document and the validators cannot drift. Built lazily at first
  // request so every route is registered.
  const openApiMethods = new Set(["get", "post", "put", "patch", "delete"]);

  const toOpenApiPath = (path: string): string =>
    path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*/g, "{path}");

  const jsonSchemaFor = (
    schema: Parameters<typeof zodToJsonSchema>[0],
  ): Record<string, unknown> => {
    const converted = zodToJsonSchema(schema, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    delete converted.$schema;
    return converted;
  };

  const errorRef = (description: string) => ({
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  });

  const binaryBody = (contentType: string) => ({
    content:
      contentType === "multipart/form-data"
        ? {
            [contentType]: {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
                required: ["file"],
              },
            },
          }
        : { [contentType]: { schema: { type: "string", format: "binary" } } },
  });

  const operationFor = (
    routePath: string,
    method: string,
    doc: RouteDoc | undefined,
  ): Record<string, unknown> => {
    const parameters: Array<Record<string, unknown>> = [];
    for (const match of routePath.matchAll(/:([A-Za-z0-9_]+)/g))
      parameters.push({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    if (routePath.includes("*"))
      parameters.push({
        name: "path",
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    for (const [name, query] of Object.entries(doc?.query ?? {}))
      parameters.push({
        name,
        in: "query",
        required: Boolean(query.required),
        description: query.description,
        schema: { type: "string" },
      });
    const responses: Record<string, unknown> = {};
    if (doc) {
      for (const [status, response] of Object.entries(doc.responses)) {
        responses[status] = {
          description: response.description,
          ...(response.schema
            ? {
                content: {
                  "application/json": {
                    schema: jsonSchemaFor(response.schema),
                  },
                },
              }
            : response.contentType
              ? binaryBody(response.contentType)
              : {}),
        };
      }
    } else {
      responses[
        method === "post" ? "201" : method === "delete" ? "204" : "200"
      ] = { description: `${method.toUpperCase()} ${routePath}` };
    }
    responses["400"] = errorRef("Validation failure");
    responses["401"] = errorRef("Authentication required");
    responses["403"] = errorRef("Forbidden");
    responses["404"] = errorRef("Not found");
    return {
      ...(doc?.summary ? { summary: doc.summary } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(doc?.request
        ? {
            requestBody: {
              required: !doc.request.isOptional(),
              content: {
                "application/json": {
                  /* Optionality describes the HTTP body, not a JSON value.
                     JSON has no undefined; converting the wrapper would add
                     an unconstrained union branch to the generated client. */
                  schema: jsonSchemaFor(
                    doc.request instanceof z.ZodOptional
                      ? doc.request.unwrap()
                      : doc.request,
                  ),
                },
              },
            },
          }
        : doc?.requestContentType
          ? {
              requestBody: {
                required: true,
                ...binaryBody(doc.requestContentType),
              },
            }
          : {}),
      responses,
    };
  };

  let openApiDocumentCache: Record<string, unknown> | undefined;

  const buildOpenApiDocument = (): Record<string, unknown> => {
    const paths: Record<string, Record<string, unknown>> = {};
    // Documentation order must not depend on which domain registers first.
    const routes = [...api.routes].sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
    for (const route of routes) {
      const method = route.method.toLowerCase();
      if (!openApiMethods.has(method)) continue;
      if (route.path === "/openapi.json" || route.path === "/docs") continue;
      const path = toOpenApiPath(`/api/v1${route.path}`);
      const entry = (paths[path] ??= {});
      if (entry[method]) continue;
      entry[method] = operationFor(
        route.path,
        method,
        routeDocs[`${route.method} ${route.path}`],
      );
    }
    return {
      openapi: "3.1.0",
      info: { title: "Onelight API", version: env.version },
      components: { schemas: { Error: jsonSchemaFor(errorEnvelope) } },
      paths,
    };
  };

  api.get("/openapi.json", (c) => {
    openApiDocumentCache ??= buildOpenApiDocument();
    return c.json(openApiDocumentCache);
  });

  const docsHtml =
    '<!doctype html><html><head><title>Onelight API</title></head><body><h1>Onelight API</h1><p>OpenAPI document: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p></body></html>';

  api.get("/docs", (c) => c.html(docsHtml));
  root.get("/api/docs", (c) => c.html(docsHtml));
};
