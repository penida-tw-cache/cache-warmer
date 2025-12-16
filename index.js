import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ================= ENV ================= */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ================= DOMAIN / PROXY / UA ================= */
const DOMAINS_MAP = {
  tw: "https://penidadivecenter.tw",
};

const PROXIES = {
  tw: process.env.BRD_PROXY_TW, // ✅ TAIWAN PROXY
};

const USER_AGENTS = {
  tw: "PenidaDiveCenter-TW-CacheWarmer/1.0",
};

/* ================= UTIL ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    return cfRay.split("-").pop(); // SIN, TPE, NRT, AMS, etc
  }
  return "N/A";
}

/* ================= LOGGER → GSHEETS ================= */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
  }

  log({
    country = "", // ⬅️ ISI = CF EDGE
    url = "",
    status = "",
    cfCache = "",
    lsCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      country, // EDGE CF
      url,
      status,
      cfCache,
      lsCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => {
      r[2] = this.finishedAt;
      return r;
    });
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;
    await axios.post(
      APPS_SCRIPT_URL,
      { rows: this.rows },
      { timeout: 20000, headers: { "Content-Type": "application/json" } }
    );
    this.rows = [];
  }
}

/* ================= HTTP ================= */
function createAgent(countryKey) {
  const proxy = PROXIES[countryKey];
  if (!proxy) return undefined;
  return new HttpsProxyAgent(proxy);
}

async function fetchWithAgent(url, agent, countryKey, timeout = 15000) {
  const res = await axios.get(url, {
    httpsAgent: agent,
    timeout,
    headers: {
      "User-Agent": USER_AGENTS[countryKey],
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
  });
  return res.data;
}

/* ================= SITEMAP ================= */
async function fetchIndexSitemaps(domain, agent, countryKey) {
  try {
    const xml = await fetchWithAgent(
      `${domain}/sitemap.xml`,
      agent,
      countryKey
    );
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const items = parsed?.sitemapindex?.sitemap;
    if (!items) return [];
    return (Array.isArray(items) ? items : [items]).map((i) => i.loc);
  } catch {
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, agent, countryKey) {
  try {
    const xml = await fetchWithAgent(sitemapUrl, agent, countryKey);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urls = parsed?.urlset?.url;
    if (!urls) return [];
    return (Array.isArray(urls) ? urls : [urls]).map((u) => u.loc);
  } catch {
    return [];
  }
}

/* ================= CLOUDFLARE ================= */
async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;

  await axios.post(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
    { files: [url] },
    {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* ================= WARMER (LS = TRUTH) ================= */
async function warmUrls(urls, agent, countryKey, logger) {
  const BATCH_SIZE = 2;
  const DELAY = 3000;

  const batches = Array.from(
    { length: Math.ceil(urls.length / BATCH_SIZE) },
    (_, i) => urls.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await axios.get(url, {
            httpsAgent: agent,
            timeout: 30000,
            headers: {
              "User-Agent": USER_AGENTS[countryKey],
              Accept: "text/html,*/*",
            },
          });

          const dt = Date.now() - t0;
          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const lsCache = res.headers["x-litespeed-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const edge = extractCfEdge(cfRay);

          console.log(
            `[${edge}] ${res.status} cf=${cfCache} ls=${lsCache} - ${url}`
          );

          logger.log({
            country: edge,
            url,
            status: res.status,
            cfCache,
            lsCache,
            cfRay,
            responseMs: dt,
          });

          // 🔥 RULE SESUAI PERMINTAAN
          if (String(lsCache).toLowerCase() === "miss") {
            await purgeCloudflareCache(url);
          }
        } catch (e) {
          logger.log({
            country: "ERROR",
            url,
            error: 1,
            message: e?.message || "request failed",
          });
        }
      })
    );

    await sleep(DELAY);
  }
}

/* ================= MAIN ================= */
(async () => {
  const logger = new AppsScriptLogger();

  try {
    for (const [countryKey, domain] of Object.entries(DOMAINS_MAP)) {
      const agent = createAgent(countryKey);

      const sitemaps = await fetchIndexSitemaps(domain, agent, countryKey);
      const urls = (
        await Promise.all(
          sitemaps.map((s) => fetchUrlsFromSitemap(s, agent, countryKey))
        )
      ).flat();

      console.log(`[${countryKey}] Found ${urls.length} URLs`);
      await warmUrls(urls, agent, countryKey, logger);
    }
  } finally {
    logger.setFinished();
    await logger.flush();
  }
})();
