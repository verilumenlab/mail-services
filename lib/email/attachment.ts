/** One file sent unchanged with every email of a campaign. Pure: no I/O. */

export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
};

export interface PreparedAttachment {
  filename: string;
  contentType: string;
  size: number;
}

/** Checks the name and size. The stored type comes from the extension, not the browser. */
export function prepareAttachment(filename: string, size: number): PreparedAttachment {
  if (size < 1) throw new Error("The file is empty.");
  if (size > ATTACHMENT_MAX_BYTES) throw new Error("The file is larger than 100 MB.");
  const base = (filename.split(/[/\\]/).pop() ?? "").replace(/[\r\n\u0000-\u001F\u007F"]/g, " ").replace(/\s+/g, " ").trim();
  if (!base) throw new Error("The file needs a name.");
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return { filename: base.slice(0, 180), contentType: CONTENT_TYPES[ext] ?? "application/octet-stream", size };
}
