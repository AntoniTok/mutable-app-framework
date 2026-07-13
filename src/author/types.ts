import type { AppFile } from "../templates/types";

/**
 * The AI contract.
 *
 * This is the seam that makes the model swappable. The Agent only ever depends
 * on this interface, never on a specific vendor (Workers AI, OpenAI, ...).
 *
 * Given an instruction plus the current files, return the complete new set of
 * files. Full-file output keeps things simple and deterministic to apply.
 */
export interface CodeAuthor {
  edit(input: {
    instruction: string;
    files: AppFile[];
    /** Capabilities the app is allowed to use (for prompt context). */
    declares: string[];
  }): Promise<AppFile[]>;

  /**
   * Fix a build error in a just-generated file set. Given the (broken) files and
   * the exact build error, return the complete corrected files. The host calls
   * this in a self-heal loop when `edit`'s output fails to bundle — most model
   * failures are one-token slips a targeted repair pass can fix.
   */
  repair(input: {
    instruction: string;
    files: AppFile[];
    error: string;
    declares: string[];
  }): Promise<AppFile[]>;
}
