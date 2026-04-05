import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";

interface System extends RecordModel {
  name: string;
}

interface Spectrum extends RecordModel {
  name: string;
  host: string;
  port: number;
}

interface Station extends RecordModel {
  name: string;
  expand: {
    system: System;
    spectrum: Spectrum;
  };
}

export class ListStations implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Shoble: List Stations",
    name: "shobleListStations",
    group: ["transform"],
    version: 1,
    description: "List all stations from PocketBase with their system and spectrum details",
    defaults: { name: "List Stations" },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "shobleApi", required: true }],
    properties: [
      {
        displayName: "System Filter",
        name: "systemName",
        type: "string",
        default: "",
        required: false,
        description: "Filter stations by system name (leave empty for all)",
      },
      {
        displayName: "Page Size",
        name: "pageSize",
        type: "number",
        default: 100,
        required: false,
        description: "Number of stations to return per page",
        typeOptions: { minValue: 1, maxValue: 500 },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const credentials = await this.getCredentials("shobleApi");
    const pb = new PocketBase(credentials.pocketbaseUrl as string);
    const systemName = this.getNodeParameter("systemName", 0) as string;
    const pageSize = this.getNodeParameter("pageSize", 0) as number;

    const filter = systemName
      ? pb.filter("system.name = {:systemName}", { systemName })
      : "";

    const result = await pb.collection("stations").getList<Station>(1, pageSize, {
      expand: "system,spectrum",
      filter,
    });

    const results: INodeExecutionData[] = result.items.map((station) => ({
      json: {
        id: station.id,
        name: station.name,
        system: station.expand.system,
        spectrum: station.expand.spectrum,
      },
    }));

    return [results];
  }
}
