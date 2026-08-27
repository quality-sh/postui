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
