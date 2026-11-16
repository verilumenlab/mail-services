export const CONSENT_VERSION = "2026-11";

/** Shown to every signer and stored with their consent, so the exact wording they agreed to is on record. */
export const CONSENT_TEXT =
  "I agree to use electronic records and signatures for this document. I have reviewed the document, " +
  "I am the person named in this signing request, and I intend my electronic signature to have the same " +
  "effect as a handwritten signature. I understand that this is an electronic signature, not a " +
  "certificate-based digital signature, unless the completion certificate states otherwise.";

export const SIGNATURE_LEVEL_LABEL: Record<string, string> = {
  electronic: "Electronic signature (email OTP verified)",
};

export function signatureLevelLabel(level: string): string {
  return SIGNATURE_LEVEL_LABEL[level] ?? `Certificate-based digital signature (${level})`;
}
