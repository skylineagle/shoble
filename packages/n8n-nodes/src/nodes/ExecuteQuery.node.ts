import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
interface QueryResponse {
  response: string;
}

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
    const serverUrl = credentials.serverUrl as string;
    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const stationName = this.getNodeParameter("stationName", i) as string;
      const query = this.getNodeParameter("query", i) as string;

      const url = `${serverUrl}/query/${encodeURIComponent(stationName)}`;
      const response = await this.helpers.httpRequest({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      const data = response as QueryResponse;
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
