import { Data } from "effect";

/** Focus was moved to a pane id that was never registered. */
export class UnknownPaneError extends Data.TaggedError("UnknownPaneError")<{
  readonly id: string;
}> {
  override get message(): string {
    return `cannot focus unregistered pane "${this.id}"`;
  }
}

/** A pane id was registered twice; tab order would be ambiguous. */
export class DuplicatePaneError extends Data.TaggedError("DuplicatePaneError")<{
  readonly id: string;
}> {
  override get message(): string {
    return `pane "${this.id}" is already registered`;
  }
}

/**
 * App-level pane focus, independent of any UI framework.
 *
 * Panes register in tab order; `cycle()` is tab, `cycleBack()` is
 * shift+tab. Registration order is the cycle order, cycling wraps at both
 * ends, and unregistering the focused pane hands focus to the next
 * registration (wrapping to the first when the focus was last).
 */
export class FocusRegistry {
  private readonly order: string[] = [];
  private current: string | null = null;

  register(id: string): void {
    if (this.order.includes(id)) throw new DuplicatePaneError({ id });
    this.order.push(id);
    if (this.current === null) this.current = id;
  }

  unregister(id: string): void {
    const index = this.order.indexOf(id);
    if (index === -1) return;
    this.order.splice(index, 1);
    if (this.current !== id) return;
    const next = this.order[index % this.order.length];
    this.current = next ?? null;
  }

  /** Focus a specific registered pane directly. */
  focus(id: string): void {
    if (!this.order.includes(id)) throw new UnknownPaneError({ id });
    this.current = id;
  }

  /** Tab: advance to the next pane, wrapping at the end. */
  cycle(): string | null {
    return this.step(1);
  }

  /** Shift+tab: go back one pane, wrapping at the start. */
  cycleBack(): string | null {
    return this.step(-1);
  }

  get focused(): string | null {
    return this.current;
  }

  /** Pane ids in tab order. */
  get ids(): readonly string[] {
    return this.order;
  }

  private step(direction: 1 | -1): string | null {
    if (this.order.length === 0) return null;
    const index = this.current === null ? 0 : this.order.indexOf(this.current);
    const next = this.order[(index + direction + this.order.length) % this.order.length];
    if (next === undefined) return null;
    this.current = next;
    return next;
  }
}
