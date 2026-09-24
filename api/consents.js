const { createHash } = require("node:crypto");

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const CONSENT_VERSION = "magniti-sms-v1";

// Best-effort protection for warm function instances. The unique database
// constraint is the durable protection against repeated submissions.
const rateLimitBuckets =
  globalThis.__magnitiConsentRateLimitBuckets ||
  (globalThis.__magnitiConsentRateLimitBuckets = new Map());

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function setResponseHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Vary", "Origin");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

function isSameOrigin(req) {
  const origin = getHeader(req, "origin");
  const fetchSite = getHeader(req, "sec-fetch-site");

  if (!origin) {
    return fetchSite !== "cross-site";
  }

  const host = String(
    getHeader(req, "x-forwarded-host") || getHeader(req, "host") || "",
  )
    .split(",")[0]
    .trim()
    .toLowerCase();
  const protocol = String(
    getHeader(req, "x-forwarded-proto") ||
      (req.socket?.encrypted ? "https" : "http"),
  )
    .split(",")[0]
    .trim()
    .toLowerCase();

  try {
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

function getRateLimitKey(req) {
  const ip = String(
    getHeader(req, "x-vercel-forwarded-for") ||
      getHeader(req, "x-forwarded-for") ||
      req.socket?.remoteAddress ||
      "unknown",
  )
    .split(",")[0]
    .trim();

  return createHash("sha256").update(ip).digest("hex").slice(0, 24);
}

function isRateLimited(req) {
  const now = Date.now();
  const key = getRateLimitKey(req);
  const recentRequests = (rateLimitBuckets.get(key) || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitBuckets.set(key, recentRequests);
    return true;
  }

  recentRequests.push(now);
  rateLimitBuckets.set(key, recentRequests);

  // Bound memory use if an instance receives traffic from many addresses.
  if (rateLimitBuckets.size > 1_000) {
    for (const [bucketKey, timestamps] of rateLimitBuckets) {
      if (!timestamps.some((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)) {
        rateLimitBuckets.delete(bucketKey);
      }
    }
  }

  return false;
}

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    if (Buffer.byteLength(JSON.stringify(req.body), "utf8") > 1_024) {
      throw new Error("invalid_body");
    }
    return req.body;
  }

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : String(req.body || "");

  if (!rawBody || Buffer.byteLength(rawBody, "utf8") > 1_024) {
    throw new Error("invalid_body");
  }

  return JSON.parse(rawBody);
}

function normalizeGeorgianMobile(value) {
  if (typeof value !== "string" || value.length > 32) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  const localNumber = digits.startsWith("995") ? digits.slice(3) : digits;

  return /^5\d{8}$/.test(localNumber) ? `+995${localNumber}` : null;
}

module.exports = async function handler(req, res) {
  setResponseHeaders(res);

  if (!isSameOrigin(req)) {
    return sendJson(res, 403, { ok: false, error: "forbidden_origin" });
  }

  const origin = getHeader(req, "origin");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const contentType = String(getHeader(req, "content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const contentLength = Number(getHeader(req, "content-length") || 0);

  if (contentType !== "application/json" || contentLength > 1_024) {
    return sendJson(res, 415, { ok: false, error: "invalid_request" });
  }

  if (isRateLimited(req)) {
    res.setHeader("Retry-After", "60");
    return sendJson(res, 429, { ok: false, error: "too_many_requests" });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  // Honeypot field: real users leave it empty. Return a generic success so
  // automated form fillers do not learn how the filter works.
  if (typeof body.website === "string" && body.website.trim()) {
    return sendJson(res, 201, { ok: true });
  }

  const phone = normalizeGeorgianMobile(body.phone);
  if (!phone) {
    return sendJson(res, 400, { ok: false, error: "invalid_phone" });
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    console.error("Supabase environment variables are not configured.");
    return sendJson(res, 503, { ok: false, error: "service_unavailable" });
  }

  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
    if (parsedSupabaseUrl.protocol !== "https:") {
      throw new Error("Supabase URL must use HTTPS");
    }
  } catch {
    console.error("SUPABASE_URL is invalid.");
    return sendJson(res, 503, { ok: false, error: "service_unavailable" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(
      `${parsedSupabaseUrl.origin}/rest/v1/consents?on_conflict=phone%2Cconsent_version`,
      {
        method: "POST",
        headers: {
          apikey: supabaseSecretKey,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal",
          "User-Agent": "Magniti-consent-api/1.0",
        },
        body: JSON.stringify({
          phone,
          consent_version: CONSENT_VERSION,
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      let errorCode = "unknown";
      try {
        const errorBody = await response.json();
        errorCode = String(errorBody.code || "unknown").slice(0, 32);
      } catch {
        // Avoid returning or logging response bodies that might contain data.
      }

      console.error("Supabase consent insert failed.", {
        status: response.status,
        code: errorCode,
      });
      return sendJson(res, 502, { ok: false, error: "storage_failed" });
    }

    return sendJson(res, 201, { ok: true });
  } catch (error) {
    console.error("Supabase consent request failed.", {
      reason: error?.name === "AbortError" ? "timeout" : "network_error",
    });
    return sendJson(res, 502, { ok: false, error: "storage_failed" });
  } finally {
    clearTimeout(timeout);
  }
};
