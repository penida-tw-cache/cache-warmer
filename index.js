import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ====== ENV WAJIB ====== */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // URL Web App GAS /exec

/* ====== KONFIG DOMAIN/PROXY/UA ====== */
const DOMAINS_MAP = {
  tw: "https://divingpenida.tw",
};

const PROXIES = {
  tw: process.env.BRD_PROXY_TW, // Taiwan
};

const USER_AGENTS = {
  tw: "DivingPenida-TW-CacheWarmer/1.0",
};

/* ====== CLOUDFLARE (opsional) ====== */
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Nama tab per-run: YYYY-MM-DD_HH-mm-ss_WITA (tanpa +0800) */
function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000); // WITA +08
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER → APPS SCRIPT (BATCH PER-RUN) ====== */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun(); // satu tab per-run
  }

  log({
    country = "",
    url = "",
    status = "",
    cfCache = "",
    originCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId, // run_id
      this.startedAt, // started_at (ISO)
      this.finishedAt, // finished_at (diisi saat finalize)
      country, // country
      url, // url
      status, // status code
      cfCache, // cf_cache
      originCache, // vercel_cache
      cfRay, // cf_ray
      typeof responseMs === "number" ? responseMs : "", // response_ms
      error ? 1 : 0, // error (0/1)
      message, // message
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL) {
      console.warn("Apps Script logging disabled (missing APPS_SCRIPT_URL).");
      return;
    }
    if (this.rows.length === 0) return;

    const CHUNK_SIZE = 50;
    const MAX_RETRIES = 3;
    const TIMEOUT = 60000; // 60 detik per chunk

    const chunks = [];
    for (let i = 0; i < this.rows.length; i += CHUNK_SIZE) {
      chunks.push(this.rows.slice(i, i + CHUNK_SIZE));
    }

    console.log(
      `Apps Script: flushing ${this.rows.length} rows in ${chunks.length} chunk(s)...`
    );

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await axios.post(
            APPS_SCRIPT_URL,
            { sheetName: this.sheetName, rows: chunk },
            { timeout: TIMEOUT, headers: { "Content-Type": "application/json" } }
          );
          console.log(
            `Apps Script chunk ${ci + 1}/${chunks.length}: ${res.status}`,
            res.data
          );
          if (!res.data?.ok)
            console.warn("Apps Script replied error:", res.data);
          success = true;
          break;
        } catch (e) {
          console.warn(
            `Apps Script chunk ${ci + 1}/${chunks.length} attempt ${attempt}/${MAX_RETRIES} failed:`,
            e?.response?.status,
            e?.response?.data || e?.message || e
          );
          if (attempt < MAX_RETRIES) await sleep(3000);
        }
      }
      if (!success) {
        console.warn(
          `⚠️ Apps Script chunk ${ci + 1} failed after ${MAX_RETRIES} retries — ${chunk.length} rows lost`
        );
      }
    }
    this.rows = []; // bersihkan buffer
  }
}

/* ====== HTTP helper (dgn/tnp proxy) ====== */
function buildAxiosCfg(country, extra = {}) {
  const proxy = PROXIES[country];
  const cfg = {
    headers: { "User-Agent": USER_AGENTS[country] },
    timeout: 30000,
    ...extra,
  };
  if (proxy) cfg.httpsAgent = new HttpsProxyAgent(proxy);
  return cfg;
}

function buildRevalidationAxiosCfg(country) {
  const cfg = buildAxiosCfg(country, { timeout: 15000 });
  cfg.headers = {
    ...cfg.headers,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  return cfg;
}

/* ====== SITEMAP ====== */
async function fetchWithProxy(url, country, timeout = 15000) {
  const cfg = buildAxiosCfg(country, { timeout });
  const res = await axios.get(url, cfg);
  return res.data;
}

async function fetchIndexSitemaps(domain, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap.xml`, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const sitemapList = result?.sitemapindex?.sitemap;
    if (sitemapList) {
      return {
        sitemaps: (Array.isArray(sitemapList) ? sitemapList : [sitemapList])
          .map((e) => e.loc)
          .filter(Boolean),
        urls: [],
      };
    }

    // Some sites redirect /sitemap.xml to a sitemap containing URLs
    // directly instead of a sitemap index containing child sitemap files.
    const urlList = result?.urlset?.url;
    if (urlList) {
      return {
        sitemaps: [],
        urls: (Array.isArray(urlList) ? urlList : [urlList])
          .map((e) => e.loc)
          .filter(Boolean),
      };
    }

    console.warn(`[${country}] Sitemap response has no <sitemapindex> or <urlset>`);
    return { sitemaps: [], urls: [] };
  } catch (err) {
    console.warn(
      `[${country}] Failed to fetch sitemap index: ${err?.message || err}`
    );
    return { sitemaps: [], urls: [] };
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country, 15000);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const urlList = result?.urlset?.url;
    if (!urlList) return [];
    const urls = Array.isArray(urlList) ? urlList : [urlList];
    return urls.map((entry) => entry.loc).filter(Boolean);
  } catch (err) {
    console.warn(
      `[${country}] ❌ Failed to fetch URLs from ${sitemapUrl}: ${err?.message || err
      }`
    );
    return [];
  }
}

/* ====== WARMING ====== */
async function retryableGet(url, cfg, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, cfg);
    } catch (err) {
      lastError = err;
      const code = err?.code || "";
      const status = err?.response?.status;

      // Retry jika network error ATAU server error (502, 503, 504)
      const isNetworkError =
        axios.isAxiosError(err) &&
        ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(code);
      const isServerError = [502, 503, 504].includes(status);

      if (!isNetworkError && !isServerError) break;

      console.log(`  ⟳ Retry ${i + 1}/${retries} for ${url} (${status || code})`);
      await sleep(3000); // tunggu 3 detik sebelum retry
    }
  }
  throw lastError;
}

async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;
  try {
    const purgeRes = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
      { files: [url] },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (purgeRes.data?.success) {
      console.log(`✅ Cloudflare cache purged: ${url}`);
    } else {
      console.warn(`⚠️ Failed to purge Cloudflare: ${url}`);
    }
  } catch {
    console.warn(`❌ Error purging Cloudflare: ${url}`);
  }
}

async function warmUrls(urls, country, logger, batchSize = 1, delay = 2000) {
  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          let res = await retryableGet(
            url,
            buildAxiosCfg(country, { timeout: 15000 }),
            3
          );
          let originCache = res.headers["x-vercel-cache"] || "N/A";

          if (String(originCache).toLowerCase() === "stale") {
            console.log(
              `[${country}] Vercel cache is STALE; purging Cloudflare and requesting synchronous revalidation: ${url}`
            );
            await purgeCloudflareCache(url);

            try {
              res = await retryableGet(
                url,
                buildRevalidationAxiosCfg(country),
                1
              );
              originCache = res.headers["x-vercel-cache"] || "N/A";

              if (String(originCache).toLowerCase() === "stale") {
                console.warn(
                  `[${country}] Vercel still returned STALE after synchronous revalidation: ${url}`
                );
              }
            } catch (revalidationError) {
              console.warn(
                `[${country}] Vercel synchronous revalidation failed for ${url}: ${revalidationError?.message || revalidationError}`
              );
            }
          }

          const dt = Date.now() - t0;

          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const cfEdge = cfRay.includes("-") ? cfRay.split("-")[1] : "N/A";

          if (
            String(originCache).toLowerCase() === "stale" &&
            String(cfCache).toLowerCase() === "hit"
          ) {
            console.warn(
              `[${country}] Cloudflare still served a cached STALE response; Vercel revalidation was not confirmed for ${url}`
            );
          }

          console.log(
            `[${country}] ${res.status} cf=${cfCache} vercel=${originCache} edge=${cfEdge} - ${url}`
          );

          logger.log({
            country: cfEdge,
            url,
            status: res.status,
            cfCache,
            originCache,
            cfRay,
            responseMs: dt,
            error: 0,
            message: "",
          });

          const originCacheStatus = String(originCache).toLowerCase();
          if (originCacheStatus === "stale") {
            console.log(
              `[${country}] Vercel is still STALE; purging Cloudflare again so this stale response is not left cached: ${url}`
            );
            await purgeCloudflareCache(url);
          } else if (
            originCache !== "N/A" &&
            !["hit", "prerender", "revalidated"].includes(originCacheStatus)
          ) {
            await purgeCloudflareCache(url);
          }
        } catch (err) {
          const dt = Date.now() - t0;
          console.warn(
            `[${country}] ❌ Failed to warm ${url}: ${err?.message || err}`
          );

          logger.log({
            country,
            url,
            responseMs: dt,
            error: 1,
            message: err?.message || "request failed",
          });
        }
      })
    );

    await sleep(delay);
  }
}

/* ====== MAIN (SEQUENTIAL per-country, satu tab) ====== */
(async () => {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    // Proses BERURUTAN per-negara (bukan paralel)
    for (const [country, domain] of Object.entries(DOMAINS_MAP)) {
      console.log(`\n========== [${country.toUpperCase()}] MULAI ==========`);

      const { sitemaps: sitemapList, urls: directUrls } =
        await fetchIndexSitemaps(domain, country);
      const urlArrays = await Promise.all(
        sitemapList.map((sitemapUrl) =>
          fetchUrlsFromSitemap(sitemapUrl, country)
        )
      );
      const urls = [...directUrls, ...urlArrays.flat()].filter(Boolean);

      console.log(`[${country}] Found ${urls.length} URLs`);
      logger.log({
        country,
        message: `Found ${urls.length} URLs for ${country}`,
      });

      await warmUrls(urls, country, logger);

      console.log(`========== [${country.toUpperCase()}] SELESAI ==========\n`);
    }
  } finally {
    // Kirim SEKALI di akhir → semua baris tersimpan dalam SATU tab (sheetName per-run)
    logger.setFinished();
    await logger.flush();
  }

  console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
})();
