# TabbySync

Self-hosted sync server for the [Tabby](https://tabby.sh) terminal. A replacement for Tabby-Web with protection against data loss.

## Protection concept

- Every device has its own token; revoked devices are rejected.
- The server remembers, per device, which state (base version) the device was last on.
- Uploads are combined by a 3-way merge per profile/group ID instead of simply overwriting.
- Only intentional deletions are applied. Profiles a device has never seen are kept.
- Settings: the last writer wins.
- The vault (saved passwords) and colour schemes are never merged field by field. On a vault conflict the server version wins and the uploaded vault is kept in the history (restorable).
- A device that has never downloaded (a new device) can only add new profiles and groups; settings, vault and existing profiles stay as on the server. Exception: the very first upload to an empty config is taken completely.
- Every version is stored (full history).
- Mass-deletion guard for profiles and groups: an upload is rejected if more than `MAX_PROFILE_DELETES` (default 5) or more than `MAX_DELETE_PERCENT` percent (default 50) of the existing profiles/groups are deleted at once. A single deletion is always allowed.
- The merged state reaches the uploading device on its next sync check (Tabby polls every 60 seconds).

## Installation in Dockhand

1. Create a new stack in Dockhand.
2. Paste the contents of `docker-compose.yml`. The image `ghcr.io/nupsnils/tabby-sync:latest` is built by GitHub Actions on every push to `main`.
3. Optionally set environment variables: `TABBYSYNC_PORT` (default 8080), `MAX_PROFILE_DELETES` (default 5), `MAX_DELETE_PERCENT` (default 50).
4. Deploy. Check on the Docker host: `curl http://127.0.0.1:8080/health` responds with 200.

### Private image: access to ghcr.io

If the repository is private, so is the image. Docker needs credentials to pull it:

1. On GitHub (account with access to the repo), go to Settings → Developer settings → Personal access tokens → Tokens (classic) and create a token with only `read:packages`.
2. Add a registry in Dockhand: address `ghcr.io`, user = GitHub username, password = token. Alternatively, run `docker login ghcr.io -u <github-user>` once on the server and enter the token as the password.

Without registry access you can build locally instead: clone the repo onto the server (`git clone https://github.com/NupsNils/tabby-sync.git`, using a token with the `repo` scope as the password) and replace the line `image: ...` in the compose file with `build: /path/to/tabby-sync`. To update, run `git pull` and redeploy the stack.

## Reverse proxy (Nginx Proxy Manager)

Tabby requires `https://`. The container only speaks plain HTTP, so by default its port is bound to `127.0.0.1`: it is reachable only from the Docker host, not from the LAN. This way the HTTPS requirement cannot be bypassed.

Pick the case that matches your setup:

- **NPM runs as a Docker container on the same host (usual case):** in `docker-compose.yml`, uncomment the `networks` block (both the part under the service and the top-level part) and set `name` to NPM's network (find it with `docker network ls`). Proxy target: `http://tabbysync:8080`.
- **NPM is installed directly on the host:** proxy target `http://127.0.0.1:8080`.
- **NPM runs on another host:** change the port binding to the server's LAN IP, e.g. `"192.168.1.10:8080:8080"`, and use `http://192.168.1.10:8080` as target. Warning: the plain-HTTP port is then reachable by everyone in the LAN.

Then in NPM:

1. Create a proxy host, e.g. `sync.example.com`, with the target from above.
2. SSL tab: choose a certificate (Let's Encrypt or your own CA; Tabby devices must trust it) and enable "Force SSL".
3. Websockets are not needed.

## Using the CLI

Admin functions are CLI only. There are two ways to run them:

1. **Dockhand container console** (you are already inside the container):
   ```
   node src/cli.js device add "Laptop"
   ```
2. **Shell on the Docker host:**
   ```
   docker exec -it tabbysync node src/cli.js device add "Laptop"
   ```

Below, only the short form (way 1) is shown. On the host, put `docker exec -it tabbysync` in front.

## Create a token per device

```
node src/cli.js device add "Laptop"
```

The token (`<device-token>`) is shown only once. Store it safely. Further commands: `device list`, `device revoke <id>`.

## Setup in Tabby

Settings → Config sync:

- Host: `https://sync.example.com` (no trailing path)
- Token: `<device-token>` of this device
- Create or select a config, enable automatic sync

First device: create a new, empty config and upload it ("Upload"). Further devices: just select the existing config. Their first upload only adds new profiles; within about a minute they receive the server state.

## History and restore

```
node src/cli.js config list
node src/cli.js versions <configId>
node src/cli.js restore <versionId>
```

Rejected uploads appear in the version list with the "rejected" flag. After `restore`, devices fetch the restored state within about a minute.

## Backup

Back up the volume `tabbysync-data` or the file `/data/tabbysync.db`.

## Limitations

- Encrypted Tabby configs (vault encryption) cannot be merged: one side wins as a whole (the server on conflict; the upload is kept in the history).
- Deleting a config from Tabby is disabled (403).
- The history grows without limit.
- A device that has never downloaded can only add new profiles and groups; settings, vault and existing profiles stay as on the server (except for the very first upload to an empty config).
- Tabby always downloads the server state on startup. Changes made while the server was unreachable are overwritten locally and never reach the history; the server cannot prevent this.
- Lists such as SSH known hosts are taken as a whole. If two devices add known hosts at the same time, one side's additions are lost (Tabby simply asks to confirm the host key again).

## Development

```
npm install
npm test
node src/server.js
```
