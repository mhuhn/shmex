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

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export async function nearbyPlaces(pos, radius = 500) {
  const lat = pos.lat.toFixed(6);
  const lon = pos.lon.toFixed(6);
  const q = `[out:json][timeout:20];(
nwr(around:${radius},${lat},${lon})["amenity"~"^(restaurant|cafe|fast_food|bar|pub|biergarten|ice_cream|food_court)$"]["name"];
nwr(around:${radius},${lat},${lon})["shop"~"^(bakery|butcher|deli|pastry|confectionery)$"]["name"];
);out center tags;`;
  let lastErr = null;
  for (const url of ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('OSM-Abfrage fehlgeschlagen (' + res.status + ')');
      const json = await res.json();
      const seen = new Set();
      return (json.elements || [])
        .map((el) => {
          const p = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center;
          if (!p) return null;
          const t = el.tags || {};
          const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
          return {
            osmId: el.type + '/' + el.id,
            name: t.name,
            lat: p.lat,
            lon: p.lon,
            kind: describe(t),
            address: [street, t['addr:city']].filter(Boolean).join(', '),
            distance: distance(pos, p),
          };
        })
        .filter((x) => x && x.name && !seen.has(x.osmId) && seen.add(x.osmId))
        .sort((a, b) => a.distance - b.distance);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr && lastErr.name !== 'AbortError' ? lastErr.message : 'Lokale aus OpenStreetMap konnten nicht geladen werden');
}
