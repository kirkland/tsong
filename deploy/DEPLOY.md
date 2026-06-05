# Deploying tsong on a single VPS

One box runs everything: Postgres, the Node server, and nginx (TLS + WebSocket
proxy). Cheap, simple, no orchestration. Tested against Ubuntu 24.04.

## 0. Get a box

Any small VPS works — Hetzner (~€4/mo), DigitalOcean / Linode (~$5/mo). The
smallest tier (1 vCPU, 1 GB RAM) is plenty. Create it with Ubuntu 24.04 and add
your SSH key, then `ssh root@SERVER_IP`.

## 1. Install the stack

```sh
apt update && apt upgrade -y
# Node 20 from NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs postgresql nginx git
```

## 2. Create the database

```sh
sudo -u postgres psql <<'SQL'
CREATE USER tsong WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE tsong OWNER tsong;
SQL
```

The app creates its own tables on startup (see `server/db.ts`), so there's no
schema to load.

## 3. Create a service user and fetch the code

```sh
adduser --system --group --home /opt/tsong tsong
cd /opt && git clone https://github.com/YOU/tsong.git
chown -R tsong:tsong /opt/tsong
cd /opt/tsong
sudo -u tsong npm ci
sudo -u tsong npm run build   # builds the client into client/dist
```

## 4. Configure environment

Create `/etc/tsong.env` (the systemd unit reads this). localhost Postgres needs
no SSL — the app's `sslFor()` handles that automatically.

```sh
cat > /etc/tsong.env <<'ENV'
PORT=3000
DATABASE_URL=postgres://tsong:CHANGE_ME@localhost:5432/tsong
ENV
chmod 600 /etc/tsong.env
```

## 5. Install the systemd service

```sh
cp /opt/tsong/deploy/tsong.service /etc/systemd/system/tsong.service
systemctl daemon-reload
systemctl enable --now tsong
systemctl status tsong          # should be "active (running)"
journalctl -u tsong -f          # live logs
```

At this point the game is live on `http://SERVER_IP:3000`.

## 6. nginx + HTTPS (recommended)

Point your domain's A record at the server IP, then:

```sh
cp /opt/tsong/deploy/nginx.conf /etc/nginx/sites-available/tsong
# edit server_name to your domain
ln -s /etc/nginx/sites-available/tsong /etc/nginx/sites-enabled/tsong
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d tsong.life   # auto-renews via systemd timer
```

Now it's live on `https://your-domain.com`, WebSocket and all.

## Updating later

From your laptop, after pushing to `main`:

```sh
./deploy/redeploy.sh          # pull, npm ci, build, then restart at a match break
./deploy/redeploy.sh --force  # restart immediately, even mid-match
```

The client is built **before** the restart (the build doesn't touch the running
server), so the only disruptive step is `systemctl restart`. By default the script
holds that restart until there's a gap between matches (polling `/api/status`, up to
~2 min) so no live rally is cut off. A graceful restart also snapshots the current
match to `.tsong-state.json`; the new process restores it and players reconnect into
the same game (frozen until they re-capture their mice) — and clients reconnect on
their own, so nobody has to refresh. Use `--force` (or `TSONG_FORCE=1`) to skip the
wait.

Override the target host with `TSONG_HOST=root@1.2.3.4 ./deploy/redeploy.sh`.
nginx and the TLS cert are left untouched — they only need attention if the
domain or proxy config changes. The equivalent manual steps on the box are:

```sh
cd /opt/tsong
sudo -u tsong git pull
sudo -u tsong npm ci
sudo -u tsong npm run build
systemctl restart tsong
```

## Backups (optional but easy)

```sh
# nightly dump via cron
echo '0 4 * * * postgres pg_dump tsong | gzip > /var/backups/tsong-$(date +\%F).sql.gz' \
  > /etc/cron.d/tsong-backup
```
