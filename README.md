# Pflanzen-App (PWA)

Persönliche Pflanzen-App für iPhone. Läuft als Web-App ohne App Store, ohne Server und ohne laufende Kosten.

## Funktionen (Phase 1)

- Sammlung mit Foto, Standort, Gieß- und Düngeintervall
- Tagesansicht: was heute gegossen oder gedüngt werden muss, Winter-Modus (Nov–Feb)
- Wunschliste
- Pflanzenerkennung per Foto (Pl@ntNet)
- Pflegehinweise und Giftigkeit (Katze, Hund) für rund 34 Zimmerpflanzen
- Backup als JSON-Datei (Export und Import)

Geplant: Krankheitsdiagnose, Unkraut-Hilfe, Lichtmesser (Kamera-Schätzung), Frostwarnung, gemeinsame Sammlung.

## Auf dem iPhone nutzen

1. Seite in **Safari** öffnen.
2. Teilen-Symbol, dann „Zum Home-Bildschirm“.
3. App öffnen, unter „Mehr“ den Pl@ntNet-Schlüssel eintragen (kostenlos auf <https://my.plantnet.org>, 500 Erkennungen pro Tag).

Jedes Gerät hat eigene Daten. Der Schlüssel wird nur auf dem Gerät gespeichert und steht nicht im Code.

## Grenzen

- Keine Push-Nachrichten. Die Zahl am App-Icon zeigt fällige Pflanzen, wenn die App geöffnet wird.
- Daten liegen nur im Browser des Geräts. iOS kann sie löschen. Regelmäßig exportieren.
- Pflegewerte und Giftangaben sind Richtwerte (ASPCA-Liste als Orientierung, nicht einzeln geprüft).
- Pl@ntNet-Anfragen aus dem Browser können je nach Dienst-Konfiguration blockiert werden. Dann braucht es einen kleinen Proxy (Feld unter „Mehr“).

## Entwicklung

Reines HTML, CSS und JavaScript, kein Build-Schritt. Lokal starten: `python3 -m http.server` im Ordner, dann <http://localhost:8000>.

Bilderkennung: Pl@ntNet (<https://my.plantnet.org>).
