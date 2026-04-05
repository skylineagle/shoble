# Shoble query engine

This document describes how the **named query** pipeline works: configuration in PocketBase, the HTTP API, parameter substitution, TCP framing, and response parsing. Implementation lives in `packages/server/src/query-engine.ts`; it is invoked from `packages/server/src/index.ts` for `POST /query/:station/named/:queryName`. Raw ad-hoc queries (`POST /query/:station` with a `query` string) bypass this engine except for TCP newline handling.

---

## Table of contents

1. [End-to-end flow](#end-to-end-flow)
2. [PocketBase: `station_queries` collection](#pocketbase-station_queries-collection)
3. [HTTP API](#http-api)
4. [TCP transport and what “one response” means](#tcp-transport-and-what-one-response-means)
5. [Parameter definitions (`parameter_defs`)](#parameter-definitions-parameter_defs)
6. [Command templates and `$placeholders`](#command-templates-and-placeholders)
7. [Response schema (`response_schema`)](#response-schema-response_schema)
8. [Mini-language vs JSON for `response_schema`](#mini-language-vs-json-for-response_schema)
9. [Parsing rules in detail](#parsing-rules-in-detail)
10. [Worked examples](#worked-examples)
11. [Example catalog (quick copy-paste)](#example-catalog-quick-copy-paste)
12. [Error messages you may see](#error-messages-you-may-see)
13. [Limitations and design notes](#limitations-and-design-notes)
14. [Source file reference](#source-file-reference)

---

## End-to-end flow

For a **named** query, the server performs these steps in order:

1. **Resolve the station** by human-readable name (PocketBase `stations.name`). Load its linked spectrum (`host`, `port`).
2. **Load the rule** from PocketBase collection `station_queries` where `station` equals the station record id and `name` equals the URL segment `queryName`.
3. **Normalize `parameter_defs`** from JSON. An empty or missing value becomes `[]`.
4. **Build the command** from `command_template` and the request body’s `parameters` object: validate types, reject unknown keys, substitute `$name` placeholders, ensure no `$placeholder` remains.
5. **Send over TCP** to the spectrum host: the final string is sent with exactly one trailing newline (see [TCP](#tcp-transport-and-what-one-response-means)).
6. **Read one line** of response (bytes until the first `\n`, exclusive). That string is `raw` in the HTTP response.
7. **Parse `raw`** according to `response_schema` to produce `value`.
8. Return `{ queryName, command, raw, value }`.

The **raw** query endpoint only does steps 1, 5, and 6 (with the body’s `query` string), and returns `{ response }` where `response` is the same single-line `raw` string (no PocketBase rule, no parsing).

---

## PocketBase: `station_queries` collection

Defined in `packages/pocketbase/pb_migrations/` (migration that creates `station_queries`). Each record is one **named rule** scoped to a **single station**.

| Field | Type | Required | Role |
|-------|------|----------|------|
| `name` | text | yes | Logical name of the rule; must match the `:queryName` URL segment for that station. |
| `station` | relation → `stations` | yes | Which station this rule belongs to. Same `name` may exist on different stations as separate records. |
| `command_template` | text | yes | SCPI / ASCII command sent to the instrument, including optional `$param` placeholders. |
| `parameter_defs` | json | no | Array describing allowed parameters, types, and optionality. Omitted or null → `[]`. |
| `response_schema` | text | yes | Describes how to parse the first line of the instrument reply into `value` (mini-language or JSON object). |

API rules on the collection are the same pattern as other Shoble collections (empty rules in the default migration mean publicly accessible record APIs; tighten in production as needed).

---

## HTTP API

### Named query (uses the query engine)

- **Method / path:** `POST /query/:station/named/:queryName`
- **Path parameters:**
  - `station` — must match a `stations.name` value.
  - `queryName` — must match `station_queries.name` for that station’s record.
- **Body (JSON):**
  - `parameters` — optional object. Keys must exactly match names declared in `parameter_defs`. Values are validated per field type.

Example:

```http
POST /query/lab-a/named/trace_data
Content-Type: application/json

{
  "parameters": {
    "traceIndex": 1
  }
}
```

**Success response (shape):**

```json
{
  "queryName": "trace_data",
  "command": "TRACe:DATA? 1\n",
  "raw": "-45.2,-44.8,-46.1",
  "value": [-45.2, -44.8, -46.1]
}
```

- `command` is the string after substitution, as sent on the wire (before the transport adds its single trailing newline if your template already ended with `\n`; see TCP section).
- `raw` is exactly one line from the instrument (no `\n` in the string).
- `value` is the parsed form according to `response_schema`.

### Raw query (no engine, no PocketBase rule)

- **Method / path:** `POST /query/:station`
- **Body:** `{ "query": "<full command text>" }`
- **Response:** `{ "response": "<one line from instrument>" }`

---

## TCP transport and what “one response” means

Implementation: `packages/server/src/tcp.ts`.

1. **Outgoing:** The engine passes the built command string to `tcpQuery`. Before write, any **trailing** line ending and whitespace are stripped: `\r?\n\s*$`. Then the client sends **`payload + "\n"`**. So whether your template ends with `... 1` or `... 1\n`, the device receives exactly one newline-terminated command line.

2. **Incoming:** Data is buffered until the **first `\n`** in the stream. Everything **before** that newline is returned as a single string. No trimming of the response line is applied before parsing (parsing steps may trim internally where noted).

3. **Implication:** Multi-line instrument replies that should be merged into one logical line must be handled by the device firmware/protocol, or you must extend the TCP client. The current contract is **one ASCII line** per query exchange for framing purposes.

---

## Parameter definitions (`parameter_defs`)

Stored as a **JSON array** of objects. Normalization is done by `normalizeParamDefs` in `query-engine.ts`.

### Shape of each element

| Property | Type | Meaning |
|----------|------|----------|
| `name` | string | Identifier; must match a key in the request `parameters` object if that parameter is supplied or required. |
| `type` | `"string"` \| `"number"` \| `"integer"` | How to coerce and validate the value. |
| `required` | boolean, optional | If **`false`**, the client may omit the key; any other value or omission means **required** (default required). |

### Validation rules

- `parameter_defs` must be **`null`**, **`undefined`**, or a **JSON array**. Any other top-level shape throws.
- Each element must be a non-array object with a non-empty string `name` and a valid `type`.
- **Required parameters** (default): must be present in `parameters` and non-null.
- **Optional parameters** (`"required": false`): may be omitted. If omitted, they are **not** present for substitution; if your `command_template` still contains `$thatName`, substitution fails (see errors).
- **Unknown keys:** Every key in the request `parameters` object must appear in `parameter_defs`. Extra keys → error.
- **Coercion:**
  - **`string`:** JSON value must be a JavaScript string.
  - **`number` / `integer`:** JSON number is accepted (with integer check for `integer`). A **string** that parses to a finite number is also accepted; `integer` additionally requires `Number.isInteger` after parse.
- **`parameters` body omitted or not an object:** Treated as `{}` for validation purposes.

### Substitution value on the wire

After validation, each parameter becomes either a string or a number. In the template, **`number`** values are converted with `String(n)`; **string** values are inserted as-is. There is **no** automatic quoting or escaping for SCPI (you encode what the instrument expects inside the template).

---

## Command templates and `$placeholders`

Placeholders match the regular expression **`$[a-zA-Z_][a-zA-Z0-9]*`** (globally, all occurrences replaced).

Rules:

1. Every placeholder in the template must correspond to a **provided** parameter after validation (i.e. required params must be in the body; optional ones must be present if referenced by `$name`).
2. After replacement, **no** `$identifier` may remain; otherwise the engine throws (even if you meant a literal `$` — the engine does not support escaping).

Examples:

- Template `TRACe:DATA? $traceIndex\n` with `traceIndex: 1` → `TRACe:DATA? 1\n`
- Template `*IDN?` with empty `parameter_defs` and `{}` → unchanged

---

## Response schema (`response_schema`)

Stored as **text** in PocketBase. Parsed by `parseResponseSchema`:

1. Trim leading/trailing whitespace.
2. If it starts with **`{`**, it is parsed as **JSON** and normalized into a discriminated `ResponseFormat` (see JSON kinds below).
3. Otherwise it is parsed as the **mini-language** (tuples, arrays, scalars, raw).

The result drives `parseTcpResponse(rawLine, format)`, which converts the single TCP line into a JavaScript `value` for JSON serialization.

### Internal kinds (`ResponseFormat`)

| Kind | Purpose |
|------|----------|
| `raw` | Return the line unchanged as a string. |
| `scalar` | Parse the **entire** line as one `string`, `number`, or `integer`. |
| `array` | Split the line by a **separator** string; each element is trimmed; elements parsed as `string` or `number` (arrays do not support `integer` per element — use JSON `scalar`/`tuple` if you need integer checks per slot). |
| `tuple` | Split by separator into **N** segments; map segment *i* to `parts[i]` with a field **name** and **type** (`string` \| `number` \| `integer`); result is a plain object `{ [name]: value, ... }`. |

---

## Mini-language vs JSON for `response_schema`

### Mini-language (no leading `{`)

Order of interpretation (first match wins in code path):

1. **Tuple:** If the string contains **`;`**, it is treated as the tuple **mini** form. The schema text is split on **`;`** into segments; each segment must look like `name(type)` where `name` matches `[a-zA-Z_][a-zA-Z0-9]*` and `type` is `string`, `number`, or `integer`. The **instrument response line** is then split on **`;`** between values (same character: this separator is **not** configurable in mini form; use JSON `tuple` if you need another delimiter).

2. **Array:** If the string **ends with** `[]`, the prefix must be `string` or `number` → `string[]` or `number[]`. Element separator is **always comma `,`** in mini form.

3. **Aliases:** `raw` or `text` → kind `raw`.

4. **Scalar:** Exactly `string`, `number`, or `integer`.

5. Anything else → error `unrecognized shape`.

**Implication:** You **cannot** use the mini-language for an array that uses a non-comma separator, or for a tuple whose response uses a non-`;` separator. Use **JSON** for those.

### JSON object (starts with `{`)

Must parse to an object with a `kind` field:

| `kind` | Fields | Defaults |
|--------|--------|----------|
| `"raw"` | — | — |
| `"scalar"` | `type`: `string` \| `number` \| `integer` | — |
| `"array"` | `elementType`: `string` \| `number`; optional `separator` (non-empty string) | `separator` defaults to `","` |
| `"tuple"` | `parts`: array of `{ "name", "type" }`; optional `separator` | `separator` defaults to `";"` |

Invalid JSON → whatever `JSON.parse` throws; propagated as configuration error when loading the rule.

---

## Parsing rules in detail

### `raw`

- `value` is identical to `raw` (the full line, no trimming at this stage for `raw` — the line is passed through as received from TCP framing, i.e. without the trailing `\n`).

### `scalar`

- **`string`:** Returns the line as-is (entire line, no trim in `assertScalarType` for string).
- **`number` / `integer`:** `Number(raw.trim())` must be finite; `integer` requires `Number.isInteger`.

### `array`

- The line is **trimmed**. If the result is empty, **`value` is `[]`**.
- Otherwise `trimmed.split(separator)` — separator is from schema (comma default in JSON; **fixed comma** in mini `[]` form).
- Each chunk is **trimmed**.
- Elements: `string` → as-is; `number` → parsed like scalar number (per-element errors include index in the label).

### `tuple`

- Line is split by `separator` (default `;`). Each segment is **trimmed**.
- **Count must match** `parts.length` exactly; otherwise an error lists expected vs actual count.
- Each segment is coerced with `assertScalarType(fieldName, segment, type)`.

---

## Worked examples

### 1. Trace data as comma-separated numbers

**PocketBase**

- `command_template`: `TRACe:DATA? $traceIndex\n`
- `parameter_defs`:

```json
[
  { "name": "traceIndex", "type": "integer" }
]
```

- `response_schema`: `number[]` (mini) or `{"kind":"array","elementType":"number","separator":","}`

**Instrument line:** `-45.2,-44.8,-46.1`

**`value`:** `[-45.2, -44.8, -46.1]`

### 2. Parameterized trace index via API

**Request**

```json
POST .../named/trace_read
{ "parameters": { "traceIndex": 1 } }
```

Same configuration as above; `command` shows substituted command; `raw` is the trace line.

### 3. Compound query: X and Y with `;` in response

**PocketBase**

- `command_template`: `CALCulate:MARKer1:X?;CALCulate:MARKer1:Y?\n`
- `parameter_defs`: `[]`
- `response_schema` (mini): `responseA(string);responseB(number)`  
  or JSON: `{"kind":"tuple","separator":";","parts":[{"name":"responseA","type":"string"},{"name":"responseB","type":"number"}]}`

**Instrument line:** `2412000000;-12.45`

**`value`:** `{ "responseA": "2412000000", "responseB": -12.45 }`

### 4. Plain identification string

- `response_schema`: `string` or `{"kind":"scalar","type":"string"}`
- Line → one string `value`.

### 5. Pass-through for odd formats

- `response_schema`: `raw`
- `value` equals `raw`; parse later in your client if needed.

### 6. Optional parameter (same template without placeholder)

- `parameter_defs`: `[{ "name": "channel", "type": "integer", "required": false }]`
- Template without `$channel` → `{}` or `{ "parameters": {} }` is valid; optional unused.

If the template **includes** `$channel` and the client omits `channel`, substitution fails.

---

## Example catalog (quick copy-paste)

Below are **illustrative** Tektronix RSA-style ASCII patterns. Exact keywords depend on your instrument firmware; treat `name` (the PocketBase rule name) as whatever you choose for `POST .../named/:queryName`.

For each recipe: create one `station_queries` row linked to the right `station`, set the fields, then call the Shoble server. Paths use `lab-a` and example rule names—replace with yours.

### A. Identification and plain text answers

**A1 — `*IDN?` (whole line as string)**

| Field | Value |
|--------|--------|
| `name` | `idn` |
| `command_template` | `*IDN?\n` |
| `parameter_defs` | `[]` |
| `response_schema` | `string` |

Example `raw`: `TEKTRONIX,RSA5126B,1234567,1.2.3`  
Example `value`: same string.

**A2 — Same answer, no parsing (`raw`)**

| Field | Value |
|--------|--------|
| `response_schema` | `raw` |

Use when you want the exact line in clients that will split or parse locally.

**A3 — Operation complete (`*OPC?` style, line as integer)**

| Field | Value |
|--------|--------|
| `name` | `opc` |
| `command_template` | `*OPC?\n` |
| `parameter_defs` | `[]` |
| `response_schema` | `integer` |

Example `raw`: `1` → `value`: `1`.

---

### B. Single numeric / scalar readback

**B1 — Frequency as floating scalar**

| Field | Value |
|--------|--------|
| `name` | `read_center_hz` |
| `command_template` | `SENSe:FREQuency:CENTer?\n` |
| `parameter_defs` | `[]` |
| `response_schema` | `number` |

Example `raw`: `2412000000` → `value`: `2412000000` (number).

**B2 — Reference level (number)**

| Field | Value |
|--------|--------|
| `name` | `read_ref_level` |
| `command_template` | `DISPlay:WINDow:TRACe:Y:SCALe:RLEVel?\n` |
| `parameter_defs` | `[]` |
| `response_schema` | `number` |

---

### C. Parameterized commands (one or more `$` placeholders)

**C1 — Trace data by index (`number[]`)**

| Field | Value |
|--------|--------|
| `name` | `trace_data` |
| `command_template` | `TRACe:DATA? $traceIndex\n` |
| `parameter_defs` | `[{ "name": "traceIndex", "type": "integer" }]` |
| `response_schema` | `number[]` |

HTTP:

```http
POST /query/lab-a/named/trace_data
Content-Type: application/json

{"parameters":{"traceIndex":1}}
```

**C2 — Two integer placeholders in one command**

| Field | Value |
|--------|--------|
| `name` | `two_slot_query` |
| `command_template` | `CALCulate:LINEar:RLIMit:LOWer $traceNum, $regionNum\n` |
| `parameter_defs` | `[{"name":"traceNum","type":"integer"},{"name":"regionNum","type":"integer"}]` |
| `response_schema` | `number` *(adjust to what the instrument returns)* |

Body: `{"parameters":{"traceNum":1,"regionNum":0}}`

**C3 — Integer + string parameters in one command**

| Field | Value |
|--------|--------|
| `name` | `load_trace_example` |
| `command_template` | `MMEMory:LOAD:TRACe $slot,$fileName\n` |
| `parameter_defs` | `[{"name":"slot","type":"integer"},{"name":"fileName","type":"string"}]` |
| `response_schema` | `raw` *(or `string` / `number` depending on instrument reply)* |

Body: `{"parameters":{"slot":1,"fileName":"trace01.csv"}}`

**C4 — Optional parameter not used in template**

| Field | Value |
|--------|--------|
| `parameter_defs` | `[{"name":"reserved","type":"integer","required":false}]` |
| `command_template` | `*IDN?\n` |

`{}` body is valid; do not put `$reserved` in the template unless you always pass it.

---

### D. Arrays (comma-separated or custom separator)

**D1 — Comma-separated floats (mini `number[]`)**

| `response_schema` | `number[]` |
| Example `raw` | `-45.2,-44.8,-46.1` |
| `value` | `[-45.2,-44.8,-46.1]` |

**D2 — Comma-separated tokens as strings**

| `response_schema` | `string[]` |
| Example `raw` | `NORM,MAXH,AVER` |
| `value` | `["NORM","MAXH","AVER"]` |

**D3 — Whitespace-separated numbers (JSON array only)**

Mini-language cannot change separator; use JSON:

```text
{"kind":"array","elementType":"number","separator":" "}
```

Example `raw`: `-10.5 -9.8 -11.2` → three numbers.

**D3b — Tab-separated**

```text
{"kind":"array","elementType":"number","separator":"\t"}
```

**D4 — Empty numeric list → empty array**

| `response_schema` | `number[]` |
| `raw` | `""` (empty line after trim) |
| `value` | `[]` |

---

### E. Tuples (one response line, multiple values)

**E1 — Marker X and Y (semicolon, mini-language)**

| Field | Value |
|--------|--------|
| `command_template` | `CALCulate:MARKer1:X?;CALCulate:MARKer1:Y?\n` |
| `parameter_defs` | `[]` |
| `response_schema` | `marker_x_hz(string);marker_y_dbm(number)` |

Example `raw`: `2412000000;-12.45`  
Example `value`: `{"marker_x_hz":"2412000000","marker_y_dbm":-12.45}`

**E2 — Same semantics, explicit JSON tuple**

```text
{"kind":"tuple","separator":";","parts":[{"name":"marker_x_hz","type":"string"},{"name":"marker_y_dbm","type":"number"}]}
```

**E3 — Three fields (mini)**

| `response_schema` | `a(string);b(number);c(integer)` |
| `raw` | `OK;2.5;42` |
| `value` | `{"a":"OK","b":2.5,"c":42}` |

**E4 — Tuple with comma-separated response (not semicolon)**

Mini tuple format always uses `;` in the **instrument line**. If the device returns commas between values, use JSON:

```text
{"kind":"tuple","separator":",","parts":[{"name":"x","type":"number"},{"name":"y","type":"number"}]}
```

Example `raw`: `100.5,-3.2`

**E5 — Four-value sweep line**

```text
{"kind":"tuple","separator":";","parts":[{"name":"start_hz","type":"number"},{"name":"stop_hz","type":"number"},{"name":"rbw_hz","type":"number"},{"name":"ref_dbm","type":"number"}]}
```

Example `raw`: `900000000;3000000000;1000;-25`

---

### F. Mixed: parameterized command + tuple response

**F1 — Query marker index then read X/Y**

Configure two rules in PocketBase, or one rule per logical call. Example single rule with parameters:

| Field | Value |
|--------|--------|
| `name` | `marker_xy` |
| `command_template` | `CALCulate:MARKer$index:X?;CALCulate:MARKer$index:Y?\n` |
| `parameter_defs` | `[{"name":"index","type":"integer"}]` |
| `response_schema` | `x_hz(string);y_db(number)` |

Body: `{"parameters":{"index":1}}`  
*(Instrument path syntax is illustrative; align `$index` placement with your SCPI.)*

---

### G. JSON-only `response_schema` variants (same patterns, explicit `kind`)

**G1 — Scalar**

```text
{"kind":"scalar","type":"string"}
```

**G2 — Array with comma (explicit)**

```text
{"kind":"array","elementType":"number","separator":","}
```

Equivalent mini: `number[]`.

**G3 — Raw**

```text
{"kind":"raw"}
```

Equivalent mini: `raw` or `text`.

---

### H. Raw HTTP snippets (curl-style)

Named rule `trace_data` (see **C1**):

```bash
curl -sS -X POST "http://localhost:3000/query/lab-a/named/trace_data" \
  -H "Content-Type: application/json" \
  -d '{"parameters":{"traceIndex":1}}'
```

Raw query (no PocketBase rule):

```bash
curl -sS -X POST "http://localhost:3000/query/lab-a" \
  -H "Content-Type: application/json" \
  -d '{"query":"*IDN?\n"}'
```

---

### I. “If your instrument returns…” cheat sheet

| Instrument line shape | Typical `response_schema` |
|------------------------|---------------------------|
| Single token number | `number` or `integer` |
| Single free-text line | `string` or `raw` |
| `p1,p2,p3` floats | `number[]` |
| `a1;a2;a3` aligned to named fields | Mini `n1(t1);n2(t2);n3(t3)` or JSON `tuple` |
| `x y z` space numbers | JSON `array` + `"separator":" "` |
| Non-standard delimiter | JSON `array` or `tuple` + set `separator` |
| You will parse later | `raw` |

---

### J. More scalar readbacks (copy each as its own `station_queries` row)

Use `parameter_defs` `[]` and `response_schema` `number` unless noted.

| Rule `name` (example) | `command_template` (example) | Notes |
|------------------------|--------------------------------|--------|
| `read_rbw` | `SENSe:BWIDth:RESolution?\n` | Resolution bandwidth |
| `read_vbw` | `SENSe:BWIDth:VIDeo?\n` | Video bandwidth |
| `read_dwell` | `SENSe:SWEep:TIME?\n` | Sweep / acquisition time |
| `read_span` | `SENSe:FREQuency:SPAN?\n` | Span |
| `read_points` | `SENSe:SWEep:POINts?\n` | Often integer; use `integer` if the box never sends decimals |
| `read_avg_count` | `SENSe:AVERage:COUNt?\n` | Use `integer` if appropriate |

**Status / enum as text**

| `name` | `trace_detector_type` |
| `command_template` | `SENSe:DETector:TRACe:FUNCtion?\n` |
| `response_schema` | `string` |

Example `raw`: `NORM` or `POS` (instrument-specific).

---

### K. Three-query line → three-part tuple

Some setups return `v1;v2;v3` after one chained query string:

| Field | Value |
|--------|--------|
| `name` | `span_center_rbw` |
| `command_template` | `SENSe:FREQuency:SPAN?;SENSe:FREQuency:CENTer?;SENSe:BWIDth:RESolution?\n` |
| `parameter_defs` | `[]` |
| `response_schema` | `span_hz(number);center_hz(number);rbw_hz(number)` |

Example `raw`: `3000000000;2412000000;10000`

---

### L. Scientific notation and numeric strings

The engine uses JavaScript `Number()` for numeric parsing. Values such as `1.2E9` or `2.41e9` in `raw` parse as numbers for `scalar`, `array` elements, and `tuple` parts typed as `number` or `integer` (integer still requires a whole number after parse).

---

### M. Boolean-ish `0` / `1` replies

If the instrument returns only `0` or `1`:

- Treat as **`integer`** if you want strict integer typing.
- Treat as **`number`** if you prefer all numeric scalars in one type.

---

### N. One rule per “family”, varied parameters

PocketBase row **`trace_query_1`** with template `TRACe:DATA? 1\n` and **`trace_query_2`** with template `TRACe:DATA? 2\n` avoids placeholders when firmware expects fixed indices. Alternatively one rule with `$traceIndex` (see **C1**) keeps a single row.

---

### O. n8n: Execute Query and Validate

Use **Shoble: Execute Query** with **Configured Rule**, pick **Station** and **Query Rule** from PocketBase, then **Parameters (JSON)** or **Form (from PocketBase)** so keys match `parameter_defs`. For assertions and **pass** / **fail** outputs, use **Shoble: Execute Query and Validate** (see `packages/n8n-nodes` and the repo README).

---

## Error messages you may see

These are thrown inside the engine or wrapped by the route (prefixes like `Parameter error:` come from the HTTP handler).

| Message pattern | Typical cause |
|-----------------|----------------|
| `parameter_defs must be a JSON array` | `parameter_defs` is not an array. |
| `parameter_defs[n] ...` | Bad element in the array. |
| `missing required parameter "x"` | Required field not in `parameters`. |
| `unknown parameter "x"` | Key in body not listed in `parameter_defs`. |
| `parameter "x" must be string` / `number` / `integer` | Type mismatch or bad coercion. |
| `template references $x but parameter was not provided or is optional-skipped` | `$x` in template but `x` not in validated map. |
| `unresolved placeholder $x after substitution` | Still `$x` after replace (e.g. typo vs `parameter_defs` names). |
| `response_schema is empty` | Blank `response_schema` text. |
| `response_schema: invalid tuple segment` | Bad `name(type)` segment in mini tuple. |
| `response_schema JSON must be an object` | JSON array or primitive where object expected. |
| `response_schema JSON: unknown kind` | Missing or invalid `kind` in JSON. |
| `expected N tuple segment(s), got M` | Instrument line split count mismatch. |
| `response: not a number` / `expected integer` | Scalar or tuple/array numeric parse failure. |

PocketBase or station resolution errors are separate (`Station not found`, `Query rule not found`, etc.).

---

## Limitations and design notes

1. **Single response line** — The TCP client reads up to the first `\n` only.
2. **No `$` escaping** — Literal `$foo` in protocols cannot be sent if it matches the placeholder pattern; you would need a code change or to avoid named rules for that command.
3. **Tuple mini-format and `;` in template vs response** — The mini tuple definition uses `;` to separate `name(type)` **segments in the schema text**. The **response** tuple separator defaults to `;` in both mini and JSON default. Your **command** can use `;` for SCPI chaining independently; that does not change response parsing.
4. **Array element types** — JSON `array` only allows `elementType` `string` or `number`, not `integer` (per-element integer enforcement is only in `scalar` and `tuple` parts).
5. **First matching list query** — PocketBase lookup uses `getFirstListItem` with filter `station` and `name`. Duplicate rows break uniqueness expectations; keep one record per (`station`, `name`).
6. **Security** — Rules and admin data are only as safe as your PocketBase API rules and network exposure. The engine does not sanitize SCPI beyond parameter typing and placeholder replacement.

---

## Source file reference

| Concern | File |
|---------|------|
| Parameter defs, template substitution, response parsing | `packages/server/src/query-engine.ts` |
| Named and raw routes; PocketBase load for rules | `packages/server/src/index.ts` |
| TCP newline and read-until-newline | `packages/server/src/tcp.ts` |
| Fetch `station_queries` by station id + name | `packages/server/src/pocketbase.ts` (e.g. `getStationQueryRule`) |
| Collection schema | `packages/pocketbase/pb_migrations/` (migration creating `station_queries`) |
| n8n “Configured rule” mode | `packages/n8n-nodes/src/nodes/ExecuteQuery.node.ts` |

---

## Quick reference card

| I want… | `response_schema` approach |
|---------|----------------------------|
| Full line as string, no parsing | `raw` |
| One number / integer / string | `number`, `integer`, or `string` |
| Comma-separated list of numbers | `number[]` or JSON array with `separator: ","` |
| Semicolon-separated multi-value (object) | Mini `a(t);b(t)` or JSON `tuple` |
| Non-comma list or non-semicolon tuple | JSON `array` / `tuple` with explicit `separator` |

| I want… | `parameter_defs` + template |
|---------|-----------------------------|
| Dynamic trace index | `{ "name": "traceIndex", "type": "integer" }` + `$traceIndex` in template |
| Optional unused metadata | `"required": false` and **no** `$name` in template |
| No parameters | `[]` and no `$` in template |
