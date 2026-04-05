import type {
  GenericValue,
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeParameterResourceLocator,
  INodeProperties,
  INodeType,
  INodeTypeDescription,
  ResourceMapperValue,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import {
  type NamedQueryResponse,
  type QueryDispatchInput,
  type RawQueryResponse,
  type ValidationCheckRow,
  buildShobleRequest,
  getQueryParameterFieldsMapping,
  normalizeBaseUrl,
  resolveErrorBodyMessage,
  resourceLocatorString,
  runValidationChecks,
  searchStationQueriesForRl,
  searchStationsForRl,
} from "../shoble-helpers";
import { getShobleQueryCoreProperties } from "../shoble-query-properties";

const assertionOptions: NonNullable<INodeProperties["options"]> = [
  { name: "Raw contains text", value: "rawContains" },
  { name: "Raw does not contain text", value: "rawNotContains" },
  { name: "Raw matches regex", value: "rawMatchesRegex" },
  { name: "Parsed value is array", value: "valueIsArray" },
  { name: "Parsed value is object", value: "valueIsObject" },
  { name: "Parsed value is number", value: "valueIsNumber" },
  { name: "Parsed value is string", value: "valueIsString" },
  { name: "Array min length", value: "arrayMinLength" },
  { name: "Array max length", value: "arrayMaxLength" },
  { name: "Parsed value JSON equals", value: "valueJsonEquals" },
];

const validationProperties: INodeProperties[] = [
  {
    displayName: "Skip Validation",
    name: "skipValidation",
    type: "boolean",
    default: false,
    description: "If true, all items are sent to the Pass output without running checks",
  },
  {
    displayName: "Validation Checks",
    name: "validationChecks",
    type: "fixedCollection",
    typeOptions: {
      multipleValues: true,
      sortable: true,
    },
    default: { checks: [] },
    placeholder: "Add assertion",
    displayOptions: { show: { skipValidation: [false] } },
    options: [
      {
        displayName: "Check",
        name: "checks",
        values: [
          {
            displayName: "Assertion",
            name: "assertion",
            type: "options",
            default: "rawContains",
            options: assertionOptions,
          },
          {
            displayName: "Text / Regex / JSON",
            name: "operandString",
            type: "string",
            default: "",
            description: "Text, /regex/ pattern string, or JSON for equals comparisons",
          },
          {
            displayName: "Number",
            name: "operandNumber",
            type: "string",
            default: "",
            description: "Whole number for array length assertions",
          },
        ],
      },
    ],
  },
];

export class ExecuteQueryValidate implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Shoble: Execute Query and Validate",
    name: "shobleExecuteQueryValidate",
    group: ["transform"],
    version: 1,
    description:
      "Run a Shoble query then validate the response; route items to Pass or Fail outputs",
    defaults: { name: "Execute Query Validate" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main],
    outputNames: ["pass", "fail"],
    credentials: [{ name: "shobleApi", required: true }],
    properties: [...getShobleQueryCoreProperties(), ...validationProperties],
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
    const passOut: INodeExecutionData[] = [];
    const failOut: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const stationName = resourceLocatorString(
        this.getNodeParameter("stationName", i) as string | INodeParameterResourceLocator
      );
      if (!stationName) {
        throw new NodeOperationError(this.getNode(), "Station is required.", { itemIndex: i });
      }

      const queryMode = ((this.getNodeParameter("queryMode", i) as string) || "raw").trim();
      const skipValidation = this.getNodeParameter("skipValidation", i) === true;

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

      let payload: Record<string, GenericValue | string | unknown>;

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
        payload = {
          station: stationName,
          queryMode: "named",
          queryRuleName: data.queryName,
          command: data.command,
          raw: data.raw,
          value: data.value as GenericValue,
        };
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
        payload = {
          station: stationName,
          queryMode: "raw",
          query,
          response: data.response,
          raw: data.response,
          value: undefined,
        };
      }

      if (skipValidation) {
        passOut.push({
          json: { ...payload, validationPassed: true },
          pairedItem: { item: i },
        });
        continue;
      }

      const coll = this.getNodeParameter("validationChecks", i) as {
        checks?: ValidationCheckRow[];
      };
      const rawLine =
        request.queryMode === "named"
          ? (payload.raw as string)
          : ((payload.response as string) ?? (payload.raw as string) ?? "");
      const valueParsed = request.queryMode === "named" ? payload.value : undefined;

      const rows: ValidationCheckRow[] = (coll?.checks ?? []).map((r) => ({
        assertion: r.assertion,
        operandString: (r.operandString as string) ?? "",
        operandNumber: (r.operandNumber as string) ?? "",
      }));

      const outcome = runValidationChecks(request.queryMode, rawLine, valueParsed, rows);

      const base = {
        ...payload,
        validationChecksRun: rows.length,
      };

      if (outcome.ok) {
        passOut.push({
          json: { ...base, validationPassed: true },
          pairedItem: { item: i },
        });
      } else {
        failOut.push({
          json: {
            ...base,
            validationPassed: false,
            validationErrors: outcome.errors,
          },
          pairedItem: { item: i },
        });
      }
    }

    return [passOut, failOut];
  }
}
