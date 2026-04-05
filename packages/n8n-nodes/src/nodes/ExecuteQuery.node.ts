import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";
interface QueryResponse {
  response: string;
}

const normalizeBaseUrl = (url: string): string => url.replace(/\/$/, "");

const resolveErrorBodyMessage = (body: unknown): string => {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") {
    const t = body.trim();
    if (!t) return "";
    try {
      const parsed = JSON.parse(t) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "message" in parsed &&
        typeof (parsed as { message: unknown }).message === "string"
      ) {
        return (parsed as { message: string }).message;
      }
    } catch {
      return t;
    }
    return t;
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    return body.toString("utf8").trim();
  }
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
};

export class ExecuteQuery implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Shoble: Execute Query",
    name: "shobleExecuteQuery",
    group: ["transform"],
    version: 1,
    description:
      "Send a TCP query to a spectrum analyzer via the Shoble server using a named station",
    defaults: { name: "Execute Query" },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "shobleApi", required: true }],
    properties: [
      {
        displayName: "Station Name",
        name: "stationName",
        type: "string",
        default: "",
        required: true,
        description: "Name of the station whose spectrum to query",
      },
      {
        displayName: "Query",
        name: "query",
        type: "string",
        default: "",
        required: true,
        description: "TCP query string to send to the spectrum analyzer",
        typeOptions: { rows: 3 },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials("shobleApi");
    const serverUrl = normalizeBaseUrl(credentials.serverUrl as string);
    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const stationName = this.getNodeParameter("stationName", i) as string;
      const query = this.getNodeParameter("query", i) as string;

      const url = `${serverUrl}/query/${encodeURIComponent(stationName)}`;
      const res = await this.helpers.httpRequest({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
      });

      const statusCode = res.statusCode as number;
      const rawBody = res.body as unknown;

      if (statusCode >= 400) {
        const detail = resolveErrorBodyMessage(rawBody) || `HTTP ${statusCode}`;
        throw new NodeOperationError(this.getNode(), detail, {
          itemIndex: i,
          description: `Shoble server responded with status ${statusCode}.`,
        });
      }

      const data = rawBody as QueryResponse;
      if (!data || typeof data !== "object" || typeof data.response !== "string") {
        throw new NodeOperationError(this.getNode(), "Unexpected response shape from Shoble API", {
          itemIndex: i,
        });
      }

      results.push({
        json: {
          station: stationName,
          query,
          response: data.response,
        },
      });
    }

    return [results];
  }
}
