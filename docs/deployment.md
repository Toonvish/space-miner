# Deployment

space-miner runs on the **same VPS as toon-household**, as its own Docker Compose stack in
`/opt/space-miner`. It has no proxy of its own: toon-household's Caddy owns ports 80/443, terminates
TLS for `SPACE_MINER_HOSTNAME` and proxies to the `space-miner` container over toon-household's Docker
network (toon-household ADR 0018). No port is published by this stack.

```
browser ──https/wss──▶ toon-household caddy :443 ──▶ space-miner:8080 (network toon-household_toon)
                          └─▶ app:3001 (toon-household)
```

## The pipeline

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every push / PR | `bun run build` (typecheck client + server, build client), `tools/smoke.ts` (boots the production server, joins the room); PRs also build the image (amd64, no push) |
| `release.yml` | push to `main`, tag `v*`, manual | the same checks, then a multi-arch image (amd64 + arm64) to `ghcr.io/toonvish/space-miner` (`:latest`, `:sha-…`, semver on tags), then **deploy** if `DEPLOY_ENABLED` |
| `deploy.yml` | called by release, or manual | SSH with a forced-command key: `deploy sha256:<digest>` |

The server runs exactly the digest the release built. A deploy that does not become healthy is not
adopted: `.env` keeps naming the last healthy image.

## One-time setup

All commands on the VPS unless noted. toon-household must already be running there.

### 1. DNS and toon-household's Caddy

Point an `A`/`AAAA` record (e.g. `space.example.org`) at the VPS. Then, in toon-household:

```bash
cd /opt/toon-household
toon-household-deploy sync-config          # fetches the Caddyfile with the space-miner site (ADR 0018)
echo 'SPACE_MINER_HOSTNAME=space.example.org' >> .env
docker compose up -d caddy                 # recreate caddy with the new variable -> fetches a certificate
```

(Until the space-miner container runs, that hostname answers 502. toon-household is unaffected.)

### 2. The stack directory

```bash
sudo mkdir -p /opt/space-miner && sudo chown "$USER" /opt/space-miner
cd /opt/space-miner
BASE=https://raw.githubusercontent.com/Toonvish/space-miner/main
curl -fsSL "$BASE/docker-compose.yml" -o docker-compose.yml
curl -fsSL "$BASE/docker/env.example"  -o .env
docker compose config -q && echo valid
```

### 3. The image must be pullable

The first push to `main` publishes the package. A new GHCR package is **private**: GitHub → your
profile → Packages → `space-miner` → Package settings → Change visibility → **Public**. (Or keep it
private and run `docker login ghcr.io` once on the VPS with a token that can read packages.)

### 4. First start

```bash
cd /opt/space-miner && docker compose pull && docker compose up -d
docker compose ps        # STATUS should become "healthy"
```

Open `https://space.example.org`.

### 5. Automatic deploys

1. **Install the deploy command:**

   ```bash
   sudo curl -fsSL https://raw.githubusercontent.com/Toonvish/space-miner/main/docker/space-miner-deploy.sh \
     -o /usr/local/bin/space-miner-deploy
   sudo chmod 755 /usr/local/bin/space-miner-deploy
   space-miner-deploy status
   ```

2. **A key for this repository only** (on your machine, not the VPS):

   ```bash
   ssh-keygen -t ed25519 -N '' -C space-miner-deploy -f space-miner-deploy
   ```

   Append the public key to the deploy user's `~/.ssh/authorized_keys` on the VPS, **pinned to the
   command** (the user must be in the `docker` group):

   ```
   restrict,command="/usr/local/bin/space-miner-deploy" ssh-ed25519 AAAA… space-miner-deploy
   ```

   This is a different key and line from toon-household's: each key drives exactly one app.

3. **GitHub → Settings → Secrets and variables → Actions** (ideally as `production` environment secrets):

   | Secret | Value |
   | --- | --- |
   | `DEPLOY_SSH_HOST` | VPS hostname or IP |
   | `DEPLOY_SSH_USER` | the deploy user |
   | `DEPLOY_SSH_KEY` | contents of the private key `space-miner-deploy` |
   | `DEPLOY_SSH_KNOWN_HOSTS` | output of `ssh-keyscan -p <port> <host>` |
   | `DEPLOY_SSH_PORT` | only if not 22 |

   | Variable | Value |
   | --- | --- |
   | `DEPLOY_ENABLED` | `true` (the master switch; leave unset until the secrets exist) |
   | `SPACE_MINER_HOSTNAME` | `space.example.org` (only for the link on the deployment) |

4. Test it: Actions → Release → Run workflow → tick "Deploy". Afterwards, every push to `main` deploys.

## Operations

| Task | Command (on the VPS) |
| --- | --- |
| Status | `space-miner-deploy status` |
| Deploy latest by hand | `space-miner-deploy deploy latest` |
| Roll back | `space-miner-deploy deploy sha256:<digest from an older release run>` |
| New compose file from `main` | `space-miner-deploy sync-config`, then the next deploy applies it |
| Logs | `cd /opt/space-miner && docker compose logs -f --tail=100` |
| Backup the world | `docker run --rm -v space-miner_space-miner-data:/d -v "$PWD":/b alpine cp /d/world.json /b/world-$(date +%F).json` |

The world (station, miners, pilots' cargo) is saved to the `space-miner-data` volume every 10 s, when
the last pilot leaves and on `docker compose stop`. Image pruning in the deploy script never touches
volumes.

## Resources

Measured with a full sector (12 pilots, 6 miners, 5 drones): ~2–3 % of one core, 80–100 MB RAM,
~16 KB/s downstream per connected pilot. The compose file caps the container at 384 MB. It fits next to
toon-household on a 1 vCPU / 1 GB VPS.
