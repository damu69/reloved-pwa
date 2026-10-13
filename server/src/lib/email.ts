// Sends transactional email through Resend (https://resend.com) when RESEND_API_KEY and EMAIL_FROM are set.
// Without them nothing is sent and the message is only logged (development and the trial).
import type { Config } from "./config.js";

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void>; enabled: boolean }

export function createMailer(cfg: Config, log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }): Mailer {
  const key = cfg.RESEND_API_KEY, from = cfg.EMAIL_FROM;
  if (!key || !from) {
    return { enabled: false, async send(m) { log.info({ to: m.to, subject: m.subject }, "email not sent: no email provider configured"); } };
  }
  return {
    enabled: true,
    async send(m) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) log.error({ status: res.status, to: m.to }, "email provider refused the message");
      } catch (e) {
        log.error({ err: String(e), to: m.to }, "email send failed");
      }
    },
  };
}
