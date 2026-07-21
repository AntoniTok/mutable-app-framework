import type { AppTemplate } from "./types";
import { counterTemplate } from "./examples/counter";
import { notesTemplate } from "./examples/notes";
import { tictactoeTemplate } from "./examples/tictactoe";
import { pokerTemplate } from "./examples/poker";
import { blackjackTemplate } from "./examples/blackjack";

/**
 * The app catalog.
 *
 * Templates under `./examples/` are EXAMPLE apps that ship with the framework
 * to demonstrate the app contract — they are not part of the framework core.
 * Adding a new app type is a one-line change here plus a new template module;
 * the framework core never references concrete app content directly.
 */
export const templates: Record<string, AppTemplate> = {
  // Multiplayer blackjack vs. a shared dealer (hidden dealer hole card).
  // See src/templates/examples/blackjack.ts
  blackjack: blackjackTemplate,
  // Multiplayer + hidden-information example app (asymmetric per-player views).
  // See src/templates/examples/poker.ts
  poker: pokerTemplate,
  // Multiplayer example app (symmetric state). See src/templates/examples/tictactoe.ts
  tictactoe: tictactoeTemplate,
  // Simpler example app. See src/templates/examples/counter.ts
  counter: counterTemplate,
  // Filesystem-backed example app (folders/read/write). See src/templates/examples/notes.ts
  notes: notesTemplate
  // chat: chatTemplate,   // <- add your own example/app templates here
};

// The single hosted app — the ONE source of truth. This framework runs ONE app
// at a time; change this line ALONE to build a different app on the framework,
// e.g. "tictactoe" or "counter" (AppHost.initialState.templateId derives from it).
export const DEFAULT_TEMPLATE_ID = "blackjack";

export function getTemplate(id: string | undefined): AppTemplate {
  return templates[id ?? DEFAULT_TEMPLATE_ID] ?? templates[DEFAULT_TEMPLATE_ID];
}

/** True if `id` names a template that actually ships in the catalog. */
export function isKnownTemplate(id: string | undefined): id is string {
  return typeof id === "string" && id in templates;
}

/**
 * The template catalog for the lobby's "Create room" picker — id + label +
 * declared capabilities only (never the file bodies). `default` flags the id a
 * room seeds from when none is chosen.
 */
export function listTemplates(): {
  id: string;
  label: string;
  declares: string[];
  default: boolean;
}[] {
  return Object.values(templates).map((t) => ({
    id: t.id,
    label: t.label,
    declares: t.declares ?? [],
    default: t.id === DEFAULT_TEMPLATE_ID
  }));
}
