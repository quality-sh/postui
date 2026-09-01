// @provenance rule: rule_agent_named_errors
import { Data } from "effect";

/** One or more $NAME references did not resolve. names never carries values. */
export class MissingEnvError extends Data.TaggedError("MissingEnvError")<{
  names: string[];
  message: string;
}> {}

/** send takes only --json and --body-bytes; every other option is refused. */
export class UnknownSendFlagError extends Data.TaggedError("UnknownSendFlagError")<{
  message: string;
}> {}

/** The saved definition itself cannot be sent (bad URL, method, form file). */
export class BadSendDefinitionError extends Data.TaggedError("BadSendDefinitionError")<{
  message: string;
}> {}

/** No network path could be established before the send started (exit 2). */
export class NetworkPathError extends Data.TaggedError("NetworkPathError")<{
  message: string;
}> {}

/** The send started and the transport failed before a response arrived (exit 1). */
export class TransportFailureError extends Data.TaggedError("TransportFailureError")<{
  message: string;
}> {}

/** The send completed and the API answered non-2xx (exit 1). */
export class SendRejectedError extends Data.TaggedError("SendRejectedError")<{
  status: number;
  message: string;
}> {}
