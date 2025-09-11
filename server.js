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

    // Consent wegklicken
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

    // 1) Progressbar anhand von ARIA finden – zuerst in der Nähe von "Abonnements"
    const ariaNearby = await page.evaluate(() => {
      const findProgress = (root) => {
        if (!root) return null;
        const pb = root.querySelector('[role="progressbar"][aria-valuenow]');
        if (!pb) return null;
        const now = pb.getAttribute("aria-valuenow");
        const max = pb.getAttribute("aria-valuemax") || "";
        return { now, max, scope: "aria_near_label" };
      };

      // Label "Abonnements" / engl. Fallbacks
      const label = document.evaluate(
        "//main//*[contains(text(),'Abonnements') or contains(text(),'Abonnements!') or contains(text(),'Subscribers') or contains(text(),'Subscriptions')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      if (label) {
        // 1a) im Parent-Block
        let p = label.parentElement;
        for (let i = 0; i < 4 && p; i++) {
          const hit = findProgress(p);
          if (hit) return hit;
          p = p.parentElement;
        }
        // 1b) in Geschwistern
        let s = label.nextElementSibling;
        for (let i = 0; i < 6 && s; i++) {
          const hit = findProgress(s);
          if (hit) return hit;
          s = s.nextElementSibling;
        }
      }

      // 2) Globaler Fallback: irgendein Progressbar auf der Seite
      const any = document.querySelector('[role="progressbar"][aria-valuenow]');
      if (any) {
        return {
          now: any.getAttribute("aria-valuenow"),
          max: any.getAttribute("aria-valuemax") || "",
          scope: "aria_global",
        };
      }

      return null;
    });

    if (ariaNearby?.now) {
      subs = parseInt(String(ariaNearby.now).replace(/[^\d]/g, ""), 10) || 0;
      foundRaw = ariaNearby.now + (ariaNearby.max ? ` / ${ariaNearby.max}` : "");
      log.push(ariaNearby.scope);
    } else {
      log.push("aria_miss");
    }

    // 3) Letzter Fallback: sichtbarer Text "x / y"
    if (!subs) {
      const txtHit = await page.evaluate(() => {
        const pick = (root) => {
          const t = (root?.textContent || "").replace(/\s+/g, " ").trim();
          const m = t.match(/(\d[\d\s\.,]*)\s*\/\s*(\d[\d\s\.,]*)/);
          return m ? m[1] : "";
        };

        const main = document.querySelector("main") || document.body;
        // Suche in typischen Containern
        const containers = [
          main,
          ...Array.from(main.querySelectorAll("section,div")),
        ].slice(0, 200);

        for (const c of containers) {
          const raw = pick(c);
          if (raw) return { raw, scope: "text_ratio" };
        }
        return null;
      });

      if (txtHit?.raw) {
        subs = parseInt(txtHit.raw.replace(/[^\d]/g, ""), 10) || 0;
        foundRaw = txtHit.raw;
        log.push(txtHit.scope);
      } else {
        log.push("text_miss");
      }
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
