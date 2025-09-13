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

  // minimales Stealth
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["de-DE", "de", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  });

  const page = await ctx.newPage();

  // eher schlank: Bilder & Media blocken, Fonts/CSS/JS erlauben
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (["image", "media"].includes(t)) return route.abort();
    return route.continue();
  });

  try {
    // kein networkidle / kein waitForSelector('body') mehr
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Cookiebanner (best effort)
    try {
      const btn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (btn) { await btn.click({ timeout: 800 }); log.push("consent_clicked"); }
    } catch {}

    // sanft anscrollen + kleiner Delay, damit SPA hydratisiert
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 2; i++) { window.scrollBy(0, window.innerHeight); await sleep(200); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1200);

    /* 1) ARIA Progressbar */
    try {
      const aria = await page.$$eval('[role="progressbar"][aria-valuenow]', els =>
        els.map(e => ({
          now: e.getAttribute("aria-valuenow") || "",
          max: e.getAttribute("aria-valuemax") || "",
        }))
      );
      if (aria && aria.length) {
        aria.sort((a,b) => (parseInt(b.max||"0",10)||0) - (parseInt(a.max||"0",10)||0));
        const pick = aria[0];
        const n = parseInt(String(pick.now).replace(/[^\d]/g, ""), 10) || 0;
        if (n) {
          subs = n;
          foundRaw = pick.now + (pick.max ? ` / ${pick.max}` : "");
          log.push("aria_found");
        } else {
          log.push("aria_zero");
        }
      } else {
        log.push("aria_none");
      }
    } catch { log.push("aria_error"); }

    /* 2) Sichtbarer Text */
    if (!subs) {
      const bodyText = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim());
      if (debug) debugPeek = bodyText.slice(0, 400);

      // Zahl direkt hinter Label
      const lower = bodyText.toLowerCase();
      const labels = ["abonnements!", "abonnements", "abonnenten", "subscribers", "subscriptions"];
      let afterIdx = -1;
      for (const L of labels) { const i = lower.indexOf(L); if (i >= 0) { afterIdx = i + L.length; break; } }
      if (afterIdx >= 0) {
        const tail = bodyText.slice(afterIdx);
        const mAfter = tail.match(/(\d[\d\.,\s]*)/);
        if (mAfter) { foundRaw = mAfter[1]; subs = toInt(foundRaw); log.push("text_after_label"); }
      }

      // „x / y“ im sichtbaren Text
      if (!subs) {
        const mRatio = bodyText.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (mRatio) { foundRaw = mRatio[1]; subs = toInt(foundRaw); log.push("text_ratio_visible"); }
      }
    }

/* 3) Label-gebunden: „Abonnements“ finden → im selben Kasten „X / Y“ lesen → X nehmen */
if (!subs) {
  const hit = await page.evaluate(() => {
    const LABELS = ["abonnement", "abonnements", "abonnenten", "subscribers", "subscriptions"];
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const normLower = (s) => norm(s).toLowerCase();
    const main = document.querySelector("main") || document.body;

    const ratioFromNode = (root) => {
      if (!root) return null;
      const nodes = [root, ...root.querySelectorAll("*")];

      for (const n of nodes) {
        // Texte prüfen
        const txt = norm(n.textContent || "");
        let m = txt.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (m) return { num: m[1], den: m[2], where: "desc_text" };

        // Attribute (aria-label, title, data-*)
        for (const a of Array.from(n.attributes || [])) {
          const v = norm(a.value || "");
          m = v.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
          if (m) return { num: m[1], den: m[2], where: "desc_attr" };
        }
      }
      return null;
    };

    // 1) Alle Elemente durchsuchen, die das Label enthalten
    const all = [main, ...Array.from(main.querySelectorAll("*")).slice(0, 4000)];
    const labelEls = all.filter((el) => {
      const t = normLower(el.textContent || "");
      if (!t) return false;
      return LABELS.some((L) => t.includes(L));
    });

    for (const el of labelEls) {
      // a) im gleichen Container (bis zu 6 Ebenen hoch)
      let p = el;
      for (let i = 0; i < 6 && p; i++) {
        const r = ratioFromNode(p);
        if (r) {
          return { raw: r.num, den: r.den, scope: "near_label_container",
                   ctx: norm(p.textContent || "").slice(0, 160) };
        }
        p = p.parentElement;
      }
      // b) in den nächsten Geschwistern
      let s = el.nextElementSibling;
      for (let i = 0; i < 6 && s; i++) {
        const r = ratioFromNode(s);
        if (r) {
          return { raw: r.num, den: r.den, scope: "near_label_sibling",
                   ctx: norm(s.textContent || "").slice(0, 160) };
        }
        s = s.nextElementSibling;
      }
    }

    // 2) HTML-Backup: „…Abonnements… <irgendwas> X / Y“
    const html = document.documentElement?.innerHTML || "";
    const mHtml = html.match(/abonnements[\s\S]{0,800}?(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/i);
    if (mHtml) {
      return { raw: mHtml[1], den: mHtml[2], scope: "html_after_label", ctx: "" };
    }

    // 3) Letzter Fallback (globales X/Y)
    const txt = norm(main.textContent || "");
    const mg = txt.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
    if (mg) return { raw: mg[1], den: mg[2], scope: "global_ratio", ctx: txt.slice(0, 160) };

    return null;
  });

  if (hit?.raw) {
    foundRaw = hit.raw;   // <- das ist die gewünschte „321“
    subs = toInt(foundRaw);
    log.push(hit.scope);
    if (debug && hit.ctx) debugPeek = (debugPeek ? debugPeek + " | " : "") + hit.ctx;
  } else {
    log.push("abonnements_scan_miss");
  }
}



    // Challenge-Erkennung (nur für Diagnose)
    if (!subs) {
      const txt = await page.evaluate(() => (document.body.innerText || "").toLowerCase());
      if (/(access denied|verify you are human|enable javascript|cloudflare)/i.test(txt)) {
        log.push("challenge_detected");
      }
    }

    await browser.close();
    const out = { subs, foundRaw, url, log };
    if (debug) out.debugPeek = debugPeek;
    return res.json(out);
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
    const u = new URL(`${req.protocol}://${req.get("host")}/subs`);
    u.searchParams.set("slug", slug);
    const r = await fetch(u.toString());
    if (r.ok) {
      const j = await r.json();
      if (typeof j.subs === "number") subs = j.subs;
    }
  } catch {}

  res.type("text/plain; charset=utf-8").send(`🎁 ${name} hat aktuell ${subs} Subscriber 💚`);
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
