import { swagger } from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import { getStationByName, getStationQueryRule } from "./pocketbase";
import {
  type ParamDef,
  buildCommand,
  normalizeParamDefs,
  parseResponseSchema,
  parseTcpResponse,
} from "./query-engine";
import { requestLogger } from "./request-logger";
import { tcpQuery } from "./tcp";

const PORT = Number(process.env.SERVER_PORT ?? 3000);

const app = new Elysia()
  .use(requestLogger())
  .use(
    swagger({
      documentation: {
        info: { title: "Shoble API", version: "0.1.0" },
      },
    })
  )
  .post(
    "/query/:station",
    async ({ params, body }) => {
      const station = await getStationByName(params.station).catch((err: Error) => {
        throw new Error(`Station not found: ${err.message}`);
      });

      const { host, port } = station.expand.spectrum;

      const response = await tcpQuery(host, port, body.query).catch((err: Error) => {
        throw new Error(`TCP error: ${err.message}`);
      });

      return { response };
    },
    {
      params: t.Object({ station: t.String({ minLength: 1 }) }),
      body: t.Object({ query: t.String({ minLength: 1 }) }),
      response: {
        200: t.Object({ response: t.String() }),
        404: t.Object({ message: t.String() }),
        502: t.Object({ message: t.String() }),
      },
      detail: {
        summary: "Execute a TCP query via a named station",
        tags: ["Query"],
      },
    }
  )
  .post(
    "/query/:station/named/:queryName",
    async ({ params, body }) => {
      const station = await getStationByName(params.station).catch((err: Error) => {
        throw new Error(`Station not found: ${err.message}`);
      });

      const rule = await getStationQueryRule(station.id, params.queryName).catch((err: Error) => {
        throw new Error(`Query rule not found: ${err.message}`);
      });

      let defs: ParamDef[];
      try {
        defs = normalizeParamDefs(rule.parameter_defs);
      } catch (err) {
        throw new Error(`Invalid parameter_defs: ${(err as Error).message}`);
      }

      let built: string;
      try {
        built = buildCommand(rule.command_template, defs, body.parameters);
      } catch (err) {
        throw new Error(`Parameter error: ${(err as Error).message}`);
      }

      const { host, port } = station.expand.spectrum;
      const raw = await tcpQuery(host, port, built).catch((err: Error) => {
        throw new Error(`TCP error: ${err.message}`);
      });

      let schema: ReturnType<typeof parseResponseSchema>;
      try {
        schema = parseResponseSchema(rule.response_schema);
      } catch (err) {
        throw new Error(`Invalid response_schema: ${(err as Error).message}`);
      }
      const value = parseTcpResponse(raw, schema);

      return { queryName: params.queryName, command: built, raw, value };
    },
    {
      params: t.Object({
        station: t.String({ minLength: 1 }),
        queryName: t.String({ minLength: 1 }),
      }),
      body: t.Object({
        parameters: t.Optional(t.Record(t.String(), t.Any())),
      }),
      response: {
        200: t.Object({
          queryName: t.String(),
          command: t.String(),
          raw: t.String(),
          value: t.Any(),
        }),
      },
      detail: {
        summary: "Run a configured station query (PocketBase station_queries)",
        tags: ["Query"],
      },
    }
  )
  .listen(PORT);

console.log(`Shoble server running on http://localhost:${PORT}`);

export type App = typeof app;
