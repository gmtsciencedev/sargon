# Deploying Sargon

This guide covers deploying Sargon on a Linux VPS with automatic HTTPS via Let's Encrypt. The target is a minimal setup: one binary, one config file, one Postgres database.

## Prerequisites

- A Linux server (Ubuntu 22.04+ or Debian 12+ recommended), 2 GB RAM, 1 vCPU
- A domain name pointed to the server's public IP (A record)
- Ports 80 and 443 open in the firewall
- PostgreSQL 14+ installed (needed for todo, database plugin, and structured data)
- Google Chrome or Chromium, for PDF export and page rendering, with a colour emoji font so status icons such as 🔒 print: `sudo apt install fonts-noto-color-emoji`

## 1. Build

On your development machine:

```bash
# Build the frontend bundle
make build-frontend

# Cross-compile the Go binary for Linux
cd backend
GOOS=linux GOARCH=amd64 go build -o sargon-server ./cmd/server
cd ..
```

This produces two artifacts:
- `backend/sargon-server` — the server binary
- `frontend/dist/` — the built frontend assets

## 2. Prepare the server

```bash
# Create a dedicated user
sudo useradd -r -m -d /opt/sargon -s /bin/bash sargon

# Create directory structure
sudo mkdir -p /opt/sargon/{frontend/dist,data}
sudo chown -R sargon:sargon /opt/sargon
```

## 3. Copy files

From your dev machine:

```bash
SERVER=user@your-server

# Binary
scp backend/sargon-server $SERVER:/opt/sargon/

# Frontend assets
rsync -a --delete frontend/dist/ $SERVER:/opt/sargon/frontend/dist/

# Data (first deploy only — contains pages, media, auth, metadata)
rsync -a backend/data/ $SERVER:/opt/sargon/data/
```

On subsequent deploys, only copy the binary and frontend assets. Do not overwrite `data/` — it contains your wiki content and configuration.

## 4. Set up PostgreSQL

```bash
sudo -u postgres createuser sargon
sudo -u postgres createdb -O sargon sargon
```

If you need a password (remote connections or `md5` auth):

```bash
sudo -u postgres psql -c "ALTER USER sargon PASSWORD 'your-secure-password';"
```

## 5. Create the config file

Create `/opt/sargon/config.yaml`:

```yaml
data_dir: /opt/sargon/data

server:
  tls_domain: wiki.example.com
  web_dir: /opt/sargon/frontend/dist

site:
  title: My Wiki
  base_url: https://wiki.example.com

auth:
  session_ttl: 72h

database:
  enabled: true
  dsn: postgres://sargon:your-secure-password@localhost/sargon?sslmode=disable

drafts:
  auto_save_interval: 2m
  stale_lock_timeout: 24h
```

Adjust `tls_domain`, `base_url`, and `dsn` to match your setup. If PostgreSQL uses local peer auth (no password), the DSN is simply `postgres:///sargon`.

**Important:** Always set `site.base_url` in production. When configured, the server rejects any HTTP request whose `Host` header does not match the expected hostname (returning a 404). This prevents the server from responding to requests via raw IP address or unexpected domain names pointing to the same server.

## 6. Create the systemd service

Create `/etc/systemd/system/sargon.service`:

```ini
[Unit]
Description=Sargon
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=sargon
Group=sargon
ExecStart=/opt/sargon/sargon-server -config /opt/sargon/config.yaml
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/sargon
PrivateTmp=true

# Allow binding to ports 80 and 443
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

The `CAP_NET_BIND_SERVICE` capability lets the `sargon` user bind to privileged ports (80, 443) without running as root.

## 7. Start the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sargon
```

Check that it started correctly:

```bash
sudo systemctl status sargon
sudo journalctl -u sargon -f
```

You should see logs like:

```
config: /opt/sargon/config.yaml
serving frontend assets from /opt/sargon/frontend/dist
data root: /opt/sargon/data
http: listening on :80 (ACME + redirect)
https: listening on :443 (domain: wiki.example.com)
```

The first HTTPS request triggers certificate provisioning from Let's Encrypt. This takes a few seconds. Subsequent requests use the cached certificate.

## 8. Configuration changes

Most site settings (`site.*`, `reviewflow.*`, `todo.notify.*`) are read dynamically and take effect immediately when saved from the admin UI.

However, some settings are only read at startup and require a service restart:

- `server.*` (addr, tls_domain, web_dir)
- `data_dir`
- `database.*`
- `auth.session_ttl`
- `site.base_url` (host filter)

After changing any of these, restart the service:

```bash
sudo systemctl restart sargon
```

## 9. Verify

```bash
curl -I https://wiki.example.com
```

You should get a `200 OK` with a valid TLS certificate.

## Updating

To upgrade an existing installation to a newer release, follow [`UPGRADE.md`](../UPGRADE.md).

## Backups

The critical data to back up:

| Path | Contents |
|------|----------|
| `/opt/sargon/data/content/` | All wiki pages and media files |
| `/opt/sargon/data/meta/` | Users, groups, ACL, sessions, page metadata |
| `/opt/sargon/data/attic/` | Page version history |
| `/opt/sargon/config.yaml` | Site configuration |
| PostgreSQL `sargon` database | Todo tasks, structured data tables |

Example daily backup with cron:

```bash
# /etc/cron.daily/sargon-backup
#!/bin/bash
BACKUP_DIR=/var/backups/sargon/$(date +%Y-%m-%d)
mkdir -p "$BACKUP_DIR"
rsync -a /opt/sargon/data/ "$BACKUP_DIR/data/"
cp /opt/sargon/config.yaml "$BACKUP_DIR/"
pg_dump -U sargon sargon | gzip > "$BACKUP_DIR/sargon.sql.gz"
# Keep 30 days
find /var/backups/sargon -maxdepth 1 -mtime +30 -exec rm -rf {} +
```

## Running without TLS

If you're behind a load balancer or reverse proxy that handles TLS, remove `tls_domain` and set `addr`:

```yaml
server:
  addr: ":8080"
  web_dir: /opt/sargon/frontend/dist
```

The server listens on plain HTTP. Your reverse proxy should forward to `:8080` and set `X-Forwarded-Proto: https`.

In this mode, remove `AmbientCapabilities=CAP_NET_BIND_SERVICE` from the systemd unit since port 8080 doesn't require elevated privileges.

## Running several wikis on one server

One Sargon process can serve several independent wikis. Start it with
`--sites` pointing at a directory that holds one subdirectory per wiki.
Each wiki has its own configuration, data directory, database, users,
ACLs, search index and background jobs; the wikis share the process,
the binary, the frontend bundle, the listening ports, the TLS
certificate cache and one headless Chrome. No data is shared between
wikis.

Each wiki needs its own hostname (`wiki1.example.com`,
`wiki2.example.com`). Sargon routes every request by its `Host`, serves
each wiki from the root of its domain, and browser logins are scoped to
the hostname, so separate hostnames also mean separate logins.

### Layout

```
/opt/sargon/sargon-server        binary
/opt/sargon/frontend/dist        frontend bundle
/opt/sargon/wikis/wiki1/         config.yaml + data/
/opt/sargon/wikis/wiki2/         config.yaml + data/
/opt/sargon/wikis/certs/         Let's Encrypt certificates (created by the server)
```

Every subdirectory of `wikis/` that holds a `config.yaml` is a wiki,
named after its directory in the log (`[wiki1] …`). Other
subdirectories are ignored.

### One database per wiki

```bash
sudo -u postgres createdb -O sargon sargon_wiki1
sudo -u postgres createdb -O sargon sargon_wiki2
```

### One configuration per wiki

`/opt/sargon/wikis/wiki1/config.yaml`:

```yaml
server:
  tls_domain: wiki1.example.com
  web_dir: /opt/sargon/frontend/dist

site:
  title: First Wiki
  base_url: https://wiki1.example.com

database:
  enabled: true
  dsn: postgres:///sargon_wiki1
```

The second wiki has its own `tls_domain`, title, `base_url` and
database. Other rules:

- `server.tls_domain` is the hostname the wiki answers to, and the
  server obtains its certificate. Either every wiki sets it, or none
  does (see [Behind a reverse proxy](#behind-a-reverse-proxy)); the
  server refuses to start on a mix.
- The data directory is `data/` next to `config.yaml`. To put it
  elsewhere, set `data_dir`; a relative path is resolved against the
  wiki's directory.
- `server.addr` is ignored: the wikis share the listening ports.
- Two wikis with the same hostname or the same data directory stop
  the server at startup with an error naming both.

### systemd service

The service from [step 6](#6-create-the-systemd-service) with a
different `ExecStart` and write path:

```ini
ExecStart=/opt/sargon/sargon-server --sites /opt/sargon/wikis
ReadWritePaths=/opt/sargon/wikis
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart sargon
sudo journalctl -u sargon --since '2 min ago' --no-pager | grep -E 'serving|WARNING'
```

The log ends with `serving 2 wikis: wiki1.example.com, wiki2.example.com`.

### Adding a wiki later

Create the database, write `/opt/sargon/wikis/<name>/config.yaml`,
point the hostname's DNS at the server, and restart the service. The
restart takes every wiki offline for a few seconds.

### Turning an existing installation into one wiki among several

Create `/opt/sargon/wikis/<name>/`, move `config.yaml` into it, and
either move `data/` next to it or keep `data_dir` pointing at the
current data directory (an absolute path stays valid). Remove
`server.addr` if set. Then switch the service to `--sites` as above.
The certificate is obtained again into `wikis/certs/` on the first
request.

### Behind a reverse proxy

If something else terminates TLS, leave `tls_domain` unset in every
wiki: each wiki then answers to the hostname of its `site.base_url`,
and the server listens in plain HTTP on `--addr` (default `:8080`,
e.g. `--addr 127.0.0.1:8080`). The proxy forwards every hostname to
that one address, keeping the `Host` header.

### Sizing

Sargon takes about 55 MB per wiki, and the shared headless Chrome about
250 MB once a PDF has been exported. A 2 GB server holds ten wikis or
more of the size of a team wiki.

### Isolation

The wikis share a process. A crash takes them all offline until
systemd restarts the service, and an upgrade upgrades them all. For a
wiki that needs its own release schedule or its own failure domain —
regulated records, say — run it as a separate installation with its
own service, as in the main procedure above.

### Upgrades and backups

Follow [`UPGRADE.md`](../UPGRADE.md) once for the shared binary and
bundle. Back up each wiki's `data/` directory and database separately.

## Troubleshooting

**Certificate provisioning fails**
- Verify DNS: `dig wiki.example.com` must return the server's public IP.
- Verify port 80 is reachable: `curl http://wiki.example.com` from another machine.
- Check firewall: `sudo ufw status` or `sudo iptables -L -n`.
- Check logs: `journalctl -u sargon -e` for ACME errors.

**"permission denied" binding to port 80/443**
- Ensure `AmbientCapabilities=CAP_NET_BIND_SERVICE` is in the systemd unit.
- Run `sudo systemctl daemon-reload` after editing the unit file.

**Database connection refused**
- Check PostgreSQL is running: `sudo systemctl status postgresql`.
- Check the DSN in config.yaml matches your PostgreSQL auth method (`peer` vs `md5`).
- For local peer auth, the system user (`sargon`) must match the PostgreSQL role name.

**OAuth callback URL mismatch**
- Update `site.base_url` in config.yaml to match the public URL exactly.
- Update the callback URL in your OAuth provider (Azure AD, etc.) to `https://wiki.example.com/api/auth/oauth/callback`.
