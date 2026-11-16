import "server-only";
import { AppError } from "@/lib/errors";

/** Sends one-time codes by SMS. Off unless ESIGN_SMS_PROVIDER and the provider's credentials are set. */
export interface SmsProvider {
  readonly name: string;
  sendOtp(toE164: string, code: string, context: { documentTitle: string }): Promise<void>;
}

class TwilioSms implements SmsProvider {
  readonly name = "twilio";
  constructor(private sid: string, private token: string, private from: string) {}

  async sendOtp(to: string, code: string, context: { documentTitle: string }) {
    const body = new URLSearchParams({ To: to, From: this.from, Body: `${code} is your code to sign "${context.documentTitle.slice(0, 60)}". It expires in 10 minutes.` });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new AppError("PROVIDER_ERROR", `The SMS could not be sent (Twilio HTTP ${res.status}).`);
  }
}

/** MSG91 Flow API; the template must contain an ##otp## variable (DLT-registered in India). */
class Msg91Sms implements SmsProvider {
  readonly name = "msg91";
  constructor(private authKey: string, private templateId: string) {}

  async sendOtp(to: string, code: string) {
    const res = await fetch("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: { authkey: this.authKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ template_id: this.templateId, short_url: "0", recipients: [{ mobiles: to.replace(/^\+/, ""), otp: code }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as { type?: string } | null;
    if (!res.ok || data?.type === "error") throw new AppError("PROVIDER_ERROR", `The SMS could not be sent (MSG91 HTTP ${res.status}).`);
  }
}

export function smsProvider(): SmsProvider | null {
  const kind = process.env.ESIGN_SMS_PROVIDER?.trim().toLowerCase();
  if (kind === "twilio") {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    return sid && token && from ? new TwilioSms(sid, token, from) : null;
  }
  if (kind === "msg91") {
    const { MSG91_AUTH_KEY: key, MSG91_TEMPLATE_ID: template } = process.env;
    return key && template ? new Msg91Sms(key, template) : null;
  }
  return null;
}

export function smsAvailable(): boolean {
  return smsProvider() !== null;
}
