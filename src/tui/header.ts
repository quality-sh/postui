import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { halftoneBox } from "./render.ts";
import { THEME } from "./theme.ts";

/** Header bar: POSTUI wordmark + halftone left, workspace center, env badge right. */
export function buildHeader(
  renderer: CliRenderer,
  options: { readonly workspaceName: string; readonly envBadge: string },
): BoxRenderable {
  const header = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    border: true,
    borderColor: THEME.color.border,
    backgroundColor: THEME.color.bg,
    paddingX: 1,
    height: 3,
    width: "100%",
  });

  const left = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    width: "33%",
  });
  left.add(
    new TextRenderable(renderer, {
      content: new StyledText([bold(fg(THEME.color.accent)("P O S T U I"))]),
    }),
  );
  // The mockup's halftone strip fading out beside the wordmark.
  left.add(halftoneBox(renderer, 16, 1, "top-left"));
  header.add(left);

  const center = new BoxRenderable(renderer, {
    alignItems: "center",
    justifyContent: "center",
    width: "34%",
  });
  center.add(
    new TextRenderable(renderer, { content: options.workspaceName, fg: THEME.color.text }),
  );
  header.add(center);

  const right = new BoxRenderable(renderer, {
    alignItems: "center",
    justifyContent: "flex-end",
    width: "33%",
  });
  right.add(
    new TextRenderable(renderer, {
      content: new StyledText([bold(fg(THEME.color.accent)(options.envBadge))]),
    }),
  );
  header.add(right);

  return header;
}

