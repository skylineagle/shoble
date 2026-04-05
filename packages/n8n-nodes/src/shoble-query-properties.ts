import type { INodeProperties } from "n8n-workflow";

export const getShobleQueryCoreProperties = (): INodeProperties[] => [
  {
    displayName: "Station",
    name: "stationName",
    type: "resourceLocator",
    default: { __rl: true, mode: "id", value: "" },
    required: true,
    description:
      "Spectrum station (PocketBase stations.name). Plain strings from older workflows still work.",
    modes: [
      {
        displayName: "From List",
        name: "list",
        type: "list",
        typeOptions: {
          searchListMethod: "searchStationsForRl",
          searchable: true,
        },
      },
      {
        displayName: "By Name",
        name: "id",
        type: "string",
        placeholder: "e.g. lab-a",
      },
    ],
  },
  {
    displayName: "Query Mode",
    name: "queryMode",
    type: "options",
    default: "raw",
    options: [
      { name: "Raw String", value: "raw" },
      { name: "Configured Rule", value: "named" },
    ],
    description: "Raw TCP text or a PocketBase station_queries rule executed by the Shoble server",
  },
  {
    displayName: "Query",
    name: "query",
    type: "string",
    default: "",
    required: false,
    description: "TCP command text sent to the instrument",
    typeOptions: { rows: 4 },
    displayOptions: { show: { queryMode: ["raw"] } },
  },
  {
    displayName: "Query Rule",
    name: "namedQueryRule",
    type: "resourceLocator",
    default: { __rl: true, mode: "list", value: "" },
    required: false,
    description: "station_queries.name for this station (load from PocketBase or type name)",
    displayOptions: { show: { queryMode: ["named"] } },
    modes: [
      {
        displayName: "From List",
        name: "list",
        type: "list",
        typeOptions: {
          searchListMethod: "searchStationQueriesForRl",
          searchable: true,
        },
      },
      {
        displayName: "By Name",
        name: "id",
        type: "string",
        placeholder: "e.g. trace_data",
      },
    ],
  },
  {
    displayName: "Rule Name Fallback",
    name: "queryRuleName",
    type: "string",
    default: "",
    required: false,
    description:
      "Optional. Used when Query Rule locator is empty (expressions, or migrating older workflows).",
    displayOptions: { show: { queryMode: ["named"] } },
  },
  {
    displayName: "Parameters Input",
    name: "parametersMode",
    type: "options",
    default: "json",
    options: [
      { name: "JSON", value: "json" },
      { name: "Form (from PocketBase)", value: "fields" },
    ],
    description: "Send parameters as JSON or map them from fields loaded from the rule definition",
    displayOptions: { show: { queryMode: ["named"] } },
  },
  {
    displayName: "Parameters (JSON)",
    name: "parametersJson",
    type: "json",
    default: "{}",
    displayOptions: { show: { queryMode: ["named"], parametersMode: ["json"] } },
  },
  {
    displayName: "Rule Parameters",
    name: "namedParameters",
    type: "resourceMapper",
    default: {
      mappingMode: "defineBelow",
      value: null,
      matchingColumns: [],
      schema: [],
      attemptToConvertTypes: true,
      convertFieldsToString: false,
    },
    displayOptions: { show: { queryMode: ["named"], parametersMode: ["fields"] } },
    typeOptions: {
      loadOptionsDependsOn: ["stationName", "namedQueryRule", "queryRuleName"],
      resourceMapper: {
        resourceMapperMethod: "getQueryParameterFieldsMapping",
        mode: "add",
        fieldWords: { singular: "parameter", plural: "parameters" },
        addAllFields: true,
        multiKeyMatch: false,
      },
    },
  },
];
