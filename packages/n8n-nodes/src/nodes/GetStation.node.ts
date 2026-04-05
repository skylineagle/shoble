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

export class GetStation implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Shoble: Get Station",
    name: "shobleGetStation",
    group: ["transform"],
    version: 1,
    description:
      "Retrieve a station by name from PocketBase, including its system and spectrum details",
    defaults: { name: "Get Station" },
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
        description: "The name of the station to look up",
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials("shobleApi");
    const pb = new PocketBase(credentials.pocketbaseUrl as string);
    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const stationName = this.getNodeParameter("stationName", i) as string;

      const station = await pb
        .collection("stations")
        .getFirstListItem<Station>(pb.filter("name = {:name}", { name: stationName }), {
          expand: "system,spectrum",
        });

      results.push({
        json: {
          id: station.id,
          name: station.name,
          system: station.expand.system,
          spectrum: station.expand.spectrum,
        },
      });
    }

    return [results];
  }
}
