// SORS — import des événements sortie-13.com (Pessac)
//
// Usage :
//   node scrape-sortie13.mjs
//   node scrape-sortie13.mjs --dry
//   node scrape-sortie13.mjs --dump --dry
//
// Source CMS Wix (collection Evenementiel1) embarquée dans la page agenda.

import { writeFile, mkdir } from "node:fs/promises";
import {
  DAYS, DRY, DUMP, clean, get, horizonBounds, importEvents, inHorizon, loadVenues,
  matchKey, normTime, parsePrices, requireAuthUnlessDry, resolveFixedVenue,
} from "./lib.mjs";

const SOURCE = "sortie13";
const AGENDA = "https://www.sortie-13.com/agenda-billetterie-sortie13";
const BASE = "https://www.sortie-13.com";

const VENUE = {
  nom: "Sortie 13",
  adresse: "Rue Walter Scott",
  ville: "Pessac",
  lat: 44.801341,
  lng: -0.660412,
};

/** wix:image://v1/{id}~mv2.png/... → URL static.wixstatic.com */
export function wixImage(uri) {
  if (!uri) return null;
  if (/^https?:\/\//i.test(uri)) return uri;
  const m = String(uri).match(/wix:image:\/\/v1\/([^/#]+)/);
  return m ? `https://static.wixstatic.com/media/${m[1]}` : null;
}

export function mapType(theme = "") {
  const t = theme.toLowerCase();
  if (/concert|jam|rock|jazz|blues|pop|noise|groove|hardcore|chanson/.test(t)) return "concert";
  return "spectacle"; // expo, magie, théâtre, etc.
}

export function parseWarmupRecords(html) {
  const m = html.match(/<script[^>]*id=["']wix-warmup-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    const recs = data?.appsWarmupData?.dataBinding?.dataStore?.recordsByCollectionId?.Evenementiel1;
    return recs ? Object.values(recs) : [];
  } catch {
    return [];
  }
}

export function recordToPayload(r, venueRef) {
  const date = (r.date ?? "").slice(0, 10);
  if (!date || !inHorizon(date)) return null;
  const titre = clean(r.titreH1);
  if (!titre) return null;
  const path = r["link-evenementiel-titreH1"] || r["link-evenementiel-1-titreH1"];
  const url = path ? new URL(path, BASE).href.split("?")[0] : null;
  const { gratuit, prix_min, prix_max } = parsePrices(r.tarifs ?? "");
  const theme = clean(r.theme);
  const tags = [theme, clean(r.origine)].filter(Boolean).map(s => s.toLowerCase()).slice(0, 5);
  return {
    source_id: r._id || (path ? path.split("/").filter(Boolean).at(-1) : titre),
    source_url: url ?? AGENDA,
    titre,
    match_key: matchKey(titre),
    type: mapType(theme || r.origine || ""),
    tags,
    gratuit,
    prix_min: gratuit ? null : prix_min,
    prix_max: gratuit ? null : prix_max,
    image_url: wixImage(r.photoPricipale),
    lien_billetterie: r.boutonBillet || url || AGENDA,
    annule: /annul/i.test(`${titre} ${r.origine ?? ""}`),
    ...venueRef,
    occurrences: [{ date, heure: normTime(r.time) }],
  };
}

async function main() {
  requireAuthUnlessDry();
  const { from, to } = horizonBounds();
  console.log(`Sortie 13 — horizon ${from} → ${to}`);

  const html = await get(AGENDA);
  if (!html) throw new Error("agenda inaccessible");
  if (DUMP) { await mkdir("debug", { recursive: true }); await writeFile("debug/sortie13-agenda.html", html); }

  const records = parseWarmupRecords(html);
  console.log(`→ ${records.length} fiches dans le CMS (page agenda)`);

  const venues = await loadVenues();
  const venueCache = new Map();
  const venueRef = await resolveFixedVenue(VENUE, venues, venueCache);

  const payload = [];
  for (const r of records) {
    const p = recordToPayload(r, venueRef);
    if (p) payload.push(p);
  }
  console.log(`→ ${payload.length} événements dans l'horizon ${DAYS}j`);
  await importEvents(SOURCE, payload);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
