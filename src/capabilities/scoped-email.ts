import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppEmailPolicy, Env } from "../types";

/**
 * A MEDIATED transactional-email capability handed to an app by the broker
 * (`requestEmail`).
 *
 * The app never touches the `EMAIL` binding directly. It calls `send(...)`; this
 * trusted entrypoint:
 *   1. asks the app's AppHost to VALIDATE the send against policy (allowed
 *      senders / recipients) and RESERVE a slot in the daily counter — one
 *      serialized DO call, so concurrent sends can't overspend the cap, and
 *   2. performs the actual `env.EMAIL.send()` HERE (not in the DO), so the slow
 *      network call never holds AppHost's input gate (cf. limitation #3).
 *
 * The app can never choose an arbitrary `From` (anti-spoofing) or exceed its
 * daily cap: both are trusted policy set via the room's email settings.
 */
export type ScopedEmailProps = {
  instance: string;
};

/** What the app passes to send(). A safe, RPC-serializable subset. */
export interface ScopedEmailMessage {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  /** Optional reply-to address. */
  replyTo?: string;
  /**
   * Optional sender address. MUST be on the app's allowed-senders list; omit to
   * use the app's configured default sender.
   */
  from?: string;
}

/** The outcome handed back to the app. */
export interface ScopedEmailResult {
  ok: boolean;
  /** The resolved sender the message was sent as. */
  from: string;
  recipients: number;
}

function toArray(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

export class ScopedEmail extends WorkerEntrypoint<Env, ScopedEmailProps> {
  #host(): Promise<AppEmailPolicy> {
    return getAgentByName(
      this.env.AppHost,
      this.ctx.props.instance
    ) as unknown as Promise<AppEmailPolicy>;
  }

  /**
   * Send one transactional email. Throws with a clear, app-actionable message if
   * policy rejects the send (bad sender, disallowed recipient, daily cap) or the
   * email service itself errors.
   */
  async send(message: ScopedEmailMessage): Promise<ScopedEmailResult> {
    const to = toArray(message.to);
    const cc = toArray(message.cc);
    const bcc = toArray(message.bcc);
    const recipients = [...to, ...cc, ...bcc];
    if (recipients.length === 0) throw new Error("requestEmail: at least one recipient (to) is required.");
    if (!message.subject) throw new Error("requestEmail: a subject is required.");
    if (!message.html && !message.text) {
      throw new Error("requestEmail: provide html and/or text body.");
    }

    // Policy check + daily-counter reservation (serialized on AppHost).
    const sender = await (await this.#host()).reserveEmail({ from: message.from, recipients });

    try {
      await this.env.EMAIL.send({
        to,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        from: sender.name ? { email: sender.email, name: sender.name } : sender.email,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        ...(message.html ? { html: message.html } : {}),
        ...(message.text ? { text: message.text } : {})
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`requestEmail: send failed${code ? ` (${code})` : ""}: ${msg}`);
    }

    return { ok: true, from: sender.email, recipients: recipients.length };
  }
}
