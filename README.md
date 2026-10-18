# TabbySync

Selbst gehosteter Sync-Server für das Terminal [Tabby](https://tabby.sh). Ersatz für Tabby-Web, mit Schutz vor Datenverlust.

## Schutzkonzept

- Jedes Gerät hat ein eigenes Token; gesperrte Geräte werden abgewiesen.
- Der Server merkt sich pro Gerät, auf welchem Stand (Basisversion) es zuletzt war.
- Uploads werden per 3-Wege-Merge pro Profil-/Gruppen-ID zusammengeführt, nicht einfach überschrieben.
- Nur absichtliche Löschungen werden übernommen. Profile, die ein Gerät nie gesehen hat, bleiben erhalten.
- Einstellungen: der letzte Schreiber gewinnt.
- Jede Version wird gespeichert (vollständige Historie).
- Schutz gegen Massenlöschung: werden mehr als `MAX_PROFILE_DELETES` Profile (Standard 5) auf einmal gelöscht, wird der Upload abgelehnt.
- Der zusammengeführte Stand erreicht das hochladende Gerät beim nächsten Abgleich (Tabby fragt alle 60 Sekunden).

## Installation in Dockhand

1. In Dockhand einen neuen Stack anlegen.
2. Inhalt von `docker-compose.yml` einfügen. Vorher `OWNER` im Image-Namen (`ghcr.io/OWNER/tabby-sync:latest`) durch den GitHub-Benutzernamen ersetzen (klein geschrieben). Das Image wird von GitHub Actions gebaut, sobald das Repository auf GitHub liegt.
3. Optional Umgebungsvariablen setzen: `TABBYSYNC_PORT` (Standard 8080), `MAX_PROFILE_DELETES` (Standard 5).
4. Deployen. Prüfen: `http://<server-ip>:8080/health` antwortet mit 200.

## Reverse Proxy (Nginx Proxy Manager)

Tabby verlangt `https://`. Der Container spricht nur HTTP im Heimnetz.

1. Proxy Host anlegen, z. B. `tabby.example.lan` → `http://<server-ip>:8080`.
2. Reiter SSL: Zertifikat wählen (Let's Encrypt oder eigene CA; Tabby-Geräte müssen ihm vertrauen), "Force SSL" aktivieren.
3. Websockets sind nicht nötig.

## Token pro Gerät anlegen

In der Konsole des Containers (Dockhand) oder per SSH:

```
docker exec -it tabbysync node src/cli.js device add "Laptop"
```

Das Token wird nur einmal angezeigt. Sicher notieren. Weitere Befehle: `device list`, `device revoke <id>`.

## Einrichtung in Tabby

Einstellungen → Config-Sync:

- Host: `https://tabby.example.lan` (ohne Pfad am Ende)
- Token: das Token dieses Geräts
- Config anlegen oder auswählen, automatische Synchronisation aktivieren

Erstes Gerät: Config anlegen und hochladen ("Upload"). Weitere Geräte: die vorhandene Config auswählen und zuerst herunterladen (lokale Daten überschreiben), danach synchronisieren.

## Historie und Wiederherstellung

```
docker exec -it tabbysync node src/cli.js config list
docker exec -it tabbysync node src/cli.js versions <configId>
docker exec -it tabbysync node src/cli.js restore <versionId>
```

Abgelehnte Uploads erscheinen in der Versionsliste mit dem Kennzeichen "rejected". Nach `restore` holen die Geräte den Stand innerhalb von etwa einer Minute.

## Backup

Das Volume `tabbysync-data` bzw. die Datei `/data/tabbysync.db` sichern.

## Einschränkungen

- Verschlüsselte Tabby-Configs (Vault-Verschlüsselung) können nicht zusammengeführt werden: hier gewinnt der letzte Schreiber.
- Config löschen über Tabby ist deaktiviert (403).
- Die Historie wächst unbegrenzt.
- Ein Gerät, das noch nie heruntergeladen hat, kann nur hinzufügen, nicht löschen.

## Entwicklung

```
npm install
npm test
node src/server.js
```
