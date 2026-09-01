import { Schema } from "effect";

/**
 * Serializable contract for a parsed request. Used to validate everything
 * `postui --json` emits before it leaves the process.
 */
const FormDataEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("field"),
    name: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    name: Schema.String,
    path: Schema.String,
  }),
]);

const RequestBody = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    contentType: Schema.NullOr(Schema.String),
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("form"),
    entries: Schema.Array(FormDataEntry),
  }),
]);

export const RequestSpecJson = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  body: RequestBody,
});

export type RequestSpecJson = typeof RequestSpecJson.Type;

/**
 * Serializable contract for an agent send (`postui send --json`). Every
 * string in the payload is redacted and bounded before encoding; the schema
 * gate validates the shape of what actually leaves the process.
 */
export const SendResultJson = Schema.Struct({
  request: Schema.Struct({
    method: Schema.String,
    url: Schema.String,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    headersOmitted: Schema.Number,
  }),
  response: Schema.Struct({
    status: Schema.Number,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    headersOmitted: Schema.Number,
    size: Schema.Number,
    shape: Schema.String,
    excerpt: Schema.String,
    excerptBytes: Schema.Number,
    truncated: Schema.Boolean,
  }),
});

export type SendResultJson = typeof SendResultJson.Type;
