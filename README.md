# Unsere Gerichte

Private Web-App (PWA) als persönliche Gerichte-Bibliothek für zwei iPhones:
ein **Hauptgerät** (pflegt die Daten) und ein **Lesegerät** (nur suchen, filtern, Zufall).
Reine statische Dateien ohne Build-Tools, gehostet auf GitHub Pages. Kein Server, keine Online-Datenbank:
alle Daten liegen lokal im iPhone (IndexedDB). Übertragen wird per Exportdatei über einen geteilten iCloud-Drive-Ordner.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst, Meta-Tags für den Home-Bildschirm |
| `app.css` | Gestaltung (hell/dunkel automatisch) |
| `manifest.webmanifest` | App-Name, Icon, `display: standalone` |
| `sw.js` | Service Worker: Offline-Betrieb, **enthält die Versionsnummer** |
| `icons/` | App-Icons (PNG) und ihre Vorlage `icon-source.svg` |
| `js/app.js` | Start, Startseite (Suche, Filter, Liste), „Was essen wir heute?“ |
| `js/detail.js` | Detailansicht eines Gerichts (mit Liste „Gekocht am“) |
| `js/cook.js` | Fenster „Früher gekocht“: vergangene Kochtage nachtragen |
| `js/edit.js` | Anlegen/Bearbeiten (Zutaten- und Tag-Eingabe mit Vorschlägen) |
| `js/settings.js` | Einstellungen, Export (zweistufig), Import, „Gerichte hinzufügen“ |
| `js/manage.js` | Zutaten umbenennen/zusammenführen, Zubereitungsarten pflegen |
| `js/io.js` | Exportdatei erzeugen, Dateien vollständig prüfen, importieren |
| `js/store.js` | Datenmodell und alle Datenänderungen |
| `js/search.js` | Suche, Filter, Sortierung, gewichtete Zufallsauswahl |
| `js/db.js` | IndexedDB (jede Änderung in einer Transaktion: alles oder nichts) |
| `js/photo.js` | Fotos verkleinern (1200 px JPEG + 360 px Vorschaubild) |
| `js/pwa.js` | Service-Worker-Anbindung, Hinweis „Neue Version“ |
| `js/ui.js` | Oberflächen-Bausteine: Seitenstapel mit Browser-Verlauf, Zurück-Wischen, Fenster von unten, Hinweise |
| `js/motion.js` | Übergänge mit der Web Animations API, weiche Liste, „Bewegung reduzieren“ |
| `js/gestures.js` | Wischgesten per Touch (folgen dem Finger, Schwelle nach Strecke und Tempo) |
| `js/util.js` | Hilfsfunktionen |
| `js/icons.js` | Symbole (SVG) im Stil der iOS-Systemsymbole |

### Datenmodell (IndexedDB „gerichte“)

- `dishes` – ein Eintrag pro Gericht (Felder siehe unten)
- `ingredients` – gemeinsame Zutatenliste `{ id, name }`; Gerichte verweisen per ID darauf
- `methods` – Zubereitungsarten `{ id, name, icon, order }` (erweiterbar)
- `photos`, `thumbs` – Foto und Vorschaubild je Gericht (Schlüssel = Gericht-ID, als ArrayBuffer)
- `cooks` – ein Eintrag je Gericht und Kochtag `{ id: "Gericht-ID|JJJJ-MM-TT", dishId, day, deleted, ts }`
  (seit 1.5.0, `DB_VERSION` 2). Gelöschte Tage bleiben mit `deleted: true` stehen, damit ein späterer Abgleich
  sie zusammenführen kann.
- `meta` – Gerätetyp, Datenstand, letzter Export, Zähler „Änderungen seit Export“, letzter Import

Gericht:

```
id, name, ingredientIds[], methodIds[], effort (1|2|3), diet ("vegan"|"vegetarisch"|null),
quick (Blitzgericht), mealPrep (fürs Vorkochen), cold (kaltes Gericht), meatOptional (Fleisch ergänzbar),
favorite, tags[], note, link, lastCooked ("JJJJ-MM-TT"), cookCount, cookCountBase, createdAt, updatedAt
```

`lastCooked` und `cookCount` werden aus `cooks` abgeleitet (neuester Kochtag; `cookCountBase` + Zahl der Kochtage).
`cookCountBase` zählt frühere Male ohne Datum aus der Zeit vor 1.5.0: Beim Umstieg wurde der bisherige letzte
Kochtag der erste Eintrag, die Gesamtzahl blieb gleich.

Frühere Felder `timeMin` (Zeit) und `dinner` (Abendbrot) werden nicht mehr verwendet; stehen sie noch in
alten Einträgen oder Dateien, bleiben sie einfach unbeachtet erhalten.

Unbekannte Zusatzfelder bleiben bei Export und Import erhalten. Spätere Funktionen
(Mengen, Kochschritte, Nährwerte, Einkaufsliste, Wochenplan) können als neue Felder bzw.
neue Stores ergänzt werden; dann `formatVersion` in `js/io.js` und `DB_VERSION` in `js/db.js` erhöhen.

## Dateiformat für „Gerichte hinzufügen“

Eine `.json`-Datei. Nur `name` ist Pflicht, alles andere ist optional.
Zutaten und Zubereitungsarten werden als **Namen** angegeben und beim Import der vorhandenen
Liste zugeordnet (Groß-/Kleinschreibung egal); fehlende werden neu angelegt.
Gerichte mit gleichem Namen oder gleicher ID wie ein vorhandenes werden übersprungen und aufgelistet.

```json
{
  "format": "gerichte-app",
  "formatVersion": 1,
  "kind": "dishes",
  "dishes": [
    {
      "name": "Chili sin Carne",
      "ingredients": ["Kidneybohnen", "Mais", "Tomaten", "Paprika"],
      "methods": ["Herd"],
      "effort": 3,
      "diet": "vegetarisch",
      "quick": false,
      "mealPrep": true,
      "cold": false,
      "meatOptional": true,
      "favorite": false,
      "tags": ["mexikanisch"],
      "note": "",
      "link": ""
    }
  ]
}
```

| Feld | Werte | Standard |
|---|---|---|
| `name` | Text (Pflicht) | – |
| `ingredients` | Liste von Zutatennamen | `[]` |
| `methods` | `Herd`, `Ofen`, `Heißluftfritteuse`, `Mikrowelle`, `ohne Kochen` (oder neue) | `[]` |
| `effort` | `1` Kaufen & aufwärmen, `2` Mittlerer Aufwand, `3` Größerer eigener Aufwand | leer |
| `diet` | `vegan` oder `vegetarisch` (ältere Angaben `fleisch`/`fisch` werden zu „leer“) | leer |
| `quick` | Blitzgericht | `false` |
| `mealPrep` | fürs Vorkochen geeignet | `false` |
| `cold` | kaltes Gericht | `false` |
| `meatOptional` | Fleisch kann extra ergänzt werden | `false` |
| `favorite`, `tags`, `note`, `link` | Favorit, freie Tags, Notiz, Link zum Originalrezept | leer |
| `id` | optional; fehlt sie, wird eine UUID erzeugt | – |
| `photo` | optional, `data:image/jpeg;base64,…` (wird verkleinert) | – |

Einige Schreibweisen werden automatisch erkannt: „Backofen“ → Ofen, „Airfryer“ → Heißluftfritteuse,
„Pfanne“/„Topf“/„Wok“ → Herd, „veggie“ → vegetarisch.
Eine komplette Exportdatei funktioniert ebenfalls als Quelle für „Gerichte hinzufügen“.

## Exportdatei (= Backup)

`Gerichte-JJJJ-MM-TT.json` mit `"kind": "backup"`, Exportzeitpunkt (`exportedAt`), Zutaten- und
Zubereitungslisten mit IDs und allen Gerichten inklusive Foto und Vorschaubild als Base64.
Ab `formatVersion` 2 (App 1.5.0) enthält sie zusätzlich die Liste `cooks` mit allen Kochtagen. Ältere Dateien
ohne `cooks` werden beim Import umgerechnet (letzter Kochtag = erster Eintrag). Ältere App-Versionen lehnen
Dateien mit `formatVersion` 2 ab – vor dem Datei-Austausch beide Geräte aktualisieren.
Der Import prüft die ganze Datei, bevor etwas geändert wird, und ersetzt dann alles in einer einzigen
Transaktion – bei einem Fehler bleibt der alte Stand erhalten.

## Änderungen veröffentlichen

1. Dateien hier im Ordner ändern (bzw. von Claude ändern lassen).
2. **In `sw.js` die Zeile `const VERSION = '…'` erhöhen** (z. B. `1.0.0` → `1.0.1`).
   Ohne neue Versionsnummer bekommen die iPhones das Update nicht.
3. Auf github.com im Repository die geänderten Dateien hochladen („Add file“ → „Upload files“),
   dabei die Ordnerstruktur beibehalten (`js/…`, `icons/…`), und „Commit changes“ bestätigen.
4. Nach ca. 1–2 Minuten ist die neue Version online. Beim nächsten Öffnen der App erscheint oben
   „Neue Version verfügbar“ → „Neu laden“. Die Daten bleiben dabei erhalten.

**Seit 29.10.2026 veröffentlicht Claude direkt per Git.** Der Projektordner ist ein Git-Repository
(`origin` = `tikki42/gerichte`; Abruf über HTTPS, Push über SSH). Für den Push gibt es einen Deploy Key, der nur
für dieses Repository gilt (`~/.ssh/gerichte_deploy`, auf GitHub unter Settings → Deploy keys, mit Schreibzugriff).
`planung/`, `vorlagen/`, `.claude/` und `.DS_Store` sind über `.git/info/exclude` ausgeschlossen.
Ablauf: Version in `sw.js` erhöhen → testen → `git add -A` → `git commit` → `git push origin main`.
Wurde zwischendurch über die Weboberfläche hochgeladen, vorher `git pull` (bzw. `git fetch` und prüfen).

Nicht hochladen: den Ordner `.claude/` (nur für lokale Tests), den Ordner `vorlagen/` (Excel-Vorlage zum Erfassen der Gerichte; Claude wandelt sie in eine Datei für „Gerichte hinzufügen“ um) und den Ordner `planung/` (Entwurf und Umsetzungsplan für Version 2.0).

## App-Icon ändern

Vorlage ist `icons/icon-source.svg` (1024 × 1024, ohne abgerundete Ecken – die rundet iOS selbst).
PNGs daraus auf dem Mac erzeugen (Quick Look rendert das SVG, `sips` skaliert):

```bash
qlmanage -t -s 1024 -o /tmp icons/icon-source.svg
```

Danach `/tmp/icon-source.svg.png` über JPEG (entfernt die Transparenz) in 512, 192 und 180 px als
`icon-512.png`, `icon-192.png` und `apple-touch-icon.png` speichern, Version in `sw.js` erhöhen.
Achtung: iOS übernimmt ein neues Icon erst, wenn die App neu zum Home-Bildschirm hinzugefügt wird.
Das löscht die Daten der App – vorher exportieren, danach „Backup wiederherstellen“.

## Lokal testen

```bash
python3 -m http.server 8765
```

Dann `http://localhost:8765` im Browser öffnen. Achtung: Der Service Worker liefert danach die
zwischengespeicherte Version aus – nach Änderungen die Versionsnummer in `sw.js` erhöhen.

## Hinweise für die Weiterarbeit in einem neuen Chat

- Keine Frameworks, keine Build-Tools; ES-Module direkt im Browser.
- Neue JS-Dateien in die Liste `FILES` in `sw.js` eintragen.
- Daten ändern nur über Funktionen in `js/store.js` (sie aktualisieren auch den Export-Zähler).
  „Heute gekocht“/„Machen wir“ und nachgetragene Kochtage zählen bewusst nicht als Änderung für den Export-Hinweis.
- Kochtage nur über `addCookDays`, `removeCookDays` und `markCooked` in `js/store.js` ändern; sie halten
  `lastCooked` und `cookCount` passend.
- Zoom: `touch-action: manipulation` auf allen Elementen verhindert das Zoomen per Doppeltippen,
  `gesturestart`/`gesturechange` werden abgefangen (kein Zwei-Finger-Zoom).
- Detailseite: „Bearbeiten“ steht oben rechts (`page.setRight` in `js/ui.js`), unten „Heute gekocht“ und der Kalender-Knopf.
- Seiten (seit 1.6.0): `openPage` legt je Seite einen Eintrag im Browser-Verlauf an (`history.state.gerichte` = Zahl der
  offenen Seiten). Zurück-Knopf, Zurück-Wischen und Browser-Zurück laufen darüber; `page.close()` geht selbst im Verlauf
  zurück. `beforeClose` gibt `true` zurück (Seite darf sofort zu) oder ein Promise (Rückfrage) – so federt das Wischen bei
  ungespeicherten Änderungen zurück und fragt. `openPage({ replace: true })` ersetzt die oberste Seite (Detail nach
  „Neues Gericht“). Verdeckte Seiten tragen `.under`/`.covered` (nicht antippbar, unsichtbar, Scroll-Position bleibt).
- Ausnahme seit 1.6.1: In der installierten App auf iPhone/iPad (`navigator.standalone`) legt die App **keine**
  Verlaufseinträge an. Findet iOS dort Einträge, wischt es selbst zurück (mit einem Standbild der vorigen Seite) –
  gleichzeitig mit der eigenen Geste, die Startseite erschien dann doppelt (1.6.0, iOS 27.2, iPhone 17 Pro).
  Alte Einträge (z. B. nach „Neu laden“ aus 1.6.0) verlässt die App sofort wieder.
- Zurück-Wischen: eigene Geste nur in der installierten iOS-App, 24 pt breiter Streifen am linken Rand, nur bei überwiegend
  waagrechter Bewegung; schließt ab 40 % der Breite oder bei kräftigem Schnippen, sonst federt die Seite zurück.
  In Safari übernimmt dessen eigene Geste über den Verlauf; hat der Browser den Wechsel schon gezeigt
  (`hasUAVisualTransition`), wird nicht noch einmal animiert.
- Fenster von unten: Griff oben, nach unten wegwischen am Kopf/Fuß oder im Inhalt, wenn dieser ganz oben steht.
- „Bewegung reduzieren“: Seiten, Fenster und Liste blenden nur über (`reduceMotion()` in `js/motion.js`).
- iPad/breite Fenster: ab 700 pt Breite Karten in 2 Spalten, ab 1000 pt in 3; Unterseiten mittig in 680 pt Breite,
  Fenster von unten mittig (ab 600 pt Höhe). Alles in `@media`-Regeln am Ende von `app.css`, darunter bleibt alles wie bisher.
- Testen im eingebauten Browser: Ist der Browser-Bereich verborgen, laufen Animationen nicht weiter – vorher
  `document.getAnimations().forEach(a => a.finish())`. Das Wischen lässt sich mit `TouchEvent`s und
  `Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })` prüfen (installierte
  iOS-App: kein Verlauf, eigene Geste an).
- Ist ein Fenster von unten offen, erscheinen Hinweise (Toasts) oben, damit sie keine Knöpfe verdecken.
- Lesegerät: alle datenändernden Knöpfe werden über `isMain()` ausgeblendet.
- Speichern ohne echte Änderung schreibt nichts und zählt nicht für den Export-Hinweis (`saveDish` vergleicht den Inhalt).
- Filterleiste: Favoriten, Aufwand, Zutaten, Zubereitung, Ernährung, Sonstiges (`OTHER_FILTERS` in `js/search.js`).
- Gestaltung: Farben als Variablen oben in `app.css` (hell und dunkel). Glas-Effekt über die Klasse `glass`.
- Statusleiste: bewusst `default` (nicht `black-translucent`). Mit durchscheinender Statusleiste zeichnet iOS
  (getestet iOS 27, iPhone mit Dynamic Island) die unteren ca. 60 pt nicht – unten entsteht ein leerer Streifen,
  der sich per CSS nicht füllen lässt. Die Farbe der Statusleiste kommt aus `theme-color` in `index.html`.
