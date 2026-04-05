import PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";

const pb = new PocketBase(process.env.POCKETBASE_URL ?? "http://localhost:8090");

export interface System extends RecordModel {
  name: string;
}

export interface Spectrum extends RecordModel {
  name: string;
  host: string;
  port: number;
}

export interface Station extends RecordModel {
  name: string;
  expand: {
    system: System;
    spectrum: Spectrum;
  };
}

export async function getStationByName(name: string): Promise<Station> {
  return pb.collection("stations").getFirstListItem<Station>(
    pb.filter("name = {:name}", { name }),
    { expand: "system,spectrum" }
  );
}
