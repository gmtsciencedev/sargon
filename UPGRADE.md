# Upgrading Sargon

This procedure upgrades an existing deployment to a newer release. It
assumes the layout from [`docs/deploy.md`](docs/deploy.md): binary,
config and data under one directory (`/opt/sargon` below), a systemd
service, and a PostgreSQL database. Substitute your own paths and
service name — an installation made under the former name Gowiki keeps
its `/opt/gowiki` paths and `gowiki` service, and needs no renaming.

An upgrade replaces two things: the server binary and the frontend
bundle. Data, configuration and the database stay in place; the server
applies database migrations itself at startup.

## 1. Read the release notes

Check [`CHANGELOG.md`](CHANGELOG.md) for every version between the one
you run and the one you install. Version-specific steps, when any, are
listed under [Version notes](#version-notes) below. To see what you
run now:

```bash
curl -s https://YOUR-WIKI-HOST/api/version
```

## 2. Download the release

Each release on [GitHub](https://github.com/sargonwiki/sargon/releases)
carries a server binary per platform and the frontend bundle:

```bash
TAG=v1.0.0
gh release download "$TAG" -R sargonwiki/sargon \
  -p "sargon-server-linux-amd64" -p "sargon-frontend-dist-$TAG.tar.gz"
```

Use the release artifacts rather than a local build: they are stamped
with the commit and build date that `/api/version` reports, which is
how you later prove which code is running. To build from source
instead, use `make build-backend-release` — a plain `go build` leaves
the stamp at `unknown`.

## 3. Back up

Back up before every upgrade, so a rollback restores data that matches
the old binary:

```bash
BACKUP=/var/backups/sargon/pre-$TAG
sudo mkdir -p "$BACKUP"
sudo rsync -a /opt/sargon/data/ "$BACKUP/data/"
sudo cp /opt/sargon/config.yaml "$BACKUP/"
sudo -u postgres pg_dump sargon | gzip | sudo tee "$BACKUP/db.sql.gz" >/dev/null
```

## 4. Install

Copy both files to the server, then swap them in. The previous binary
and bundle are kept next to the new ones for rollback.

```bash
scp sargon-server-linux-amd64 "sargon-frontend-dist-$TAG.tar.gz" $SERVER:/tmp/

ssh $SERVER "
  sudo systemctl stop sargon
  sudo mv /opt/sargon/sargon-server /opt/sargon/sargon-server.previous
  sudo install -m 755 -o sargon -g sargon /tmp/sargon-server-linux-amd64 /opt/sargon/sargon-server
  sudo rm -rf /opt/sargon/frontend/dist.previous
  sudo mv /opt/sargon/frontend/dist /opt/sargon/frontend/dist.previous
  sudo mkdir /opt/sargon/frontend/dist
  sudo tar xzf /tmp/sargon-frontend-dist-$TAG.tar.gz -C /opt/sargon/frontend/dist
  sudo chown -R sargon:sargon /opt/sargon/frontend/dist
  sudo systemctl start sargon
"
```

## 5. Verify

```bash
ssh $SERVER "sudo journalctl -u sargon --since '2 min ago' --no-pager | grep -E 'database|migrations|listening|WARNING'"
curl -s https://YOUR-WIKI-HOST/api/version
```

The log shows `database: connected` and `migrations applied`, with no
`WARNING`. `/api/version` reports the new version and the commit of
the release tag (`git rev-list -n 1 $TAG`). Then open a page, edit and
save it, and check that a page with a reviewflow still shows its
signatures.

## Rolling back

Stop the service, move the `.previous` binary and bundle back, restore
the database dump if the new version applied migrations, and start the
service again. Restore `data/` from the backup only if pages were
edited under the new version and must be discarded.

## Version notes

### 1.0.0 → 1.1.0-rc.1

Nothing to change. Serving several wikis from one process is opt-in
through `--sites`; see
[`docs/deploy.md`](docs/deploy.md#running-several-wikis-on-one-server).

### 1.0.0-rc.6 → 1.0.0

- Install a colour emoji font on the server so PDF exports print status
  icons such as 🔒: `sudo apt install fonts-noto-color-emoji`, then
  restart the service.
- Optionally set **Admin > Configuration > Time zone** (e.g.
  `Europe/Paris`) for the timestamp in PDF footers; without it the
  footer uses the server's zone and names it.

### 1.0.0-rc.5 → 1.0.0-rc.6

First release under the name Sargon. Nothing to change on an existing
installation: paths, service, database, configuration, sessions and
signatures carry over. Only the release artifact names changed, from
`gowiki-server-*` to `sargon-server-*`. MCP clients keep working with
their existing configuration.
