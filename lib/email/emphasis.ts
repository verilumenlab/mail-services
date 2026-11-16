/** A short phrase the model marked for bold, with no line break inside it. */
const MARK_SOURCE = "\\*\\*([^\\*\\n]{1,80})\\*\\*";

function markPattern(): RegExp {
  return new RegExp(MARK_SOURCE, "g");
}

export interface EmphasisPart {
  text: string;
  strong: boolean;
}

/** Body with highlight markers removed, for the plain-text part of the message. */
export function plainBody(body: string): string {
  return body.replace(markPattern(), "$1");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escaped text, then bold markers and links. Raw HTML from the draft never becomes markup. */
function inline(value: string): string {
  const escaped = escapeHtml(value).replace(markPattern(), "<strong>$1</strong>");
  return escaped
    .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:#274efb;text-decoration:none">${url}</a>`)
    .replace(/(^|\s)(www\.[^\s<]+)/g, (_, space: string, url: string) => `${space}<a href="https://${url}" style="color:#274efb;text-decoration:none">${url}</a>`);
}

function isBullet(line: string): boolean {
  return /^(?:[-*•]|->)\s+/.test(line.trim());
}

function bulletText(line: string): string {
  return line.trim().replace(/^(?:[-*•]|->)\s+/, "");
}

const SIGN_OFF = /^(?:(?:best|kind|warm|warmest)\s+)?regards[,.]?$|^sincerely[,.]?$|^yours sincerely[,.]?$/i;

/** A pasted mailbox line, not a sentence of the letter. "to present their work" is a sentence. */
function isMailboxChrome(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 180) return false;
  if (/ago\)/i.test(t) && t.length < 80) return true;
  if (/^[^<>\n]{0,80}<[^>\s>]+@[^>\s>]+>\s*$/.test(t)) return true;
  if (/^(from|to|cc|sent|date)\b/i.test(t) && t.length < 160 && !/[.!?]/.test(t)) {
    const prose = /\b(present|explain|review|submit|complete|prepare|their|work|covering|following|please|must|will|should|after|before|about)\b/i.test(t);
    if (t.split(/\s+/).length <= 8 && !prose) return true;
  }
  if (/<[^>\n]+@[^>\n]+>/.test(t) && /\b(am|pm)\b/i.test(t)) return true;
  return false;
}

function stripMailboxChrome(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isMailboxChrome(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Outgoing plain text: highlight markers and pasted mailbox lines removed. AI checks keep using plainBody. */
export function letterPlain(body: string): string {
  return plainBody(stripMailboxChrome(body));
}

function sectionTitle(line: string): { n?: string; title: string } | null {
  const numbered = line.trim().match(/^(\d+)\.\s+(.*)$/);
  if (numbered) return { n: numbered[1], title: numbered[2].replace(/^\*\*|\*\*$/g, "").trim() };
  const marked = line.trim().match(/^\*\*(.+)\*\*$/);
  if (marked && marked[1].trim().length > 0 && marked[1].trim().length < 90) return { title: marked[1].trim() };
  return null;
}

interface LetterNode {
  kind: "p" | "deadline";
  text: string;
}

interface SectionNode {
  kind: "section";
  n?: string;
  title: string;
  items: string[];
}

type Node = LetterNode | SectionNode;

function signatureStart(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/@|www\./i.test(lines[i])) continue;
    let start = i;
    while (start > 0 && lines[start - 1].trim() && !/^thank you\b/i.test(lines[start - 1].trim())) start--;
    return start;
  }
  return lines.length;
}

function parseLetter(body: string): { greeting: string; nodes: Node[]; signOff: string; signature: string[] } {
  const lines = stripMailboxChrome(body).replace(/\r\n/g, "\n").split("\n");
  const cut = signatureStart(lines);
  let signature = lines.slice(cut).map((line) => line.trim()).filter(Boolean);
  const content = lines.slice(0, cut);
  const nodes: Node[] = [];
  let greeting = "";
  let i = 0;
  while (i < content.length) {
    const text = content[i].trim();
    if (!text) {
      i++;
      continue;
    }
    const section = sectionTitle(text);
    if (section) {
      const items: string[] = [];
      i++;
      while (i < content.length && isBullet(content[i])) {
        items.push(bulletText(content[i]));
        i++;
      }
      nodes.push({ kind: "section", n: section.n, title: section.title, items });
      continue;
    }
    if (isBullet(text)) {
      const items = [bulletText(text)];
      i++;
      while (i < content.length && isBullet(content[i])) {
        items.push(bulletText(content[i]));
        i++;
      }
      nodes.push({ kind: "section", title: "", items });
      continue;
    }
    const paragraph = text;
    i++;
    if (!greeting && /^(dear|hello)\b/i.test(paragraph)) {
      greeting = paragraph;
      continue;
    }
    nodes.push({
      kind: /\bbefore\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(paragraph) && paragraph.length < 240 ? "deadline" : "p",
      text: paragraph,
    });
  }
  let signOff = "";
  if (signature[0] && SIGN_OFF.test(signature[0])) {
    signOff = signature[0];
    signature = signature.slice(1);
  }
  const last = nodes[nodes.length - 1];
  if (!signOff && last?.kind === "p" && SIGN_OFF.test(last.text)) {
    signOff = last.text;
    nodes.pop();
  }
  return { greeting, nodes, signOff, signature };
}

function renderNodes(nodes: Node[]): string {
  return nodes
    .map((node) => {
      if (node.kind !== "section") {
        return node.kind === "deadline"
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;background:#eef2ff;border-radius:12px"><tr><td style="padding:14px 16px;border-left:4px solid #274efb;font-size:15px;line-height:1.5;color:#15203a">${inline(node.text)}</td></tr></table>`
          : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#24324a">${inline(node.text)}</p>`;
      }
      const items = node.items.map((item) => `<li style="margin:0 0 8px">${inline(item)}</li>`).join("");
      const heading = [node.n ? `${node.n}.` : "", node.title].filter(Boolean).join(" ");
      const title = heading ? `<div style="font-size:16px;font-weight:700;color:#15203a;margin:0 0 8px">${inline(heading)}</div>` : "";
      const list = items ? `<ul style="margin:0;padding:0 0 0 18px;color:#33415c;font-size:15px;line-height:1.5">${items}</ul>` : "";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td valign="top">${title}${list}</td></tr></table>`;
    })
    .join("");
}

function renderSignature(lines: string[], signOff: string): string {
  if (!lines.length && !signOff) return "";
  const [name, ...rest] = lines;
  const label = signOff ? `<div style="margin:0 0 8px;font-size:14px;color:#5b6b84">${inline(signOff)}</div>` : "";
  const who = name ? `<div style="font-size:15px;font-weight:700;color:#15203a">${inline(name)}</div>` : "";
  const details = rest.map((line) => `<div style="margin-top:2px">${inline(line)}</div>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;background:#f6f8fc;border-radius:12px"><tr><td style="padding:16px 18px;font-size:14px;line-height:1.5;color:#33415c">${label}${who}${details}</td></tr></table>`;
}

/** Content-ID for the organisation logo when the letter is sent. The preview uses a normal image address. */
export const LETTER_LOGO_CID = "verilumen-logo";

function showsLogo(signature: string[]): boolean {
  return signature.some((line) => /verilumen/i.test(line));
}

function renderHeader(company: string | undefined, logoSrc: string | null): string {
  if (!company && !logoSrc) return `<tr><td style="height:6px;background:#0b1d3a;font-size:0;line-height:0">&nbsp;</td></tr>`;
  const mark = logoSrc
    ? `<td width="72" valign="middle" style="padding-right:14px"><img src="${escapeHtml(logoSrc)}" alt="Verilumen Labs" width="56" height="56" style="display:block;width:56px;height:56px;border:0;border-radius:8px"></td>`
    : "";
  const name = company ? `<td valign="middle" style="font-size:15px;font-weight:700;color:#ffffff">${inline(company)}</td>` : "";
  return `<tr><td style="background:#0b1d3a;padding:18px 28px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${mark}${name}</tr></table></td></tr>`;
}

/** Designed HTML alternative. The body is escaped before any tags are added. */
export function htmlBody(body: string, logoSrc = "/brand/verilumen-logo.png?v=navy"): string {
  const { greeting, nodes, signOff, signature } = parseLetter(body);
  const company = signature.find((line) => /\b(pvt|ltd|labs|inc|llc)\b/i.test(line));
  const header = renderHeader(company, showsLogo(signature) ? logoSrc : null);
  const hello = greeting ? `<p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#15203a">${inline(greeting)}</p>` : "";
  const inner = `${header}<tr><td style="padding:28px">${hello}${renderNodes(nodes)}${renderSignature(signature, signOff)}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5fb"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fb"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e6eaf2;border-radius:16px;font-family:Arial,Helvetica,sans-serif">${inner}</table></td></tr></table></body></html>`;
}

/** Splits a body into text and bold runs for a React preview. Markers are not treated as HTML. */
export function emphasisParts(body: string): EmphasisPart[] {
  const parts: EmphasisPart[] = [];
  const re = markPattern();
  let last = 0;
  for (let match = re.exec(body); match; match = re.exec(body)) {
    if (match.index > last) parts.push({ text: body.slice(last, match.index), strong: false });
    parts.push({ text: match[1] ?? "", strong: true });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), strong: false });
  if (!parts.length) parts.push({ text: body, strong: false });
  return parts;
}
