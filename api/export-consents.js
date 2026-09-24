const { timingSafeEqual } = require("node:crypto");

const PAGE_SIZE = 1_000;
const MAX_ROWS = 100_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTACHMENT_BASE64_BYTES = 35 * 1024 * 1024;
const REPORT_TIME_ZONE = "Asia/Tbilisi";
const BRAND_ORDER = ["magniti", "kalata", "spar", "daily"];
const PHONE_PATTERN = /^\+9955[0-9]{8}$/;

class ReportError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.name = "ReportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function secretsMatch(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isAuthorized(req, cronSecret) {
  const authorization = String(getHeader(req, "authorization") || "");
  return secretsMatch(authorization, `Bearer ${cronSecret}`);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadConsents(supabaseUrl, supabaseSecretKey, cutoffIso) {
  const rows = [];
  let lastId = null;

  while (rows.length < MAX_ROWS) {
    const endpoint = new URL("/rest/v1/consents", supabaseUrl);
    endpoint.searchParams.set(
      "select",
      "id,phone,brand,consent_version,created_at",
    );
    endpoint.searchParams.set("created_at", `lt.${cutoffIso}`);
    endpoint.searchParams.set("order", "id.asc");
    endpoint.searchParams.set("limit", String(PAGE_SIZE));
    if (lastId !== null) {
      endpoint.searchParams.set("id", `gt.${lastId}`);
    }

    const response = await fetchWithTimeout(endpoint, {
      headers: {
        apikey: supabaseSecretKey,
        Accept: "application/json",
        "User-Agent": "Number-weekly-report/1.0",
      },
    });

    if (!response.ok) {
      throw new ReportError("supabase_request_failed", response.status);
    }

    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new ReportError("supabase_response_invalid");
    }

    if (page.length === 0) {
      return rows;
    }

    for (const row of page) {
      const id = String(row.id ?? "");
      if (!/^[1-9][0-9]*$/.test(id)) {
        throw new ReportError("invalid_consent_id");
      }
      if (lastId !== null && BigInt(id) <= BigInt(lastId)) {
        throw new ReportError("consent_order_invalid");
      }
      lastId = id;
    }

    if (rows.length + page.length > MAX_ROWS) {
      throw new ReportError("report_row_limit_exceeded");
    }
    rows.push(...page);
  }

  throw new ReportError("report_row_limit_exceeded");
}

function formatDateParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function formatTbilisiTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid_created_at");
  }

  const parts = formatDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function reportDate(value = new Date()) {
  const parts = formatDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reportCutoff(value = new Date()) {
  const parts = formatDateParts(value);
  const localHourAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
  );

  // Georgia has used UTC+4 year-round since 2005. Freezing the snapshot at the
  // start of the current Tbilisi hour makes duplicate cron calls byte-stable.
  return new Date(localHourAsUtc - 4 * 60 * 60 * 1_000);
}

function quoteCsv(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function safeCsvText(value) {
  const text = String(value ?? "");
  return quoteCsv(/^[\s]*[=+\-@]/.test(text) ? `'${text}` : text);
}

function buildCsv(rows) {
  const lines = [
    ["phone", "brand", "consent_version", "created_at_tbilisi"]
      .map(quoteCsv)
      .join(","),
  ];

  for (const row of rows) {
    if (
      !PHONE_PATTERN.test(String(row.phone || "")) ||
      !BRAND_ORDER.includes(row.brand) ||
      typeof row.consent_version !== "string"
    ) {
      throw new Error("invalid_consent_row");
    }

    // The phone is strictly validated above, so this fixed Excel formula cannot
    // contain user-controlled syntax and preserves the leading plus as text.
    const excelPhone = `="${row.phone}"`;
    lines.push(
      [
        quoteCsv(excelPhone),
        safeCsvText(row.brand),
        safeCsvText(row.consent_version),
        safeCsvText(formatTbilisiTimestamp(row.created_at)),
      ].join(","),
    );
  }

  // UTF-8 BOM makes Georgian text open correctly when the CSV is double-clicked
  // in Microsoft Excel.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function countByBrand(rows) {
  return Object.fromEntries(
    BRAND_ORDER.map((brand) => [
      brand,
      rows.filter((row) => row.brand === brand).length,
    ]),
  );
}

function buildEmailHtml(date, counts, total) {
  const list = BRAND_ORDER.map(
    (brand) => `<li><strong>${brand}</strong>: ${counts[brand]}</li>`,
  ).join("");

  return [
    "<p>გამარჯობა,</p>",
    `<p>მიმაგრებულია SMS თანხმობების სრული ანგარიში ${date}-ის მდგომარეობით.</p>`,
    `<p><strong>სულ ჩანაწერი:</strong> ${total}</p>`,
    `<ul>${list}</ul>`,
    "<p>ფაილი UTF-8 CSV ფორმატშია და Microsoft Excel-ში პირდაპირ იხსნება.</p>",
  ].join("");
}

async function sendReport({
  resendApiKey,
  fromEmail,
  toEmail,
  date,
  rows,
  csv,
  periodKey,
}) {
  const counts = countByBrand(rows);
  const attachmentContent = Buffer.from(csv, "utf8").toString("base64");
  if (Buffer.byteLength(attachmentContent, "ascii") > MAX_ATTACHMENT_BASE64_BYTES) {
    throw new ReportError("report_attachment_too_large");
  }

  const response = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `number-consents-${periodKey}`,
      "User-Agent": "Number-weekly-report/1.0",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject: `SMS თანხმობების ანგარიში — ${date}`,
      html: buildEmailHtml(date, counts, rows.length),
      attachments: [
        {
          filename: `sms-consents-${date}.csv`,
          content: attachmentContent,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new ReportError("resend_request_failed", response.status);
  }
}

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("CRON_SECRET is not configured for the weekly report.");
    return sendJson(res, 503, { ok: false, error: "service_unavailable" });
  }

  if (!isAuthorized(req, cronSecret)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const config = {
    supabaseUrl: String(process.env.SUPABASE_URL || "").replace(/\/$/, ""),
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
    toEmail: process.env.REPORT_TO_EMAIL,
    fromEmail:
      process.env.REPORT_FROM_EMAIL ||
      "Number Reports <onboarding@resend.dev>",
  };

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    console.error("Weekly report environment is incomplete.", { missing });
    return sendJson(res, 503, { ok: false, error: "service_unavailable" });
  }

  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(config.supabaseUrl);
    if (parsedSupabaseUrl.protocol !== "https:") {
      throw new Error("invalid_protocol");
    }
  } catch {
    console.error("SUPABASE_URL is invalid for the weekly report.");
    return sendJson(res, 503, { ok: false, error: "service_unavailable" });
  }

  try {
    const cutoff = reportCutoff();
    const cutoffIso = cutoff.toISOString();
    const cutoffParts = formatDateParts(cutoff);
    const periodKey = `${cutoffParts.year}-${cutoffParts.month}-${cutoffParts.day}-${cutoffParts.hour}`;
    const rows = await loadConsents(
      parsedSupabaseUrl.origin,
      config.supabaseSecretKey,
      cutoffIso,
    );
    const date = reportDate(cutoff);
    const csv = buildCsv(rows);

    await sendReport({
      resendApiKey: config.resendApiKey,
      fromEmail: config.fromEmail,
      toEmail: config.toEmail,
      date,
      rows,
      csv,
      periodKey,
    });

    return sendJson(res, 200, {
      ok: true,
      rows: rows.length,
      date,
      cutoff: cutoffIso,
    });
  } catch (error) {
    const reason =
      error instanceof ReportError
        ? error.code
        : error?.name === "AbortError"
          ? "upstream_timeout"
          : "unexpected_error";
    console.error("Weekly consent report failed.", {
      reason,
      status:
        error instanceof ReportError && Number(error.statusCode)
          ? Number(error.statusCode)
          : undefined,
    });
    return sendJson(res, 502, { ok: false, error: "report_failed" });
  }
};

module.exports._test = {
  buildCsv,
  countByBrand,
  formatTbilisiTimestamp,
  reportCutoff,
  reportDate,
  secretsMatch,
};
