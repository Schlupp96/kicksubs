import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/* --- Helfer --- */
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
   /subs  – Abonnenten (Subscriber) auslesen
   ======================================================================= */
app.get("/subs", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

  const url = `https://kick.com/${slug}/about`;
  const log = [];
  let subs = 0;
  let foundRaw = "";

  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1200);

    // Cookie/Consent wegklicken, wenn vorhanden
    try {
      const acceptBtn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (acceptBtn) {
        await acceptBtn.click({ timeout: 900 });
        log.push("consent_clicked");
      }
    } catch {}

    // 1) Versuche gezielt die Abo-Leiste ("342 / 360") in der Nähe von "Abonnements" zu finden
    const near = await page.evaluate(() => {
      const pickSlashNumber = (root) => {
        if (!root) return "";
        const txt = (root.textContent || "").replace(/\s+/g, " ").trim();
        // fange "342 / 360" ab – wir nehmen die erste Zahl links vom Slash
        const m = txt.match(/(\d[\d\s\.,]*)\s*\/\s*(\d[\d\s\.,]*)/);
        return m ? m[1] : "";
      };

      // „Abonnements“ (de), „Subscribers/Subscriptions“ (fallback en)
      const XP = "//main//*[contains(text(),'Abonnements') or contains(text(),'Abonnements!') or contains(text(),'Subscribers') or contains(text(),'Subscriptions')]";
      const label = document.evaluate(
        XP, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      ).singleNodeValue;

      if (label) {
        // in Eltern hochlaufen und schauen, ob in diesem Block die "x / y" steht
        let el = label;
        for (let i = 0; i < 4 && el; i++) {
          const got = pickSlashNumber(el.parentElement || el);
          if (got) return { raw: got, scope: "near_label_parent" };
          el = el.parentElement;
        }
        // in Geschwistern danach suchen
        let sib = label.nextElementSibling;
        for (let i = 0; i < 4 && sib; i++) {
          const got = pickSlashNumber(sib);
          if (got) return { raw: got, scope: "near_label_sibling" };
          sib = sib.nextElementSibling;
        }
      }

      // Fallback: Gesamte Seite nach „x / y“ durchsuchen
      const bodyTxt = (document.body.innerText || "").replace(/\s+/g, " ");
      const m = bodyTxt.match(/(\d[\d\s\.,]*)\s*\/\s*(\d[\d\s\.,]*)/);
      if (m) return { raw: m[1], scope: "body_fallback" };

      return { raw: "", scope: "miss" };
    });

    if (near?.raw) {
      subs = toInt(near.raw);
      foundRaw = near.raw;
      log.push(near.scope || "near_label");
    } else {
      log.push("not_found");
    }

    await browser.close();
    return res.json({ subs, foundRaw, url, log });
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

  // lokal die /subs-Route nutzen, damit alles an EINER Stelle ist
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

  res
    .type("text/plain; charset=utf-8")
    .send(`🎁 ${name} hat aktuell ${subs} Subscriber 💚`);
});

/* --- Server starten --- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
