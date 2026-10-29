// Helpers partagés par les scrapers SORS (bdxc, sortie-13, arkea, femina…)

export const UA = "SORS-bot/1.0 (+https://www.sors-bordeaux.com)";
export const DELAY_MS = Number(process.env.DELAY_MS ?? 800);
export const DAYS = Number(process.env.DAYS ?? 21);
export const SB_URL = process.env.SUPABASE_URL;
export const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
export const DRY = process.argv.includes("--dry");
export const DUMP = process.argv.includes("--dump");

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clean = s => (s ?? "").replace(/\s+/g, " ").trim();

export const textOf = ($, el) => clean($(el).find("*").addBack().contents()
  .filter((_, n) => n.type === "text" && !["script", "style"].includes(n.parent?.name))
  .map((_, n) => n.data).get().join(" "));

export const norm = s => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/\(.*?\)/g, " ").replace(/\b(le|la|les|l|du|de|des|au|aux)\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ").trim();

const STOP = new Set(["concert", "soiree", "live", "release", "party", "tour", "tournee", "session", "special", "invite", "avec", "nuit", "festival", "spectacle", "humour"]);
export const matchKey = titre => norm(titre).split(" ").find(w => w.length >= 4 && !STOP.has(w)) ?? norm(titre).split(" ")[0];

export const isoDay = offset => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" })
  .format(new Date(Date.now() + offset * 86400000));

export function horizonBounds(days = DAYS) {
  const from = isoDay(0);
  const to = isoDay(days);
  return { from, to };
}

export function inHorizon(dateStr, days = DAYS) {
  if (!dateStr) return false;
  const d = dateStr.slice(0, 10);
  const { from, to } = horizonBounds(days);
  return d >= from && d <= to;
}

/** "20:30:00" / "20:30:00.000" / "20h30" → "20:30" */
export function normTime(t) {
  if (!t) return null;
  const m = String(t).trim().match(/(\d{1,2})[:hH](\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

export function parsePrices(text) {
  const prices = [...new Set([...String(text ?? "").matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s?€/g)]
    .map(m => Number(m[1].replace(",", "."))))].filter(n => n > 0 && n < 500).sort((a, b) => a - b);
  const free = /\bgratuit\b|entr[ée]e libre|prix libre/i.test(text ?? "") && !prices.length;
  return { gratuit: free, prix_min: prices[0] ?? null, prix_max: prices.at(-1) ?? null };
}

const FR_MONTHS = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
};

/** "1 novembre 2026" / "dimanche 1 novembre 2026" → "2026-11-01" */
export function parseFrDate(text) {
  const m = String(text ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .match(/(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})/);
  if (!m) return null;
  const month = FR_MONTHS[m[2]];
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export async function get(url, { json = false, delay = DELAY_MS, headers = {} } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "fr-FR", ...headers },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      if (attempt === 3) { console.warn(`✗ ${url} : ${e.message}`); return null; }
      await sleep(2000 * attempt);
    } finally {
      await sleep(delay);
    }
  }
}

export async function sb(path, { method = "GET", body } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status} : ${await res.text()}`);
  return res.json();
}

/** Lieu fixe (salle unique) : tente un match en base, sinon crée via le payload `venue`. */
export async function resolveFixedVenue(venue, venues, cache) {
  const key = norm(venue.nom);
  if (cache.has(key)) return cache.get(key);
  const match = venues.find(v => norm(v.nom) === key)
    ?? venues.find(v => { const n = norm(v.nom); return n.length >= 5 && key.length >= 5 && (n.includes(key) || key.includes(n)); });
  if (match) { cache.set(key, { venue_id: match.id }); return cache.get(key); }
  cache.set(key, { venue: { ...venue } });
  return cache.get(key);
}

export async function loadVenues() {
  return SB_URL && SB_KEY ? await sb("venues?select=id,nom,ville") : [];
}

export async function importEvents(source, payload, horizonDays = DAYS) {
  if (DRY) { console.log(JSON.stringify(payload.slice(0, 3), null, 2)); return null; }
  if (!payload.length) {
    console.error("⚠ 0 événement : la structure du site a peut-être changé (lance --dump)");
    process.exit(1);
  }
  const total = {};
  for (let i = 0; i < payload.length; i += 50) {
    const r = await sb("rpc/import_external_events", {
      method: "POST",
      body: { p_source: source, p_events: payload.slice(i, i + 50), p_horizon_days: horizonDays },
    });
    for (const [k, n] of Object.entries(r)) total[k] = (total[k] ?? 0) + n;
  }
  console.log("✓ import terminé :", total);
  return total;
}

export function requireAuthUnlessDry() {
  if (!DRY && !(SB_URL && SB_KEY)) {
    throw new Error("SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis (ou lance --dry)");
  }
}

/** Mois français (slug sans accent) couverts par l'horizon DAYS à partir d'aujourd'hui. */
export function monthsInHorizon(days = DAYS) {
  const slugs = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
  const out = new Set();
  for (let i = 0; i <= days; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const month = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", month: "numeric" }).format(d));
    out.add(slugs[month - 1]);
  }
  return [...out];
}
