export type ParamDef = {
  name: string;
  type: "string" | "number" | "integer";
  required?: boolean;
};

export type ResponseFormat =
  | { kind: "raw" }
  | { kind: "scalar"; type: "string" | "number" | "integer" }
  | { kind: "array"; elementType: "string" | "number"; separator: string }
  | {
      kind: "tuple";
      separator: string;
      parts: { name: string; type: "string" | "number" | "integer" }[];
    };

const placeholderRegex = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

const assertScalarType = (
  label: string,
  raw: string,
  type: "string" | "number" | "integer"
): string | number => {
  if (type === "string") return raw;
  const n = Number(raw.trim());
  if (Number.isNaN(n)) throw new Error(`${label}: not a number: ${JSON.stringify(raw)}`);
  if (type === "integer" && !Number.isInteger(n))
    throw new Error(`${label}: expected integer, got ${JSON.stringify(raw)}`);
  return n;
};

export const parseResponseSchema = (input: string): ResponseFormat => {
  const t = input.trim();
  if (!t) throw new Error("response_schema is empty");
  if (t.startsWith("{")) {
    const v = JSON.parse(t) as unknown;
    return normalizeJsonFormat(v);
  }
  if (t.includes(";")) {
    const segments = t
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const parts = segments.map((seg, i) => {
      const m = seg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\((string|number|integer)\)$/);
      if (!m)
        throw new Error(`response_schema: invalid tuple segment at ${i}: ${JSON.stringify(seg)}`);
      return { name: m[1], type: m[2] as "string" | "number" | "integer" };
    });
    return { kind: "tuple", separator: ";", parts };
  }
  if (t.endsWith("[]")) {
    const et = t.slice(0, -2);
    if (et !== "string" && et !== "number")
      throw new Error(`response_schema: unknown array element type in ${JSON.stringify(t)}`);
    return { kind: "array", elementType: et, separator: "," };
  }
  if (t === "raw" || t === "text") return { kind: "raw" };
  if (t === "string" || t === "number" || t === "integer") return { kind: "scalar", type: t };
  throw new Error(`response_schema: unrecognized shape: ${JSON.stringify(t)}`);
};

const normalizeJsonFormat = (v: unknown): ResponseFormat => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("response_schema JSON must be an object");
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (kind === "raw") return { kind: "raw" };
  if (kind === "scalar") {
    const type = o.type;
    if (type !== "string" && type !== "number" && type !== "integer")
      throw new Error("scalar requires type string|number|integer");
    return { kind: "scalar", type };
  }
  if (kind === "array") {
    const elementType = o.elementType;
    if (elementType !== "string" && elementType !== "number")
      throw new Error("array requires elementType string|number");
    const separator = typeof o.separator === "string" && o.separator.length ? o.separator : ",";
    return { kind: "array", elementType, separator };
  }
  if (kind === "tuple") {
    const separator = typeof o.separator === "string" && o.separator.length ? o.separator : ";";
    const partsRaw = o.parts;
    if (!Array.isArray(partsRaw) || !partsRaw.length)
      throw new Error("tuple requires non-empty parts");
    const parts = partsRaw.map((p, i) => {
      if (!p || typeof p !== "object" || Array.isArray(p))
        throw new Error(`tuple.parts[${i}] invalid`);
      const pr = p as Record<string, unknown>;
      if (typeof pr.name !== "string" || !pr.name)
        throw new Error(`tuple.parts[${i}].name required`);
      if (pr.type !== "string" && pr.type !== "number" && pr.type !== "integer")
        throw new Error(`tuple.parts[${i}].type invalid`);
      return { name: pr.name, type: pr.type as "string" | "number" | "integer" };
    });
    return { kind: "tuple", separator, parts };
  }
  throw new Error("response_schema JSON: unknown kind");
};

const coerceParamValue = (
  name: string,
  type: ParamDef["type"],
  value: unknown
): string | number => {
  if (value === null || value === undefined)
    throw new Error(`parameter ${JSON.stringify(name)} is missing`);
  if (type === "string") {
    if (typeof value !== "string")
      throw new Error(`parameter ${JSON.stringify(name)} must be string`);
    return value;
  }
  if (typeof value === "number") {
    if (type === "integer" && !Number.isInteger(value))
      throw new Error(`parameter ${JSON.stringify(name)} must be integer`);
    if (Number.isNaN(value)) throw new Error(`parameter ${JSON.stringify(name)} is NaN`);
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isNaN(n)) throw new Error(`parameter ${JSON.stringify(name)} must be number`);
    if (type === "integer" && !Number.isInteger(n))
      throw new Error(`parameter ${JSON.stringify(name)} must be integer`);
    return n;
  }
  throw new Error(`parameter ${JSON.stringify(name)} must be number or string`);
};

export const normalizeParamDefs = (raw: unknown): ParamDef[] => {
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
    const d: ParamDef = { name: o.name, type: o.type };
    if (o.required === false) d.required = false;
    return d;
  });
};

export const validateAndBuildParameters = (
  defs: ParamDef[] | null | undefined,
  bodyParams: Record<string, unknown> | undefined
): Record<string, string | number> => {
  const list = Array.isArray(defs) ? defs : [];
  const incoming =
    bodyParams && typeof bodyParams === "object" && !Array.isArray(bodyParams) ? bodyParams : {};
  const out: Record<string, string | number> = {};
  for (const d of list) {
    const v = incoming[d.name];
    if (v === undefined || v === null) {
      if (d.required !== false)
        throw new Error(`missing required parameter ${JSON.stringify(d.name)}`);
      continue;
    }
    out[d.name] = coerceParamValue(d.name, d.type, v);
  }
  const allowed = new Set(list.map((x) => x.name));
  for (const k of Object.keys(incoming)) {
    if (!allowed.has(k)) throw new Error(`unknown parameter ${JSON.stringify(k)}`);
  }
  return out;
};

export const substituteCommandTemplate = (
  template: string,
  params: Record<string, string | number>
): string => {
  return template.replace(placeholderRegex, (_full, name: string) => {
    if (!(name in params))
      throw new Error(
        `template references $${name} but parameter was not provided or is optional-skipped`
      );
    const v = params[name];
    return typeof v === "number" ? String(v) : v;
  });
};

const ensureNoUnresolvedPlaceholders = (s: string) => {
  placeholderRegex.lastIndex = 0;
  const m = placeholderRegex.exec(s);
  if (m) throw new Error(`unresolved placeholder $${m[1]} after substitution`);
};

export const buildCommand = (
  template: string,
  defs: ParamDef[] | null | undefined,
  bodyParams: Record<string, unknown> | undefined
): string => {
  const params = validateAndBuildParameters(defs, bodyParams);
  const cmd = substituteCommandTemplate(template, params);
  ensureNoUnresolvedPlaceholders(cmd);
  return cmd;
};

export const parseTcpResponse = (rawLine: string, format: ResponseFormat): unknown => {
  if (format.kind === "raw") return rawLine;
  if (format.kind === "scalar") return assertScalarType("response", rawLine, format.type);
  if (format.kind === "array") {
    const s = rawLine.trim();
    if (!s) return [];
    return s.split(format.separator).map((chunk, i) => {
      const piece = chunk.trim();
      if (format.elementType === "string") return piece;
      return assertScalarType(`response[${i}]`, piece, "number") as number;
    });
  }
  const segs = rawLine.split(format.separator).map((x) => x.trim());
  if (segs.length !== format.parts.length)
    throw new Error(
      `expected ${format.parts.length} tuple segment(s), got ${segs.length} in ${JSON.stringify(rawLine)}`
    );
  const obj: Record<string, string | number> = {};
  format.parts.forEach((part, i) => {
    obj[part.name] = assertScalarType(part.name, segs[i] ?? "", part.type) as string | number;
  });
  return obj;
};
