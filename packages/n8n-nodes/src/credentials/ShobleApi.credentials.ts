import type {
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class ShobleApi implements ICredentialType {
  name = "shobleApi";
  displayName = "Shoble API";
  documentationUrl = "https://github.com/shoble/shoble";

  properties: INodeProperties[] = [
    {
      displayName: "PocketBase URL",
      name: "pocketbaseUrl",
      type: "string",
      default: "http://pocketbase:8090",
      placeholder: "http://pocketbase:8090",
      description: "Base URL of the PocketBase instance",
    },
    {
      displayName: "Shoble Server URL",
      name: "serverUrl",
      type: "string",
      default: "http://server:3000",
      placeholder: "http://server:3000",
      description: "Base URL of the Shoble Bun server",
    },
  ];
}
