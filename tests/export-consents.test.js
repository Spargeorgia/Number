const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const handler = require("../api/export-consents.js");
const {
  buildCsv,
  formatTbilisiTimestamp,
  reportCutoff,
  secretsMatch,
} = handler._test;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

function setValidEnvironment() {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.CRON_SECRET = "cron-secret-at-least-16";
  process.env.RESEND_API_KEY = "re_test";
  process.env.REPORT_TO_EMAIL = "reports@example.com";
  process.env.REPORT_FROM_EMAIL = "Reports <reports@example.com>";
}

function request({ method = "GET", authorization } = {}) {
  return {
    method,
    headers: authorization ? { authorization } : {},
  };
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value = "") {
      this.body = value;
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
});

test("CSV is Excel-safe, Georgian-compatible, and uses Tbilisi time", () => {
  const csv = buildCsv([
    {
      id: 1,
      phone: "+995577045785",
      brand: "daily",
      consent_version: "=formula-like-value",
      created_at: "2026-09-24T06:47:02.000Z",
    },
  ]);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /\r\n$/);
  assert.match(csv, /"=""\+995577045785"""/);
  assert.match(csv, /"'=formula-like-value"/);
  assert.match(csv, /2026-09-24 10:47:02/);
  assert.equal(
    formatTbilisiTimestamp("2026-09-24T06:47:02.000Z"),
    "2026-09-24 10:47:02",
  );
});

test("report cutoff is frozen at the current Tbilisi hour", () => {
  assert.equal(
    reportCutoff(new Date("2026-09-24T07:42:33.000Z")).toISOString(),
    "2026-09-24T07:00:00.000Z",
  );
});

test("cron authentication is exact and rejects before upstream calls", async () => {
  setValidEnvironment();
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run");
  };

  const res = response();
  await handler(request({ authorization: "Bearer wrong" }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls, 0);
  assert.equal(secretsMatch("same", "same"), true);
  assert.equal(secretsMatch("same", "different"), false);
});

test("handler paginates by id and sends one Base64 CSV attachment", async () => {
  setValidEnvironment();
  const calls = [];
  const pages = [
    [
      {
        id: 1,
        phone: "+995577045785",
        brand: "magniti",
        consent_version: "magniti-sms-v1",
        created_at: "2026-09-24T06:47:02.000Z",
      },
      {
        id: 2,
        phone: "+995555123456",
        brand: "kalata",
        consent_version: "kalata-sms-v1",
        created_at: "2026-09-24T07:00:00.000Z",
      },
    ],
    [],
  ];

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("https://project.supabase.co")) {
      return jsonResponse(pages.shift());
    }
    return jsonResponse({ id: "email_123" });
  };

  const res = response();
  await handler(
    request({ authorization: "Bearer cron-secret-at-least-16" }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).rows, 2);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /order=id\.asc/);
  assert.match(calls[0].url, /created_at=lt\./);
  assert.doesNotMatch(calls[0].url, /sb_secret_test/);
  assert.match(calls[1].url, /id=gt\.2/);
  assert.equal(calls[2].url, "https://api.resend.com/emails");

  const email = JSON.parse(calls[2].options.body);
  assert.deepEqual(email.to, ["reports@example.com"]);
  assert.equal(email.attachments.length, 1);
  const decoded = Buffer.from(email.attachments[0].content, "base64").toString(
    "utf8",
  );
  assert.equal(decoded.charCodeAt(0), 0xfeff);
  assert.match(decoded, /magniti-sms-v1/);
  assert.match(decoded, /kalata-sms-v1/);
  assert.match(calls[2].options.headers["Idempotency-Key"], /^number-consents-/);
});

test("upstream failure returns a generic response without sending email", async () => {
  setValidEnvironment();
  const logs = [];
  console.error = (...values) => logs.push(values);
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ message: "+995577045785 sb_secret_LEAK" }, 500);
  };

  const res = response();
  await handler(
    request({ authorization: "Bearer cron-secret-at-least-16" }),
    res,
  );

  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "report_failed" });
  assert.equal(fetchCalls, 1);
  const output = JSON.stringify({ logs, body: res.body });
  assert.doesNotMatch(output, /\+995577045785|sb_secret_LEAK|re_test/);
});

test("Vercel cron is Monday 05:00 UTC", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"),
  );
  assert.deepEqual(config.crons, [
    { path: "/api/export-consents", schedule: "0 5 * * 1" },
  ]);
});
