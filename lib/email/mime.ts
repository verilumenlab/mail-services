import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidEmail } from "@/lib/csv/validate";
import { htmlBody, LETTER_LOGO_CID, letterPlain } from "./emphasis";
import type { OutgoingEmail } from "./provider";

/** Removes CR/LF and other control characters to prevent header injection. */
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\u0000-\u001F\u007F]+/g, " ").trim();
}

function encodeWord(value: string): string {
  const clean = sanitizeHeader(value);
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function formatAddress(email: string, name?: string | null): string {
  const addr = sanitizeHeader(email);
  if (!name) return addr;
  const display = sanitizeHeader(name).replace(/["\\]/g, "");
  if (!display) return addr;
  const encoded = encodeWord(display);
  return encoded === display ? `"${display}" <${addr}>` : `${encoded} <${addr}>`;
}

function wrapBase64(b64: string): string {
  return b64.replace(/.{1,76}/g, (m) => `${m}\r\n`).trimEnd();
}

function encodedPart(contentType: string, body: string): string {
  return [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64", "", wrapBase64(Buffer.from(body, "utf8").toString("base64"))].join("\r\n");
}

function alternativeEntity(plain: string, html: string): { contentType: string; entity: string } {
  const boundary = `----=_SortsAlt_${randomBytes(8).toString("hex")}`;
  const entity = [
    `--${boundary}\r\n${encodedPart('text/plain; charset="UTF-8"', plain)}\r\n`,
    `--${boundary}\r\n${encodedPart('text/html; charset="UTF-8"', html)}\r\n`,
    `--${boundary}--`,
  ].join("");
  return { contentType: `multipart/alternative; boundary="${boundary}"`, entity };
}

function logoPart(): string {
  const png = readFileSync(join(process.cwd(), "public", "brand", "verilumen-logo.png"));
  return [
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${LETTER_LOGO_CID}>`,
    'Content-Disposition: inline; filename="logo.png"',
    "",
    wrapBase64(png.toString("base64")),
  ].join("\r\n");
}

/** Plain text plus the designed HTML. A Verilumen letter also carries the logo inline. */
function messageEntity(source: string): { contentType: string; entity: string } {
  const plain = letterPlain(source).replace(/\r?\n/g, "\r\n");
  const html = htmlBody(source, `cid:${LETTER_LOGO_CID}`).replace(/\n/g, "\r\n");
  const alternative = alternativeEntity(plain, html);
  if (!html.includes(`cid:${LETTER_LOGO_CID}`)) return alternative;
  const boundary = `----=_SortsRel_${randomBytes(8).toString("hex")}`;
  const entity = [
    `--${boundary}\r\nContent-Type: ${alternative.contentType}\r\n\r\n${alternative.entity}\r\n`,
    `--${boundary}\r\n${logoPart()}\r\n`,
    `--${boundary}--`,
  ].join("");
  return { contentType: `multipart/related; boundary="${boundary}"`, entity };
}

function attachmentPart(file: NonNullable<OutgoingEmail["attachments"]>[number]): string {
  const ascii = file.filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return [
    `Content-Type: ${file.contentType}`,
    `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(file.content.toString("base64")),
  ].join("\r\n");
}

/** Builds an RFC 5322 UTF-8 message: plain text plus HTML, with a mixed wrapper when files are attached. */
export function buildMimeMessage(msg: OutgoingEmail): string {
  if (!isValidEmail(msg.to)) throw new Error(`Invalid recipient address: ${msg.to}`);
  if (!isValidEmail(msg.from.email)) throw new Error("Invalid sender address");
  const cc = (msg.cc ?? []).filter((a) => a.toLowerCase() !== msg.to.toLowerCase());
  const badCc = cc.find((a) => !isValidEmail(a));
  if (badCc) throw new Error(`Invalid CC address: ${badCc}`);
  const alternative = msg.html ? alternativeEntity(msg.body.replace(/\r?\n/g, "\r\n"), msg.html.replace(/\r?\n/g, "\r\n")) : messageEntity(msg.body);
  const files = (msg.attachments ?? []).filter((f) => f.content.length > 0);
  const headers = [
    `From: ${formatAddress(msg.from.email, msg.from.name)}`,
    `To: ${formatAddress(msg.to)}`,
    ...(cc.length ? [`Cc: ${cc.map((a) => formatAddress(a)).join(", ")}`] : []),
    `Subject: ${encodeWord(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  if (!files.length) {
    headers.push(`Content-Type: ${alternative.contentType}`);
    return `${headers.join("\r\n")}\r\n\r\n${alternative.entity}\r\n`;
  }
  const boundary = `----=_Sorts_${randomBytes(12).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const altPart = `Content-Type: ${alternative.contentType}\r\n\r\n${alternative.entity}`;
  const parts = [altPart, ...files.map(attachmentPart)].map((part) => `--${boundary}\r\n${part}\r\n`).join("");
  return `${headers.join("\r\n")}\r\n\r\n${parts}--${boundary}--\r\n`;
}
