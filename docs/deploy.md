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

One Sargon process serves one wiki. To host several independent wikis on
the same machine, run one instance per wiki behind a reverse proxy: each
instance has its own configuration, data directory, database and
service, and shares only the binary, the frontend bundle and the
PostgreSQL server. No data is shared between instances.

Each wiki needs its own hostname (`wiki1.example.com`,
`wiki2.example.com`): Sargon serves from the root of its domain, and
browser logins are scoped to the hostname, so separate hostnames also
mean separate logins.

### Layout

```
/opt/sargon/sargon-server        shared binary
/opt/sargon/frontend/dist        shared frontend bundle
/opt/sargon/wikis/wiki1/         config.yaml + data/
/opt/sargon/wikis/wiki2/         config.yaml + data/
```

### One database per wiki

```bash
sudo -u postgres createdb -O sargon sargon_wiki1
sudo -u postgres createdb -O sargon sargon_wiki2
```

### One configuration per wiki

Each instance listens on its own local port without TLS; the reverse
proxy holds the certificates. Bind to `127.0.0.1` so instances are
reachable only through the proxy — Sargon trusts the forwarded client
address and protocol headers, which only the proxy may set.

`/opt/sargon/wikis/wiki1/config.yaml`:

```yaml
data_dir: /opt/sargon/wikis/wiki1/data

server:
  addr: "127.0.0.1:8081"
  web_dir: /opt/sargon/frontend/dist

site:
  title: First Wiki
  base_url: https://wiki1.example.com

database:
  enabled: true
  dsn: postgres:///sargon_wiki1
```

The second wiki uses `127.0.0.1:8082`, its own `data_dir`, title,
`base_url` and database. `base_url` must match the hostname the proxy
serves it under: Sargon rejects requests for any other host.

### One systemd template for all instances

`/etc/systemd/system/sargon@.service` — `%i` is the wiki name:

```ini
[Unit]
Description=Sargon (%i)
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=sargon
Group=sargon
ExecStart=/opt/sargon/sargon-server -config /opt/sargon/wikis/%i/config.yaml
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/sargon/wikis/%i
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sargon@wiki1 sargon@wiki2
```

### Reverse proxy

[Caddy](https://caddyserver.com/) obtains and renews the certificates
itself and sets the forwarded headers. `/etc/caddy/Caddyfile`:

```
wiki1.example.com {
    reverse_proxy 127.0.0.1:8081
}

wiki2.example.com {
    reverse_proxy 127.0.0.1:8082
}
```

```bash
sudo systemctl reload caddy
```

### Adding a wiki later

Pick the next free port, then: create the database, write
`/opt/sargon/wikis/<name>/config.yaml`, add a block to the Caddyfile,
point the hostname's DNS at the server, and run
`sudo systemctl enable --now sargon@<name>` and
`sudo systemctl reload caddy`.

### Sizing

Each instance runs its own headless Chrome for PDF export, and that is
what sets the memory budget: plan for roughly 300 MB per wiki (Sargon
itself takes about 55 MB). A 2 GB server holds three to four wikis.

### Upgrades and backups

Upgrading the shared binary and bundle upgrades every wiki at once:
follow [`UPGRADE.md`](../UPGRADE.md), restarting each instance
(`sudo systemctl restart 'sargon@*'`). Back up each wiki's `data/`
directory and database separately.

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
