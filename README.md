# TabbySync

Self-hosted sync server for the [Tabby](https://tabby.sh) terminal. A replacement for Tabby-Web with protection against data loss.

## Protection concept

- Every device has its own token; revoked devices are rejected.
- The server remembers, per device, which state (base version) the device was last on.
- Uploads are combined by a 3-way merge per profile/group ID instead of simply overwriting.
- Only intentional deletions are applied. Profiles a device has never seen are kept.
- Settings: the last writer wins.
- Every version is stored (full history).
- Mass-deletion guard: if more than `MAX_PROFILE_DELETES` profiles (default 5) are deleted at once, the upload is rejected.
- The merged state reaches the uploading device on its next sync check (Tabby polls every 60 seconds).

## Installation in Dockhand

1. Create a new stack in Dockhand.
2. Paste the contents of `docker-compose.yml`. The image `ghcr.io/nupsnils/tabby-sync:latest` is built by GitHub Actions on every push to `main`.
3. Optionally set environment variables: `TABBYSYNC_PORT` (default 8080), `MAX_PROFILE_DELETES` (default 5).
4. Deploy. Check: `http://192.168.1.10:8080/health` responds with 200.

### Private image: access to ghcr.io

If the repository is private, so is the image. Docker needs credentials to pull it:

1. On GitHub (account with access to the repo), go to Settings → Developer settings → Personal access tokens → Tokens (classic) and create a token with only `read:packages`.
2. Add a registry in Dockhand: address `ghcr.io`, user = GitHub username, password = token. Alternatively, run `docker login ghcr.io -u <github-user>` once on the server and enter the token as the password.

Without registry access you can build locally instead: clone the repo onto the server (`git clone https://github.com/NupsNils/tabby-sync.git`, using a token with the `repo` scope as the password) and replace the line `image: ...` in the compose file with `build: /path/to/tabby-sync`. To update, run `git pull` and redeploy the stack.

## Reverse proxy (Nginx Proxy Manager)

Tabby requires `https://`. The container only speaks HTTP on the local network.

1. Create a proxy host, e.g. `sync.example.com` → `http://192.168.1.10:8080`.
2. SSL tab: choose a certificate (Let's Encrypt or your own CA; Tabby devices must trust it) and enable "Force SSL".
3. Websockets are not needed.

## Create a token per device

In the container console (Dockhand) or via SSH:

```
docker exec -it tabbysync node src/cli.js device add "Laptop"
```

The token (`<device-token>`) is shown only once. Store it safely. Further commands: `device list`, `device revoke <id>`.

## Setup in Tabby

Settings → Config sync:

- Host: `https://sync.example.com` (no trailing path)
- Token: `<device-token>` of this device
- Create or select a config, enable automatic sync

First device: create a config and upload it ("Upload"). Further devices: select the existing config and download it first (overwrite local data), then sync.

## History and restore

```
docker exec -it tabbysync node src/cli.js config list
docker exec -it tabbysync node src/cli.js versions <configId>
docker exec -it tabbysync node src/cli.js restore <versionId>
```

Rejected uploads appear in the version list with the "rejected" flag. After `restore`, devices fetch the restored state within about a minute.

## Backup

Back up the volume `tabbysync-data` or the file `/data/tabbysync.db`.

## Limitations

- Encrypted Tabby configs (vault encryption) cannot be merged: the last writer wins.
- Deleting a config from Tabby is disabled (403).
- The history grows without limit.
- A device that has never downloaded can only add, not delete.

## Development

```
npm install
npm test
node src/server.js
```
