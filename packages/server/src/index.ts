import { swagger } from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import { getStationByName } from "./pocketbase";
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
  .listen(PORT);

console.log(`Shoble server running on http://localhost:${PORT}`);

export type App = typeof app;
