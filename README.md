# shmex

**Merken, was wem wo schmeckt.** shmex ist eine PWA fürs iPhone: Pro Restaurant, Café, Bäckerei oder Imbiss hältst du fest, wer aus der Familie welches Gericht wie fand. Wenn ihr wieder dort seid, erkennt die App den Ort und zeigt sofort „Wer mag was“.

## Funktionen

- **Daten im eigenen Google Drive**: eine JSON-Datei plus ein Fotoordner, angebunden über ein kleines Apps Script. Nach jeder Änderung wird gespeichert. Ohne Netz merkt sich die App alles lokal und speichert nach, sobald wieder Netz da ist. Ändern zwei Geräte gleichzeitig, werden die Änderungen pro Eintrag zusammengeführt.
- **Ort finden**: Gibt es gespeicherte Erfahrungen im Umkreis von 200 m, wird die Location automatisch gewählt. Sonst zeigt die App alle Lokale aus OpenStreetMap im Umkreis von 500 m, nach Entfernung sortiert. Alternativ trägst du einen eigenen Namen ein. Die Position lässt sich auf der Karte korrigieren.
- **Besuch eintragen**: Personen antippen (bekannte Namen werden vorgeschlagen) oder neu anlegen. Pro Person ein oder mehrere Gerichte, jeweils mit optionaler Gesamtwertung (1–5 Sterne), Menge (1–5), Preis/Leistung (1–5), Kommentar und Foto. Das Foto wird auf höchstens 100 kB verkleinert und im Drive abgelegt. Zusätzlich gibt es eine Wertung mit Kommentar für den ganzen Besuch.
- **Übersicht**: alle Locations durchsuchen (nach Name oder Gericht), sortieren (zuletzt besucht, Name, Bewertung, Entfernung), nach Mindestwertung filtern. Locations, Besuche, Gerichte, Fotos und Personen lassen sich bearbeiten und löschen.

## Einrichtung

### 1. Drive-Ordner anlegen

Lege in Google Drive einen Ordner an, z. B. `shmex`, und kopiere seinen Link (Teilen › Link kopieren). Der Ordner muss nicht öffentlich freigegeben werden, denn das Script läuft mit deinem Konto.

### 2. Apps Script einrichten

1. Öffne [script.google.com](https://script.google.com) und klicke auf **Neues Projekt**. Nenne es z. B. „shmex-Brücke“.
2. Ersetze den Inhalt von `Code.gs` durch den Inhalt von [`apps-script/Code.gs`](apps-script/Code.gs) aus diesem Repo.
3. Trage oben ein:
   - `FOLDER_URL`: den Link aus Schritt 1
   - `ACCESS_KEY`: einen selbst ausgedachten, längeren Schlüssel (z. B. aus einem Passwortgenerator)
4. Klicke auf **Bereitstellen › Neue Bereitstellung**, wähle beim Zahnrad **Web-App** und stelle ein:
   - Ausführen als: **Ich**
   - Zugriff: **Jeder**
5. Bestätige die Berechtigungsabfrage. Bei „Google hat diese App nicht überprüft“ klickst du auf „Erweitert“ und dann auf „Zu shmex-Brücke wechseln“. Es ist dein eigenes Script.
6. Kopiere die **Web-App-URL** (sie endet auf `/exec`).

> Änderst du später etwas am Script, musst du es neu bereitstellen: **Bereitstellungen verwalten › Bearbeiten › Version: Neue Version**. Die URL bleibt dabei gleich.

### 3. App veröffentlichen (GitHub Pages)

Im Repo unter **Settings › Pages** bei „Build and deployment“ die Quelle **Deploy from a branch** wählen, dann Branch `main` und Ordner `/ (root)`. Nach etwa einer Minute ist die App unter `https://mhuhn.github.io/shmex/` erreichbar.

### 4. Auf dem iPhone installieren

1. `https://mhuhn.github.io/shmex/` in Safari öffnen.
2. Teilen › **Zum Home-Bildschirm**.
3. shmex vom Homescreen starten, Web-App-URL und Zugangsschlüssel eingeben und auf **Verbinden** tippen. Liegt im Ordner schon eine `shmex-daten.json`, wird sie geladen. Sonst wird ein neuer, leerer Datensatz angelegt.
4. Den Standortzugriff erlauben.

Weitere Familienmitglieder verbinden ihre Geräte mit derselben URL und demselben Schlüssel und sehen dann dieselben Daten.

## Technik

- Reines HTML/CSS/JavaScript (ES-Module), kein Build-Schritt
- `js/store.js`: Datenmodell, lokale Kopie, Abgleich mit Revisionsprüfung und Zusammenführen pro Eintrag
- `js/photos.js`: Kompression auf ≤ 100 kB, Zwischenspeicher in IndexedDB, Upload-Warteschlange
- `js/geo.js`: Position, Overpass-Abfrage (OpenStreetMap)
- Karte: Leaflet mit OpenStreetMap-Kacheln
- Kopfleiste nach der bewährten iPhone-Lösung: Statusleiste `default`, gleiche Farbe für `html`, Kopfleiste, `theme-color` und Manifest, `body` fixiert, gescrollt wird nur im Inhaltsbereich

### Datenformat (`shmex-daten.json`)

```json
{
  "schema": 1, "rev": 12,
  "people":    [{ "id": "…", "name": "Anna" }],
  "locations": [{ "id": "…", "name": "Pizzeria Roma", "lat": 49.3, "lon": 8.64, "osmId": "node/1", "kind": "Restaurant · italienisch" }],
  "visits":    [{ "id": "…", "locationId": "…", "date": "2026-11-10", "personIds": ["…"], "rating": 4, "comment": "…" }],
  "dishes":    [{ "id": "…", "visitId": "…", "personId": "…", "name": "Pizza Funghi", "rating": 5, "amount": 4, "value": 3, "comment": "…", "photoId": "…", "photoFileId": "…" }]
}
```

Gelöschte Einträge bleiben mit `"deleted": true` erhalten, damit andere Geräte die Löschung übernehmen.
