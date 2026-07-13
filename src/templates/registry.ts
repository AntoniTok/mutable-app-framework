import type { AppTemplate } from "./types";
import { counterTemplate } from "./examples/counter";
import { tictactoeTemplate } from "./examples/tictactoe";
import { pokerTemplate } from "./examples/poker";

/**
 * The app catalog.
 *
 * Templates under `./examples/` are EXAMPLE apps that ship with the framework
 * to demonstrate the app contract — they are not part of the framework core.
 * Adding a new app type is a one-line change here plus a new template module;
 * the framework core never references concrete app content directly.
 */
export const templates: Record<string, AppTemplate> = {
  // Multiplayer + hidden-information example app (asymmetric per-player views).
  // See src/templates/examples/poker.ts
  poker: pokerTemplate,
  // Multiplayer example app (symmetric state). See src/templates/examples/tictactoe.ts
  tictactoe: tictactoeTemplate,
  // Simpler example app. See src/templates/examples/counter.ts
  counter: counterTemplate
  // chat: chatTemplate,   // <- add your own example/app templates here
};

// The single hosted app — the ONE source of truth. This framework runs ONE app
// at a time; change this line ALONE to build a different app on the framework,
// e.g. "tictactoe" or "counter" (AppHost.initialState.templateId derives from it).
export const DEFAULT_TEMPLATE_ID = "poker";

export function getTemplate(id: string | undefined): AppTemplate {
  return templates[id ?? DEFAULT_TEMPLATE_ID] ?? templates[DEFAULT_TEMPLATE_ID];
}
