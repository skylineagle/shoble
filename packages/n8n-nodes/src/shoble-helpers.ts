import type {
  IDataObject,
  ILoadOptionsFunctions,
  INodeListSearchResult,
  INodeParameterResourceLocator,
  ResourceMapperField,
  ResourceMapperValue,
} from "n8n-workflow";
import PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";

export type ShobleCredentials = {
  pocketbaseUrl: string;
  serverUrl: string;
};

export const normalizeBaseUrl = (url: string): string => url.replace(/\/$/, "");

export const getPocketBase = (credentials: ShobleCredentials): PocketBase =>
  new PocketBase(normalizeBaseUrl(credentials.pocketbaseUrl));

export const resourceLocatorString = (
  input: string | INodeParameterResourceLocator | undefined | null
): string => {
  if (input == null) return "";
  if (typeof input === "string") return input.trim();
  if (typeof input === "object" && "__rl" in input) {
    const v = (input as INodeParameterResourceLocator).value;
    if (v == null) return "";
    return String(v).trim();
  }
  if (typeof input === "object" && "value" in input)
    return String((input as { value: unknown }).value ?? "").trim();
  return String(input).trim();
};

interface Station extends RecordModel {
  name: string;
}

interface StationQueryRecord extends RecordModel {
  name: string;
  station: string;
  parameter_defs: unknown;
}

type ParamDefLite = {
  name: string;
  type: "string" | "number" | "integer";
  required?: boolean;
};

export const normalizeParamDefsLite = (raw: unknown): ParamDefLite[] => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("parameter_defs must be a JSON array");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`parameter_defs[${i}] must be an object`);
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name)
      throw new Error(`parameter_defs[${i}].name required`);
    if (o.type !== "string" && o.type !== "number" && o.type !== "integer")
      throw new Error(`parameter_defs[${i}].type must be string, number, or integer`);
    const d: ParamDefLite = { name: o.name, type: o.type };
    if (o.required === false) d.required = false;
    return d;
  });
};

export const resourceMapperToParameters = (
  mapper: ResourceMapperValue | undefined
): Record<string, unknown> => {
  if (!mapper?.value || typeof mapper.value !== "object" || Array.isArray(mapper.value)) return {};
  return { ...mapper.value } as Record<string, unknown>;
};

export interface RawQueryResponse {
  response: string;
}

export interface NamedQueryResponse {
  queryName: string;
  command: string;
  raw: string;
  value: unknown;
}

export const resolveErrorBodyMessage = (body: unknown): string => {
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

export type QueryDispatchInput = {
  queryMode: string;
  stationName: string;
  namedQueryRule: string | INodeParameterResourceLocator | undefined;
  queryRuleNameLegacy: string;
  query: string;
  parametersMode: string;
  parametersJson?: IDataObject;
  namedParameters?: ResourceMapperValue;
};

export const resolveNamedRuleTitle = (input: QueryDispatchInput): string => {
  const fromRl = resourceLocatorString(
    input.namedQueryRule as string | INodeParameterResourceLocator | undefined
  );
  if (fromRl) return fromRl;
  return (input.queryRuleNameLegacy ?? "").trim();
};

export const buildParametersPayload = (input: QueryDispatchInput): IDataObject => {
  if ((input.parametersMode || "json") === "fields") {
    return resourceMapperToParameters(input.namedParameters) as IDataObject;
  }
  const raw = input.parametersJson;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  return {};
};

export const buildShobleRequest = (
  serverUrl: string,
  input: QueryDispatchInput
): { queryMode: string; url: string; body: IDataObject } => {
  const base = normalizeBaseUrl(serverUrl);
  const stationEnc = encodeURIComponent(input.stationName.trim());
  const mode = (input.queryMode || "raw").trim();

  if (mode === "named") {
    const ruleTitle = resolveNamedRuleTitle(input);
    if (!ruleTitle) throw new Error("Select a query rule or enter a rule name.");
    const url = `${base}/query/${stationEnc}/named/${encodeURIComponent(ruleTitle)}`;
    const parameters = buildParametersPayload(input);
    return { queryMode: "named", url, body: { parameters } };
  }

  const query = input.query ?? "";
  if (!query.trim()) throw new Error("Query text is required for raw mode.");
  const url = `${base}/query/${stationEnc}`;
  return { queryMode: "raw", url, body: { query } };
};

export async function searchStationsForRl(
  this: ILoadOptionsFunctions,
  filter?: string
): Promise<INodeListSearchResult> {
  let credentials: ShobleCredentials;
  try {
    credentials = (await this.getCredentials("shobleApi")) as unknown as ShobleCredentials;
  } catch {
    return { results: [] };
  }
  const pb = getPocketBase(credentials);
  const q = (filter ?? "").trim();
  const listFilter = q ? pb.filter("name ~ {:q}", { q }) : "";
  const result = await pb.collection("stations").getList<Station>(1, 50, { filter: listFilter });
  return {
    results: result.items.map((s) => ({ name: s.name, value: s.name })),
  };
}

export async function searchStationQueriesForRl(
  this: ILoadOptionsFunctions,
  filter?: string
): Promise<INodeListSearchResult> {
  let credentials: ShobleCredentials;
  try {
    credentials = (await this.getCredentials("shobleApi")) as unknown as ShobleCredentials;
  } catch {
    return { results: [] };
  }
  const pb = getPocketBase(credentials);
  const stationName = resourceLocatorString(
    this.getCurrentNodeParameter("stationName") as string | INodeParameterResourceLocator
  );
  if (!stationName) return { results: [] };
  let station: Station;
  try {
    station = await pb
      .collection("stations")
      .getFirstListItem<Station>(pb.filter("name = {:name}", { name: stationName }));
  } catch {
    return { results: [] };
  }
  const rules = await pb.collection("station_queries").getFullList<StationQueryRecord>({
    filter: pb.filter("station = {:sid}", { sid: station.id }),
    sort: "name",
  });
  const q = (filter ?? "").trim().toLowerCase();
  const filtered = q ? rules.filter((r) => r.name.toLowerCase().includes(q)) : rules;
  return {
    results: filtered.map((r) => ({ name: r.name, value: r.name })),
  };
}

export async function getQueryParameterFieldsMapping(
  this: ILoadOptionsFunctions
): Promise<{ fields: ResourceMapperField[]; emptyFieldsNotice?: string }> {
  let credentials: ShobleCredentials;
  try {
    credentials = (await this.getCredentials("shobleApi")) as unknown as ShobleCredentials;
  } catch {
    return { fields: [], emptyFieldsNotice: "Select Shoble credentials first." };
  }
  const pb = getPocketBase(credentials);
  const stationName = resourceLocatorString(
    this.getCurrentNodeParameter("stationName") as string | INodeParameterResourceLocator
  );
  const namedQueryRule = this.getCurrentNodeParameter("namedQueryRule") as
    | INodeParameterResourceLocator
    | undefined;
  const legacy = String(this.getCurrentNodeParameter("queryRuleName") ?? "").trim();
  const ruleName = resourceLocatorString(namedQueryRule) || legacy;
  if (!stationName || !ruleName) {
    return {
      fields: [],
      emptyFieldsNotice: "Set station name and query rule to load parameters from PocketBase.",
    };
  }
  let station: Station;
  try {
    station = await pb
      .collection("stations")
      .getFirstListItem<Station>(pb.filter("name = {:name}", { name: stationName }));
  } catch {
    return { fields: [], emptyFieldsNotice: "Station not found in PocketBase." };
  }
  let record: StationQueryRecord;
  try {
    record = await pb
      .collection("station_queries")
      .getFirstListItem<StationQueryRecord>(
        pb.filter("station = {:sid} && name = {:qname}", { sid: station.id, qname: ruleName })
      );
  } catch {
    return {
      fields: [],
      emptyFieldsNotice: "station_queries record not found for this station and name.",
    };
  }
  let defs: ParamDefLite[];
  try {
    defs = normalizeParamDefsLite(record.parameter_defs);
  } catch {
    return { fields: [], emptyFieldsNotice: "Invalid parameter_defs JSON on the rule." };
  }
  if (defs.length === 0) {
    return {
      fields: [],
      emptyFieldsNotice: "This rule has no parameters. Use JSON mode or leave mapper empty.",
    };
  }
  const fields: ResourceMapperField[] = defs.map((d) => ({
    id: d.name,
    displayName: `${d.name} (${d.type})`,
    defaultMatch: false,
    required: d.required !== false,
    display: true,
    type: d.type === "string" ? "string" : "number",
  }));
  return { fields };
}

export type ValidationOutcome = { ok: true } | { ok: false; errors: string[] };

export type ValidationAssertion =
  | "rawContains"
  | "rawNotContains"
  | "rawMatchesRegex"
  | "valueIsArray"
  | "valueIsObject"
  | "valueIsNumber"
  | "valueIsString"
  | "arrayMinLength"
  | "arrayMaxLength"
  | "valueJsonEquals";

export type ValidationCheckRow = {
  assertion: ValidationAssertion;
  operandString: string;
  operandNumber: string;
};

const parseIntSafe = (s: string): number | null => {
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
};

export const runValidationChecks = (
  queryMode: string,
  raw: string,
  value: unknown,
  rows: ValidationCheckRow[]
): ValidationOutcome => {
  const errors: string[] = [];
  const mode = (queryMode || "raw").trim();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `Check ${i + 1} (${row.assertion})`;
    const opStr = row.operandString ?? "";
    const opNum = parseIntSafe(row.operandNumber ?? "");

    const needsValue = !["rawContains", "rawNotContains", "rawMatchesRegex"].includes(
      row.assertion
    );

    if (needsValue && mode !== "named") {
      errors.push(`${label}: requires named query mode (parsed value missing for raw queries).`);
      continue;
    }

    switch (row.assertion) {
      case "rawContains": {
        if (!raw.includes(opStr))
          errors.push(`${label}: raw does not contain ${JSON.stringify(opStr)}.`);
        break;
      }
      case "rawNotContains": {
        if (raw.includes(opStr))
          errors.push(`${label}: raw unexpectedly contains ${JSON.stringify(opStr)}.`);
        break;
      }
      case "rawMatchesRegex": {
        try {
          const re = new RegExp(opStr);
          if (!re.test(raw)) errors.push(`${label}: raw does not match /${opStr}/.`);
        } catch (e) {
          errors.push(`${label}: invalid regex (${(e as Error).message}).`);
        }
        break;
      }
      case "valueIsArray": {
        if (!Array.isArray(value)) errors.push(`${label}: value is not an array.`);
        break;
      }
      case "valueIsObject": {
        if (value === null || typeof value !== "object" || Array.isArray(value))
          errors.push(`${label}: value is not a plain object.`);
        break;
      }
      case "valueIsNumber": {
        if (typeof value !== "number" || Number.isNaN(value))
          errors.push(`${label}: value is not a finite number.`);
        break;
      }
      case "valueIsString": {
        if (typeof value !== "string") errors.push(`${label}: value is not a string.`);
        break;
      }
      case "arrayMinLength": {
        if (opNum === null) {
          errors.push(`${label}: operand number required.`);
          break;
        }
        if (!Array.isArray(value)) {
          errors.push(`${label}: value is not an array.`);
          break;
        }
        if (value.length < opNum) errors.push(`${label}: array length ${value.length} < ${opNum}.`);
        break;
      }
      case "arrayMaxLength": {
        if (opNum === null) {
          errors.push(`${label}: operand number required.`);
          break;
        }
        if (!Array.isArray(value)) {
          errors.push(`${label}: value is not an array.`);
          break;
        }
        if (value.length > opNum) errors.push(`${label}: array length ${value.length} > ${opNum}.`);
        break;
      }
      case "valueJsonEquals": {
        let expected: unknown;
        try {
          expected = JSON.parse(opStr) as unknown;
        } catch (e) {
          errors.push(`${label}: operand string is not valid JSON (${(e as Error).message}).`);
          break;
        }
        const actual = JSON.stringify(value);
        const exp = JSON.stringify(expected);
        if (actual !== exp) errors.push(`${label}: value JSON mismatch.`);
        break;
      }
      default:
        errors.push(`${label}: unknown assertion.`);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true };
};
