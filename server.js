import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- Helper ---------------- */
const toInt = (text) => {
  if (!text) return 0;
  const s = String(text).toLowerCase().replace(/,/g, ".").replace(/\s/g, "").trim();
  if (s.endsWith("k")) {
    const base = parseFloat(s.slice(0, -1));
    return Number.isFinite(base) ? Math.round(base * 1000) : 0;
  }
  const n = parseInt(s.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

async function createBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

/* ---------------- intern: Scroll + Extraktion ---------------- */
async function deepScroll(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let h = document.body.scrollHeight;
    let y = 0;
    while (y + innerHeight < h && y < 20000) { // hartes Cap
      y += Math.floor(innerHeight * 0.9);
      scrollTo(0, y);
      await sleep(250);
      h = document.body.scrollHeight;
    }
    // kurz wieder nach oben
    scrollTo(0, 0);
  });
}

async function extractSubsNearLabel(page) {
  return await page.evaluate(() => {
    const LABELS = ["abonnement", "abonnements", "abonnenten", "subscribers", "subscriptions"];
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const low = (s) => norm(s).toLowerCase();
    const main = document.querySelector("main") || document.body;

    const ratioFromNode = (root) => {
      if (!root) return null;
      const nodes = [root, ...root.querySelectorAll("*")];
      for (const n of nodes) {
        // Text
        const t = norm(n.textContent || "");
        let m = t.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (m) return { num: m[1], den: m[2], scope: "near_label_text" };
        // Attribute
        for (const a of Array.from(n.attributes || [])) {
          const v = norm(a.value || "");
          m = v.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
          if (m) return { num: m[1], den: m[2], scope: "near_label_attr" };
        }
      }
      return null;
    };

    // Kandidaten mit Label
    const nodes = [main, ...Array.from(main.querySelectorAll("*")).slice(0, 5000)];
    const labels = nodes.filter((el) => {
      const txt = low(el.textContent || "");
      if (!txt) return false;
      return LABELS.some((L) => txt.includes(L));
    });

    for (const el of labels) {
      // im Container (bis 6 Eltern hoch)
      let p = el;
      for (let i = 0; i < 6 && p; i++) {
        const r = ratioFromNode(p);
        if (r) return { raw: r.num, scope: r.scope };
        p = p.parentElement;
      }
      // in den nächsten Geschwistern
      let s = el.nextElementSibling;
      for (let i = 0; i < 6 && s; i++) {
        const r = ratioFromNode(s);
        if (r) return { raw: r.num, scope: "near_label_sibling" };
        s = s.nextElementSibling;
      }
    }

    // HTML-Backup: „…abonn… <irgendwas> X / Y“  (max 1200 Zeichen danach)
    const html = document.documentElement?.innerHTML || "";
    const mHtml = html.match(/abonn\w*[\s\S]{0,1200}?(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/i);
    if (mHtml) return { raw: mHtml[1], scope: "html_after_label" };

    return null;
  });
}

async function extractGlobalRatio(page) {
  return await page.evaluate(() => {
    const t = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const m = t.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
    return m ? { raw: m[1], scope: "text_ratio_global" } : null;
  });
}

/* ---------------- /subs ---------------- */
app.get("/subs", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  const debug = String(req.query.debug || "") === "1";
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

  const url = `https://kick.com/${slug}/about`;
  const log = [];
  let subs = 0;
  let foundRaw = "";
  let debugPeek = "";

  const browser = await createBrowser();
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1368, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  // kleines Stealth
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["de-DE", "de", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  });

  const page = await ctx.newPage();
  // Bilder/Media blocken (JS/CSS/Fonts erlauben)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (["image", "media"].includes(t)) return route.abort();
    return route.continue();
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Cookiebanner best effort
    try {
      const btn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (btn) { await btn.click({ timeout: 800 }); log.push("consent_clicked"); }
    } catch {}

    // ===== 3 Versuche: scrollen + in Label-Nähe lesen =====
    for (let attempt = 1; attempt <= 3 && !subs; attempt++) {
      await deepScroll(page);
      await page.waitForTimeout(600);

      // 1) ARIA (falls vorhanden)
      try {
        const aria = await page.$$eval('[role="progressbar"][aria-valuenow]', els =>
          els.map(e => e.getAttribute("aria-valuenow") || "")
        );
        const first = aria.find(v => !!v);
        if (first) {
          foundRaw = first;
          subs = toInt(first);
          log.push("aria_found");
          break;
        } else {
          log.push("aria_none");
        }
      } catch {
        log.push("aria_error");
      }

      // 2) Strikt am Label „Abonn…“ auslesen (X vor /)
      const near = await extractSubsNearLabel(page);
      if (near?.raw) {
        foundRaw = near.raw;
        subs = toInt(foundRaw);
        log.push(near.scope);
        break;
      } else {
        log.push("abonnements_scan_miss");
      }

      // 3) Letzter Versuch im Durchgang: globales „X / Y“
      const glob = await extractGlobalRatio(page);
      if (glob?.raw) {
        foundRaw = glob.raw;
        subs = toInt(foundRaw);
        log.push(glob.scope);
        break;
      }

      // kleiner Cooldown zwischen den Versuchen
      await page.waitForTimeout(700);
    }

    if (debug && !foundRaw) {
      // nur kurze Probe
      const bodyText = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim());
      debugPeek = bodyText.slice(0, 400);
    }

    await browser.close();
    return res.json({ subs, foundRaw, url, log, ...(debug ? { debugPeek } : {}) });
  } catch (e) {
    await browser.close();
    return res.status(500).json({ error: e.message, url, log });
  }
});

/* ---------------- /subs-text ---------------- */
app.get("/subs-text", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  const name = (req.query.name || slug || "Der Kanal").trim();
  if (!slug) return res.status(400).type("text/plain").send("Missing ?slug=");

  let subs = 0;
  try {
    const local = `http://127.0.0.1:${PORT}/subs?slug=${encodeURIComponent(slug)}`;
    const r = await fetch(local);
    if (r.ok) {
      const j = await r.json();
      if (typeof j.subs === "number" && Number.isFinite(j.subs)) subs = j.subs;
    }
  } catch {}

  res
    .type("text/plain; charset=utf-8")
    .send(`🎁 ${name} hat aktuell ${subs} Subscriber 💚`);
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
