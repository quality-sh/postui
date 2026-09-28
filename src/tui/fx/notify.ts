import type { Toaster, ToastVariant } from "./toast.ts";

/**
 * The app's one toast stack, reachable from any pane without threading a
 * callback through the shell: the shell binds its Toaster at startup and
 * unbinds it on dispose. With nothing bound (unit tests of a lone pane),
 * notify is a no-op.
 */
let bound: Toaster | null = null;

export function bindToaster(toaster: Toaster | null): void {
  bound = toaster;
}

/** Show a toast (top-right, auto-hides): the acknowledgement for saves, imports and errors. */
export function notify(text: string, variant: ToastVariant = "info"): void {
  bound?.show(text, variant);
}
