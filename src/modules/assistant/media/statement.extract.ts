import { fileTypeFromBuffer } from "file-type";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { AppError } from "../../../utils/errors.js";
import { ocrDocument } from "../../../lib/deepseek.js";

export type StatementSource = "PDF" | "CSV" | "XLSX";

export type ExtractedRow = {
  date: string;
  amount: number;
  type: "EXPENSE" | "INCOME";
  description: string;
  confidence: number;
};

export type StatementExtraction = {
  source: StatementSource;
  pages: number | null;
  rows: ExtractedRow[];
  textChunks: string[];
  method: "TABLE" | "PDF_TEXT" | "OCR";
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function parseStatementDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }

  if (typeof value === "number" && value > 20_000 && value < 80_000) {
    // Excel serial date (days since 1899-12-30).
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return buildDate(year, Number(match[2]), Number(match[1]));
  }

  match = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})/);
  if (match) {
    const month = MONTHS[match[2]!.toLowerCase()];
    if (month) {
      let year = Number(match[3]);
      if (year < 100) year += year < 70 ? 2000 : 1900;
      return buildDate(year, month, Number(match[1]));
    }
  }

  match = text.match(/^([A-Za-z]{3,9})[-\s](\d{1,2}),?[-\s](\d{2,4})/);
  if (match) {
    const month = MONTHS[match[1]!.toLowerCase()];
    if (month) {
      let year = Number(match[3]);
      if (year < 100) year += year < 70 ? 2000 : 1900;
      return buildDate(year, month, Number(match[2]));
    }
  }

  return null;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseStatementAmount(value: unknown): { amount: number; direction: "DEBIT" | "CREDIT" | null } | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0
      ? { amount: Math.abs(value), direction: value < 0 ? "DEBIT" : "CREDIT" }
      : null;
  }
  if (typeof value !== "string") return null;

  let text = value.trim();
  if (!text) return null;

  let direction: "DEBIT" | "CREDIT" | null = null;
  if (/\b(dr|debit|withdrawal)\b/i.test(text)) direction = "DEBIT";
  if (/\b(cr|credit|deposit)\b/i.test(text)) direction = "CREDIT";
  if (/^\(.*\)$/.test(text)) direction = "DEBIT";

  const negative = /^-/.test(text) || /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[₹$,\s()]/g, "").replace(/[A-Za-z]+/g, "");
  if (!cleaned || !/^\d+(?:\.\d+)?$/.test(cleaned)) return null;

  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    amount: Math.round(amount * 100) / 100,
    direction: direction ?? (negative ? "DEBIT" : null),
  };
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function headerKind(header: string): "date" | "description" | "debit" | "credit" | "amount" | "balance" | null {
  if (/(date|dt)$/.test(header) || header.includes("valuedate") || header.includes("txndate")) return "date";
  if (/(description|narration|particular|detail|remark|transaction)/.test(header) && !header.includes("amount")) {
    return "description";
  }
  if (/(debit|withdraw|^dr)/.test(header)) return "debit";
  if (/(credit|deposit|^cr)/.test(header)) return "credit";
  if (header.includes("balance")) return "balance";
  if (header.includes("amount")) return "amount";
  return null;
}

export function parseTableRows(rows: unknown[][]): ExtractedRow[] {
  let headerIndex = -1;
  const columns: Partial<Record<"date" | "description" | "debit" | "credit" | "amount" | "balance", number>> = {};

  for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
    const row = rows[index] ?? [];
    const found: typeof columns = {};
    row.forEach((cell, columnIndex) => {
      const kind = headerKind(normalizeHeader(cell));
      if (kind && found[kind] === undefined) found[kind] = columnIndex;
    });

    if (found.date !== undefined && (found.debit !== undefined || found.credit !== undefined || found.amount !== undefined)) {
      headerIndex = index;
      Object.assign(columns, found);
      break;
    }
  }

  if (headerIndex === -1) return [];

  const result: ExtractedRow[] = [];
  let emptyRun = 0;

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (row.every((cell) => String(cell ?? "").trim() === "")) {
      emptyRun += 1;
      if (emptyRun > 10) break;
      continue;
    }
    emptyRun = 0;

    const date = columns.date !== undefined ? parseStatementDate(row[columns.date]) : null;
    if (!date) continue;

    const debit = columns.debit !== undefined ? parseStatementAmount(row[columns.debit]) : null;
    const credit = columns.credit !== undefined ? parseStatementAmount(row[columns.credit]) : null;
    const generic = columns.amount !== undefined ? parseStatementAmount(row[columns.amount]) : null;

    let amount: number | null = null;
    let type: "EXPENSE" | "INCOME" | null = null;
    let confidence = 0.95;

    if (debit?.amount) {
      amount = debit.amount;
      type = "EXPENSE";
    } else if (credit?.amount) {
      amount = credit.amount;
      type = "INCOME";
    } else if (generic?.amount) {
      amount = generic.amount;
      // Without a sign or Dr/Cr marker, treat an "Amount" column as an expense.
      // The review queue lets the user flip it before importing.
      type = generic.direction === "CREDIT" ? "INCOME" : "EXPENSE";
      confidence = generic.direction ? 0.9 : 0.6;
    }

    if (!amount || !type) continue;

    const description =
      columns.description !== undefined
        ? String(row[columns.description] ?? "").replace(/\s+/g, " ").trim().slice(0, 300)
        : row
            .filter((_, columnIndex) => columnIndex !== columns.date && columnIndex !== columns.debit && columnIndex !== columns.credit && columnIndex !== columns.amount && columnIndex !== columns.balance)
            .map((cell) => String(cell ?? "").trim())
            .filter(Boolean)
            .join(" ")
            .slice(0, 300);

    result.push({ date, amount, type, description, confidence });
  }

  return result;
}

async function extractCsv(buffer: Buffer): Promise<unknown[][]> {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  return parseCsv(text, {
    relaxColumnCount: true,
    skipEmptyLines: false,
    relaxQuotes: true,
  }) as unknown[][];
}

async function extractXlsx(buffer: Buffer): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      if (value && typeof value === "object" && "result" in value) {
        values.push((value as { result?: unknown }).result ?? null);
      } else if (value && typeof value === "object" && "richText" in value) {
        values.push((value as { richText: Array<{ text: string }> }).richText.map((part) => part.text).join(""));
      } else {
        values.push(value);
      }
    });
    rows.push(values);
  });
  return rows;
}

export async function extractPdfText(buffer: Buffer): Promise<{ pages: string[]; text: string }> {
  // Legacy build works in Node without a DOM worker.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if ("str" in item) {
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
    }
    pages.push(text.replace(/[ \t]+/g, " ").trim());
  }

  return { pages, text: pages.join("\n\n") };
}

export async function extractStatement(
  buffer: Buffer,
  filename: string,
): Promise<StatementExtraction> {
  const detected = await fileTypeFromBuffer(buffer);
  const lower = filename.toLowerCase();
  const isCsv = lower.endsWith(".csv") || detected?.mime === "text/csv";
  const isXlsx = lower.endsWith(".xlsx") || detected?.mime.includes("spreadsheetml") === true;
  const isPdf = lower.endsWith(".pdf") || detected?.mime === "application/pdf";

  if (lower.endsWith(".xls")) {
    throw new AppError(415, "Please save old .xls statements as .xlsx or CSV and try again.");
  }

  if (isCsv) {
    const table = await extractCsv(buffer);
    const rows = parseTableRows(table);
    return {
      source: "CSV",
      pages: null,
      rows,
      textChunks: rows.length > 0 ? [] : [tableToText(table)],
      method: rows.length > 0 ? "TABLE" : "PDF_TEXT",
    };
  }

  if (isXlsx) {
    const table = await extractXlsx(buffer);
    const rows = parseTableRows(table);
    return {
      source: "XLSX",
      pages: null,
      rows,
      textChunks: rows.length > 0 ? [] : [tableToText(table)],
      method: rows.length > 0 ? "TABLE" : "PDF_TEXT",
    };
  }

  if (isPdf) {
    let pdf: { pages: string[]; text: string };
    try {
      pdf = await extractPdfText(buffer);
    } catch {
      pdf = { pages: [], text: "" };
    }

    const usable = pdf.pages.length > 0 && pdf.text.length > 200 && /\d/.test(pdf.text);
    if (usable) {
      return {
        source: "PDF",
        pages: pdf.pages.length,
        rows: [],
        textChunks: chunkPages(pdf.pages),
        method: "PDF_TEXT",
      };
    }

    const ocr = await ocrDocument(buffer, filename, "application/pdf");
    return {
      source: "PDF",
      pages: ocr.pageCount,
      rows: [],
      textChunks: chunkPages(ocr.pages),
      method: "OCR",
    };
  }

  throw new AppError(415, "Upload a PDF, CSV or XLSX bank statement.");
}

function tableToText(rows: unknown[][]): string {
  return rows
    .slice(0, 1_500)
    .map((row) => row.map((cell) => String(cell ?? "").trim()).join(" | "))
    .join("\n")
    .slice(0, 60_000);
}

export function chunkPages(pages: string[], maxChars = 6_000): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const page of pages) {
    const lines = page.split(/\n+/);
    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > maxChars && current.length > 0) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
  }

  if (current.trim()) chunks.push(current);
  return chunks;
}
