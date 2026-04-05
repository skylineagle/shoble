import type {
  GenericValue,
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeParameterResourceLocator,
  INodeType,
  INodeTypeDescription,
  ResourceMapperValue,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import {
  type NamedQueryResponse,
  type QueryDispatchInput,
  type RawQueryResponse,
  buildShobleRequest,
  getQueryParameterFieldsMapping,
  normalizeBaseUrl,
  resolveErrorBodyMessage,
  resourceLocatorString,
  searchStationQueriesForRl,
  searchStationsForRl,
} from "../shoble-helpers";
import { getShobleQueryCoreProperties } from "../shoble-query-properties";

export class ExecuteQuery implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Shoble: Execute Query",
    name: "shobleExecuteQuery",
    group: ["transform"],
    version: 3,
    description:
      "Send a TCP query via the Shoble server (raw SCPI or PocketBase station_queries with dynamic parameters)",
    defaults: { name: "Execute Query" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "shobleApi", required: true }],
    properties: [...getShobleQueryCoreProperties()],
  };

  methods = {
    listSearch: {
      searchStationsForRl,
      searchStationQueriesForRl,
    },
    resourceMapping: {
      getQueryParameterFieldsMapping,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials("shobleApi");
    const serverUrl = normalizeBaseUrl(credentials.serverUrl as string);
    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const stationName = resourceLocatorString(
        this.getNodeParameter("stationName", i) as string | INodeParameterResourceLocator
      );
      if (!stationName) {
        throw new NodeOperationError(this.getNode(), "Station is required.", { itemIndex: i });
      }

      const queryMode = ((this.getNodeParameter("queryMode", i) as string) || "raw").trim();

      let request: ReturnType<typeof buildShobleRequest>;
      try {
        const input: QueryDispatchInput = {
          queryMode,
          stationName,
          namedQueryRule: this.getNodeParameter("namedQueryRule", i) as
            | INodeParameterResourceLocator
            | undefined,
          queryRuleNameLegacy: (this.getNodeParameter("queryRuleName", i) as string) ?? "",
          query: (this.getNodeParameter("query", i) as string) ?? "",
          parametersMode: (this.getNodeParameter("parametersMode", i) as string) || "json",
          parametersJson: this.getNodeParameter("parametersJson", i) as IDataObject,
          namedParameters: this.getNodeParameter("namedParameters", i) as ResourceMapperValue,
        };
        request = buildShobleRequest(serverUrl, input);
      } catch (err) {
        throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
      }

      const res = await this.helpers.httpRequest({
        method: "POST",
        url: request.url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
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

      if (request.queryMode === "named") {
        const data = rawBody as NamedQueryResponse;
        if (
          !data ||
          typeof data !== "object" ||
          typeof data.command !== "string" ||
          typeof data.raw !== "string"
        ) {
          throw new NodeOperationError(
            this.getNode(),
            "Unexpected response shape from Shoble named query API",
            { itemIndex: i }
          );
        }
        results.push({
          json: {
            station: stationName,
            queryMode: "named",
            queryRuleName: data.queryName,
            command: data.command,
            raw: data.raw,
            value: data.value as GenericValue,
          },
        });
      } else {
        const data = rawBody as RawQueryResponse;
        if (!data || typeof data !== "object" || typeof data.response !== "string") {
          throw new NodeOperationError(
            this.getNode(),
            "Unexpected response shape from Shoble API",
            {
              itemIndex: i,
            }
          );
        }
        const query = (this.getNodeParameter("query", i) as string) ?? "";
        results.push({
          json: {
            station: stationName,
            queryMode: "raw",
            query,
            response: data.response,
          },
        });
      }
    }

    return [results];
  }
}
