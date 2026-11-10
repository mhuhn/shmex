// Position, Entfernungen und Lokale aus OpenStreetMap (Overpass API).

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Dieses Gerät kann keine Position ermitteln')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) }),
      (err) => reject(new Error(err.code === 1
        ? 'Standortzugriff wurde nicht erlaubt. In den iPhone-Einstellungen unter Datenschutz › Ortungsdienste freigeben oder die Position auf der Karte setzen.'
        : 'Position konnte nicht ermittelt werden')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

export function distance(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function formatDistance(m) {
  if (m == null || !isFinite(m)) return '';
  if (m < 1000) return Math.round(m / 10) * 10 + ' m';
  return (m / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' km';
}

const KINDS = {
  restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Imbiss', bar: 'Bar', pub: 'Kneipe',
  biergarten: 'Biergarten', ice_cream: 'Eisdiele', food_court: 'Food-Court',
  bakery: 'Bäckerei', butcher: 'Metzgerei', deli: 'Feinkost', pastry: 'Konditorei', confectionery: 'Süßwaren',
};

const CUISINES = {
  italian: 'italienisch', pizza: 'Pizza', german: 'deutsch', regional: 'regional', greek: 'griechisch',
  chinese: 'chinesisch', asian: 'asiatisch', japanese: 'japanisch', sushi: 'Sushi', indian: 'indisch',
  thai: 'thailändisch', vietnamese: 'vietnamesisch', turkish: 'türkisch', kebab: 'Döner', burger: 'Burger',
  mexican: 'mexikanisch', spanish: 'spanisch', french: 'französisch', american: 'amerikanisch',
  steak_house: 'Steakhaus', seafood: 'Fisch', vegetarian: 'vegetarisch', vegan: 'vegan', ice_cream: 'Eis',
  coffee_shop: 'Kaffee', cake: 'Kuchen', sandwich: 'Sandwiches', korean: 'koreanisch', lebanese: 'libanesisch',
  balkan: 'Balkan', croatian: 'kroatisch', portuguese: 'portugiesisch', persian: 'persisch', syrian: 'syrisch',
  chicken: 'Hähnchen', bagel: 'Bagel', breakfast: 'Frühstück', noodle: 'Nudeln', ramen: 'Ramen',
};

function describe(tags) {
  const kind = KINDS[tags.amenity] || KINDS[tags.shop] || '';
  const cuisine = (tags.cuisine || '').split(';').map((c) => CUISINES[c.trim()] || '').filter(Boolean).slice(0, 2).join(', ');
  return [kind, cuisine].filter(Boolean).join(' · ');
}

// Mehrere öffentliche Overpass-Server; sie werden gleichzeitig gefragt, der schnellste gewinnt.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const OVERPASS_TIMEOUT = 14000;
const PHOTON_TIMEOUT = 10000;
const CACHE_KEY = 'shmex.places';
const CACHE_MAX_AGE = 30 * 24 * 3600 * 1000;

const PHOTON_TAGS = [
  'amenity:restaurant', 'amenity:cafe', 'amenity:fast_food', 'amenity:bar', 'amenity:pub',
  'amenity:biergarten', 'amenity:ice_cream', 'amenity:food_court',
  'shop:bakery', 'shop:butcher', 'shop:deli', 'shop:pastry', 'shop:confectionery',
];

async function fetchJson(url, options, timeout, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function overpassQuery(pos, radius) {
  const a = `around:${radius},${pos.lat.toFixed(6)},${pos.lon.toFixed(6)}`;
  return `[out:json][timeout:12];(
nwr(${a})["amenity"~"^(restaurant|cafe|fast_food|bar|pub|biergarten|ice_cream|food_court)$"]["name"];
nwr(${a})["shop"~"^(bakery|butcher|deli|pastry|confectionery)$"]["name"];
);out center tags qt;`;
}

async function fromOverpass(pos, radius) {
  const body = 'data=' + encodeURIComponent(overpassQuery(pos, radius));
  const json = await Promise.any(OVERPASS.map((url) => fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, OVERPASS_TIMEOUT).then((j) => {
    if (!j || !Array.isArray(j.elements)) throw new Error('Ungültige Antwort');
    if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error(j.remark);
    return j;
  })));
  return json.elements.map((el) => {
    const p = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center;
    if (!p) return null;
    const t = el.tags || {};
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    return {
      osmId: el.type + '/' + el.id, name: t.name, lat: p.lat, lon: p.lon,
      kind: describe(t), address: [street, t['addr:city']].filter(Boolean).join(', '),
    };
  });
}

// Ausweichquelle: Photon (komoot), ebenfalls OpenStreetMap-Daten.
async function fromPhoton(pos, radius) {
  const params = new URLSearchParams({
    lat: pos.lat.toFixed(6), lon: pos.lon.toFixed(6), radius: String(radius / 1000), limit: '50', lang: 'de',
  });
  for (const t of PHOTON_TAGS) params.append('osm_tag', t);
  const json = await fetchJson('https://photon.komoot.io/reverse?' + params, {}, PHOTON_TIMEOUT);
  const types = { N: 'node', W: 'way', R: 'relation' };
  return (json.features || []).map((f) => {
    const pr = f.properties || {};
    const c = f.geometry && f.geometry.coordinates;
    if (!c || !pr.name) return null;
    const street = [pr.street, pr.housenumber].filter(Boolean).join(' ');
    return {
      osmId: (types[pr.osm_type] || 'node') + '/' + pr.osm_id, name: pr.name, lat: c[1], lon: c[0],
      kind: describe({ [pr.osm_key]: pr.osm_value }), address: [street, pr.city].filter(Boolean).join(', '),
    };
  });
}

function finish(list, pos, radius) {
  const seen = new Set();
  return list
    .filter((x) => x && x.name && !seen.has(x.osmId) && seen.add(x.osmId))
    .map((x) => ({ ...x, distance: distance(pos, x) }))
    .filter((x) => x.distance <= radius + 50)
    .sort((a, b) => a.distance - b.distance);
}

// Zuletzt geladene Lokale in der Nähe (falls die Dienste gerade nicht antworten).
export function cachedPlaces(pos, radius = 500) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
    const hit = all.find((c) => Date.now() - c.at < CACHE_MAX_AGE && distance(pos, c) <= 150);
    return hit ? finish(hit.places, pos, radius) : null;
  } catch (e) {
    return null;
  }
}

function storeCache(pos, places) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')
      .filter((c) => Date.now() - c.at < CACHE_MAX_AGE && distance(pos, c) > 150);
    all.unshift({ lat: pos.lat, lon: pos.lon, at: Date.now(), places: places.map(({ distance: _, ...p }) => p) });
    localStorage.setItem(CACHE_KEY, JSON.stringify(all.slice(0, 40)));
  } catch (e) { /* Speicher voll: egal */ }
}

export async function nearbyPlaces(pos, radius = 500) {
  // Beide Quellen gleichzeitig starten; Overpass ist vollständiger und wird bevorzugt.
  // Antwortet Photon, wird höchstens noch 3,5 s auf Overpass gewartet.
  const over = fromOverpass(pos, radius).catch(() => null);
  const photon = fromPhoton(pos, radius).catch(() => null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const overFirst = await Promise.race([
    over,
    photon.then((p) => (p ? sleep(3500).then(() => undefined) : new Promise(() => {}))),
  ]);
  const list = overFirst || (await photon);
  if (!list) throw new Error('OpenStreetMap antwortet gerade nicht. Bitte gleich nochmal versuchen oder oben einen eigenen Namen eintragen.');
  const places = finish(list, pos, radius);
  storeCache(pos, places);
  return places;
}

// Suche nach einem Namen im Umkreis (für selbst eingetragene Namen). Overpass und Photon parallel.
export async function searchPlacesByName(name, pos, radius = 20000, signal) {
  const a = `around:${radius},${pos.lat.toFixed(6)},${pos.lon.toFixed(6)}`;
  const rx = name.trim().replace(/[\\.*+?^${}()|[\]"]/g, '.');
  const q = `[out:json][timeout:15];(
nwr(${a})["name"~"${rx}",i]["amenity"];
nwr(${a})["name"~"${rx}",i]["shop"];
nwr(${a})["name"~"${rx}",i]["tourism"];
);out center tags 40;`;
  const body = 'data=' + encodeURIComponent(q);
  const over = Promise.any(OVERPASS.map((url) => fetchJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }, 16000, signal).then((j) => {
    if (!j || !Array.isArray(j.elements)) throw new Error('Ungültige Antwort');
    return j.elements.map((el) => {
      const p = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center;
      if (!p) return null;
      const t = el.tags || {};
      const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
      return { osmId: el.type + '/' + el.id, name: t.name, lat: p.lat, lon: p.lon,
        kind: describe(t) || t.amenity || t.shop || t.tourism || '', address: [street, t['addr:city']].filter(Boolean).join(', ') };
    });
  }))).catch(() => null);
  const params = new URLSearchParams({ q: name, lat: pos.lat.toFixed(6), lon: pos.lon.toFixed(6), limit: '20', lang: 'de' });
  const types = { N: 'node', W: 'way', R: 'relation' };
  const photon = fetchJson('https://photon.komoot.io/api/?' + params, {}, 10000, signal).then((json) => (json.features || [])
    .filter((f) => ['amenity', 'shop', 'tourism', 'leisure'].includes((f.properties || {}).osm_key))
    .map((f) => {
      const pr = f.properties;
      const c = f.geometry && f.geometry.coordinates;
      if (!c || !pr.name) return null;
      const street = [pr.street, pr.housenumber].filter(Boolean).join(' ');
      return { osmId: (types[pr.osm_type] || 'node') + '/' + pr.osm_id, name: pr.name, lat: c[1], lon: c[0],
        kind: describe({ [pr.osm_key]: pr.osm_value }), address: [street, pr.city].filter(Boolean).join(', ') };
    })).catch(() => null);
  const [o, p] = await Promise.all([over, photon]);
  if (signal && signal.aborted) throw new Error('abgebrochen');
  if (!o && !p) throw new Error('Suche gerade nicht möglich');
  return finish([...(o || []), ...(p || [])], pos, radius);
}
