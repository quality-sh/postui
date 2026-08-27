export type FormDataEntry =
  | { kind: "field"; name: string; value: string }
  | { kind: "file"; name: string; path: string };

export interface RequestSpec {
  method: string;
  url: URL;
  headers: Array<[string, string]>;
  body:
    | { kind: "none" }
    | { kind: "raw"; contentType: string | null; text: string }
    | { kind: "form"; entries: FormDataEntry[] };
}

export interface ParseWarning {
  flag: string;
  message: string;
}
