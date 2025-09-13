import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Helfer ---------- */
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

async function getBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

/* =======================================================================
   /subs – Abonnenten (Subscriber) auslesen
   ======================================================================= */
app.get("/subs", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  const debug = String(req.query.debug || "") === "1";
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

  const url = `https://kick.com/${slug}/about`;
  const log = [];
  let subs = 0;
  let foundRaw = "";
  let debugPeek = "";

  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
    viewport: { width: 1366, height: 900 },
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 45000 });
    await page.waitForSelector("main", { timeout: 15000 });

    // Seite einmal „anstoßen“, damit eventuelle Lazy-Blöcke laden
    await page.evaluate(async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 4; i++) {
        window.scrollBy(0, window.innerHeight);
        await delay(250);
      }
      window.scrollTo(0, 0);
    });

    // Cookie-Banner weg
    try {
      const btn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (btn) { await btn.click({ timeout: 1000 }); log.push("consent_clicked"); }
    } catch {}

    // ---------- 1) Einfach: irgendein Progressbar mit aria-valuenow ----------
    try {
      await page.waitForSelector('[role="progressbar"][aria-valuenow]', { timeout: 8000 });
      const allNow = await page.$$eval('[role="progressbar"][aria-valuenow]', els =>
        els.map(e => ({
          now: e.getAttribute('aria-valuenow') || '',
          max: e.getAttribute('aria-valuemax') || '',
          text: (e.textContent || '').replace(/\s+/g,' ').trim()
        }))
      );
      if (allNow?.length) {
        // Nimm den mit der größten "max" (typisch 360) – das ist fast immer der Sub-Balken
        allNow.sort((a,b) => (parseInt(b.max||'0',10) || 0) - (parseInt(a.max||'0',10) || 0));
        const pick = allNow[0];
        const n = parseInt(String(pick.now).replace(/[^\d]/g, ""), 10) || 0;
        if (n) {
          subs = n;
          foundRaw = pick.now + (pick.max ? ` / ${pick.max}` : "");
          log.push("aria_global_pick");
        }
        if (debug) debugPeek = JSON.stringify(allNow.slice(0,3));
      } else {
        log.push("aria_none_found");
      }
    } catch {
      log.push("aria_wait_timeout");
    }

    // ---------- 2) Gezielt: Bereich um „Abonnements“ ----------
    if (!subs) {
      const around = await page.evaluate(() => {
        const LABELS = ["Abonnements", "Abonnements!", "Abonnenten", "Subscribers", "Subscriptions"];
        const main = document.querySelector("main") || document.body;

        const hasLabel = (el) =>
          LABELS.some(l =>
            (el.textContent || "").toLowerCase().includes(l.toLowerCase())
          );

        // finde den Container, der das Label enthält
        let container = null;
        const sections = Array.from(main.querySelectorAll("section,div"));
        for (const el of sections) {
          if (hasLabel(el)) { container = el; break; }
        }
        if (!container) return null;

        // 2a) Progressbar im Container
        const pb = container.querySelector('[role="progressbar"][aria-valuenow]');
        if (pb) {
          return {
            scope: "aria_near_label",
            raw: pb.getAttribute("aria-valuenow") || "",
            rawMax: pb.getAttribute("aria-valuemax") || "",
            txt: (pb.textContent || "").replace(/\s+/g," ").trim()
          };
        }

        // 2b) Text „x / y“ im Container
        const t = (container.textContent || "").replace(/\s+/g, " ").trim();
        const m = t.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (m) return { scope: "text_ratio", raw: m[1], txt: t };

        // 2c) erste Zahl NACH dem Label
        for (const L of LABELS) {
          const idx = t.indexOf(L);
          if (idx >= 0) {
            const tail = t.slice(idx + L.length);
            const m2 = tail.match(/(\d[\d\.\s,]*)/);
            if (m2) return { scope: "text_after_label", raw: m2[1], txt: t };
          }
        }
        return { scope: "near_label_but_not_found", txt: t };
      });

      if (around?.raw) {
        foundRaw = String(around.raw);
        subs = toInt(foundRaw);
        log.push(around.scope || "near_label_hit");
        if (debug) debugPeek = (debugPeek ? debugPeek + " | " : "") + (around.txt || "");
      } else {
        log.push(around?.scope || "near_label_miss");
      }
    }

    // ---------- 3) Letzter Fallback: irgendwo „x / y“ ----------
    if (!subs) {
      const fallback = await page.evaluate(() => {
        const t = (document.querySelector("main")?.textContent || document.body.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const m = t.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        return m ? { raw: m[1], txt: t } : null;
      });
      if (fallback?.raw) {
        foundRaw = fallback.raw;
        subs = toInt(foundRaw);
        log.push("text_ratio_global");
        if (debug) debugPeek = (debugPeek ? debugPeek + " | " : "") + (fallback.txt || "");
      } else {
        log.push("text_ratio_miss");
      }
    }

    await browser.close();
    const out = { subs, foundRaw, url, log };
    if (debug) out.debugPeek = debugPeek?.slice(0, 800);
    return res.json(out);
  } catch (e) {
    await browser.close();
    return res.status(500).json({ error: e.message, url, log });
  }
});

/* =======================================================================
   /subs-text – nur Textantwort (für Botrix/Chat)
   ======================================================================= */
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

/* ---------- Server starten ---------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
