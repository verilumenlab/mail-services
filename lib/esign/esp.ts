import "server-only";
import { createVerify, randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";

/**
 * Aadhaar / DSC eSign through a CCA-empanelled eSign Service Provider (for example eMudhra or Protean).
 *
 * Flow (eSign API 2.1+): the app hashes the document, posts a signed <Esign> request XML to the ESP gateway
 * in the signer's browser, the signer authenticates with the ESP (Aadhaar OTP/biometric), and the ESP posts a
 * signed <EsignResp> back to the callback with a PKCS#7 signature over the hash, which is embedded in the PDF.
 *
 * This module defines the contract and the request/response plumbing. It stays disabled until an ESP
 * agreement exists and ESIGN_ESP_* credentials are configured; signing XML requests needs the ASP's key.
 */
export interface EsignProvider {
  readonly name: string;
  /** Builds the form the signer's browser auto-posts to the ESP gateway. */
  buildRequest(input: { documentSha256: string; signerName: string; transactionId: string; callbackUrl: string }): Promise<{ gatewayUrl: string; fields: Record<string, string> }>;
  /** Verifies the ESP's signed callback and returns the detached PKCS#7 signature for the document hash. */
  verifyResponse(xml: string, expected: { transactionId: string; documentSha256: string }): Promise<{ pkcs7: Buffer; signerCertificate: string }>;
}

interface EspConfig {
  name: string;
  gatewayUrl: string;
  aspId: string;
  /** PEM private key of the ASP (us) for signing request XML. */
  aspPrivateKeyPem: string;
  /** PEM certificate of the ESP for verifying responses. */
  espCertificatePem: string;
}

function xmlEscape(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

class CcaEspAdapter implements EsignProvider {
  readonly name: string;
  constructor(private cfg: EspConfig) {
    this.name = cfg.name;
  }

  async buildRequest(input: { documentSha256: string; signerName: string; transactionId: string; callbackUrl: string }): Promise<{ gatewayUrl: string; fields: Record<string, string> }> {
    const ts = new Date().toISOString().slice(0, 19);
    const unsigned =
      `<Esign ver="2.1" sc="Y" ts="${ts}" txn="${xmlEscape(input.transactionId)}" ekycIdType="A" aspId="${xmlEscape(this.cfg.aspId)}" AuthMode="1" responseSigType="pkcs7" responseUrl="${xmlEscape(input.callbackUrl)}">` +
      `<Docs><InputHash id="1" hashAlgorithm="SHA256" docInfo="${xmlEscape(input.signerName)}">${input.documentSha256}</InputHash></Docs></Esign>`;
    // An enveloped XML-DSig over `unsigned` with the ASP key is required by every ESP. It is ESP-specific
    // (canonicalisation and certificate chain), so it is completed during ESP onboarding.
    void unsigned;
    throw new AppError("NOT_CONFIGURED", `${this.name}: XML request signing must be completed with the ESP's onboarding kit before Aadhaar eSign can be used.`);
  }

  async verifyResponse(xml: string, expected: { transactionId: string; documentSha256: string }) {
    const txn = /<EsignResp[^>]*\stxn="([^"]+)"/.exec(xml)?.[1];
    const status = /<EsignResp[^>]*\sstatus="([^"]+)"/.exec(xml)?.[1];
    if (txn !== expected.transactionId) throw new AppError("FORBIDDEN", "eSign response does not match this transaction.");
    if (status !== "1") throw new AppError("VALIDATION", "The eSign provider reported that signing did not complete.");
    const sigValue = /<SignatureValue>([^<]+)<\/SignatureValue>/.exec(xml)?.[1];
    const signedInfo = /<SignedInfo[\s\S]*?<\/SignedInfo>/.exec(xml)?.[0];
    if (!sigValue || !signedInfo) throw new AppError("FORBIDDEN", "eSign response is not signed.");
    const ok = createVerify("RSA-SHA256").update(signedInfo).verify(this.cfg.espCertificatePem, sigValue, "base64");
    if (!ok) throw new AppError("FORBIDDEN", "eSign response signature is invalid.");
    const pkcs7 = /<DocSignature[^>]*>([^<]+)<\/DocSignature>/.exec(xml)?.[1];
    const cert = /<UserX509Certificate>([^<]+)<\/UserX509Certificate>/.exec(xml)?.[1];
    if (!pkcs7 || !cert) throw new AppError("VALIDATION", "eSign response is missing the document signature.");
    return { pkcs7: Buffer.from(pkcs7, "base64"), signerCertificate: cert };
  }
}

/** ESIGN_ESP_NAME, ESIGN_ESP_GATEWAY_URL, ESIGN_ESP_ASP_ID, ESIGN_ESP_ASP_KEY_PEM, ESIGN_ESP_CERT_PEM. */
export function configuredEsignProvider(): EsignProvider | null {
  const e = process.env;
  if (!e.ESIGN_ESP_GATEWAY_URL || !e.ESIGN_ESP_ASP_ID || !e.ESIGN_ESP_ASP_KEY_PEM || !e.ESIGN_ESP_CERT_PEM) return null;
  return new CcaEspAdapter({
    name: e.ESIGN_ESP_NAME?.trim() || "eSign Service Provider",
    gatewayUrl: e.ESIGN_ESP_GATEWAY_URL,
    aspId: e.ESIGN_ESP_ASP_ID,
    aspPrivateKeyPem: e.ESIGN_ESP_ASP_KEY_PEM.replace(/\\n/g, "\n"),
    espCertificatePem: e.ESIGN_ESP_CERT_PEM.replace(/\\n/g, "\n"),
  });
}

export function newEspTransactionId(): string {
  return `SORTS-${randomUUID()}`;
}
