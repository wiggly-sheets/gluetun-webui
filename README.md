<div align="right">
  <details>
    <summary >🌐 Language</summary>
    <div>
      <div align="center">
        <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=en">English</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=zh-CN">简体中文</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=zh-TW">繁體中文</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=ja">日本語</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=ko">한국어</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=hi">हिन्दी</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=th">ไทย</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=fr">Français</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=de">Deutsch</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=es">Español</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=it">Italiano</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=ru">Русский</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=pt">Português</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=nl">Nederlands</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=pl">Polski</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=ar">العربية</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=fa">فارسی</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=tr">Türkçe</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=vi">Tiếng Việt</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=id">Bahasa Indonesia</a>
        | <a href="https://openaitx.github.io/view.html?user=Sir-Scuzza&project=gluetun-webui&lang=as">অসমীয়া</
      </div>
    </div>
  </details>
</div>

# Gluetun WebUI

A lightweight web UI for monitoring and controlling [Gluetun](https://github.com/qdm12/gluetun) — the VPN client container for Docker.

This is a fork of [Sir-Scuzza/gluetun-webui](https://github.com/Sir-Scuzza/gluetun-webui). The upstream publishes the `scuzza/gluetun-webui` image; the fork additions described below exist only in this repo, so build from this repo (Option B) unless you publish your own image.

![Status: Connected](https://img.shields.io/badge/status-connected-brightgreen)
![Node 25](https://img.shields.io/badge/node-25--alpine-blue)
![Docker](https://img.shields.io/badge/docker-compose-blue)

---

## Features

- ✨ **Multi-VPN Support** — Monitor & control up to 20 Gluetun instances simultaneously
- Live VPN status banner (connected / paused / disconnected)
- Public exit IP with **auto-detected IPv6** — shows both IPv4 and IPv6 when available
- VPN provider, protocol (WireGuard / OpenVPN), server details
- Port forwarding and DNS status
- Start / Stop VPN controls
- Auto-refresh with configurable interval (5s – 60s)
- Last 30 poll ticks colour-coded in history bar
- Latency bar chart showing round-trip time to each Gluetun instance (green/yellow/red), with per-instance history persisted in the browser
- **Speed Test** — Run Ookla speed tests from the UI, track download/upload/ping over time (opt-in)
- AirVPN integration — server load, health, bandwidth, and forwarded ports (requires `AIRVPN_API_KEY`)
- Provider integrations — server cards for NordVPN, Mullvad, IVPN, PIA, Windscribe, Surfshark, ProtonVPN, and PrivadoVPN
- Editable dashboard — reorder cards by dragging, resize them from the right edge, hide or show cards, and reset to defaults (per instance, saved in localStorage)
- Theme picker — dark, light, or auto (follows the OS); applied before first paint and saved in localStorage
- Responsive design (mobile, tablet, desktop)
- Server selection dropdown (all providers)
- Persistent polling interval selection (via localStorage)

---

## Screenshots
![alt text](image-1.png)

---

## Requirements

- Docker + Docker Compose
- Gluetun running with its HTTP control server enabled (default port `8000`)
- Gluetun and gluetun-webui on the same Docker network

> Supports `linux/amd64` and `linux/arm64` (works on Mac Intel/Apple Silicon, Linux, and Windows).

---

## Quick Start

### Option A1: Single Instance (Recommended)

Add `gluetun-webui` to your existing compose file alongside Gluetun:

```yaml
gluetun-webui:
  image: scuzza/gluetun-webui:latest
  container_name: gluetun-webui
  ports:
    - "127.0.0.1:3000:3000"
  environment:
    - GLUETUN_CONTROL_URL=http://gluetun:8000
    # Uncomment if Gluetun auth is enabled:
    #- GLUETUN_API_KEY=yourtoken
    #- GLUETUN_USER=username
    #- GLUETUN_PASSWORD=password
  networks:
    - your_network_name
  restart: unless-stopped
  read_only: true
  tmpfs:
    - /tmp
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/healthz"]
    interval: 30s
    timeout: 5s
    start_period: 10s
    retries: 3
```

### Option A2: Multiple Instances

Monitor 2+ Gluetun instances with separate dashboards:

```yaml
gluetun-webui:
  image: scuzza/gluetun-webui:latest
  container_name: gluetun-webui
  ports:
    - "127.0.0.1:3000:3000"
  environment:
    - GLUETUN_1_NAME=VPN - London
    - GLUETUN_1_URL=http://gluetun-1:8000
    - GLUETUN_1_API_KEY=token1

    - GLUETUN_2_NAME=VPN - Amsterdam
    - GLUETUN_2_URL=http://gluetun-2:8000
    - GLUETUN_2_API_KEY=token2

    - GLUETUN_3_NAME=VPN - Singapore
    - GLUETUN_3_URL=http://gluetun-3:8000
    - GLUETUN_3_API_KEY=token3
  networks:
    - your_network_name
  restart: unless-stopped
  read_only: true
  tmpfs:
    - /tmp
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
```

### Option B: Build Locally

```bash
git clone https://github.com/wiggly-sheets/gluetun-webui.git
cd gluetun-webui
docker compose up -d --build
```

Use this option to get the fork features described in this README. The pre-built `scuzza/gluetun-webui` image is the upstream release.

Then run (either option):

```bash
docker compose up -d
```

The UI is available at **http://localhost:3000**

---

## Network Setup

Both Gluetun and gluetun-webui must be on the same Docker network so `http://gluetun:8000` resolves correctly.

**Same compose file** — just add both services to the same network (most common):

```yaml
services:
  gluetun:
    networks:
      - arr-stack
  gluetun-webui:
    networks:
      - arr-stack

networks:
  arr-stack:
    driver: bridge
```

**Separate compose files** — reference Gluetun's existing network as external. Find your network name with `docker network ls`:

```yaml
networks:
  ext-network:
    external: true
    name: your_gluetun_network_name
```

---

## Provider Integrations

Per-provider server cards show live data about the server you are connected to. Each adapter fetches the provider's public server list (no API key required), matches the connected server, and renders a card on the dashboard:

| Provider | Card | Data shown |
|---|---|---|
| AirVPN | Rich card | Health, load, bandwidth, users, location, session transfer/speed (requires `AIRVPN_API_KEY`) |
| NordVPN | Generic card | Server name, location, load |
| Mullvad | Generic card | Server name, location, owned status, account expiry (with `MULLVAD_ACCOUNT_NUMBER`) |
| IVPN | Generic card | Server name, location, load |
| PIA | Generic card | Server name, location, port forwarding status |
| Windscribe | Generic card | Server name, location |
| Surfshark | Auth card | Server name, location, load, subscription expiry (requires `SURFSHARK_USER` + `SURFSHARK_PASSWORD`) |
| ProtonVPN | Auth card | Server name, location, load (requires `PROTONVPN_USER` + `PROTONVPN_PASSWORD`) |
| PrivadoVPN | Generic card | Server name, location, load |

The generic card appears for any instance whose Gluetun provider is registered and disappears when the connected server cannot be matched (renamed/removed server) or the provider list is unreachable. More providers can be added incrementally by registering an adapter in `src/provider-integrations.js` — no frontend changes are needed for generic cards.

---

## Multi-VPN Support

### Multiple Instances

gluetun-webui supports monitoring and controlling **multiple Gluetun instances simultaneously**. Each instance displays as a separate dashboard in a responsive grid.

**Configuration**: Use numbered environment variables:

```yaml
gluetun-webui:
  image: scuzza/gluetun-webui:latest
  environment:
    # Instance 1
    - GLUETUN_1_NAME=VPN 1
    - GLUETUN_1_URL=http://gluetun-1:8000
    - GLUETUN_1_API_KEY=token1  # optional

    # Instance 2
    - GLUETUN_2_NAME=VPN 2
    - GLUETUN_2_URL=http://gluetun-2:8000
    - GLUETUN_2_API_KEY=token2  # optional

    # Instance 3
    - GLUETUN_3_NAME=VPN 3
    - GLUETUN_3_URL=http://gluetun-3:8000
    - GLUETUN_3_USER=admin
    - GLUETUN_3_PASSWORD=secret  # optional (HTTP Basic auth)
```

**Supported**: Up to 20 instances (via `GLUETUN_1_URL` through `GLUETUN_20_URL`)  
**Responsive**: 1 full-width dashboard → 2 half-width → 3 third-width → 4 quarter-width → scrollable at 5+

### Backward Compatibility

If no numbered variables are configured, falls back to **legacy single-instance mode**:

```yaml
environment:
  - GLUETUN_CONTROL_URL=http://gluetun:8000  # legacy
  - GLUETUN_API_KEY=token
```

### Per-Instance Authentication

Each instance can have different authentication:

```yaml
# Instance with API key
- GLUETUN_1_API_KEY=my-secret-token

# Instance with HTTP Auth
- GLUETUN_2_USER=admin
- GLUETUN_2_PASSWORD=mysecret

# Instance with no auth
- GLUETUN_3_URL=http://gluetun-3:8000  # auth optional
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GLUETUN_1_*` to `GLUETUN_20_*` | _(empty)_ | **Multi-instance config** (up to 20 instances) |
| `GLUETUN_{N}_URL` | – | Gluetun HTTP control server URL for instance N |
| `GLUETUN_{N}_NAME` | `Instance {N}` | Display name for instance N |
| `GLUETUN_{N}_API_KEY` | _(empty)_ | Bearer token for instance N (if auth enabled) |
| `GLUETUN_{N}_USER` | _(empty)_ | Username for HTTP Basic auth (instance N) |
| `GLUETUN_{N}_PASSWORD` | _(empty)_ | Password for HTTP Basic auth (instance N) |
| `GLUETUN_{N}_IP_DISPLAY_MODE` | `auto` | IP display mode: `auto` (show both if IPv6 detected), `dual` (force both), or `single` (primary IP only) |
| `GLUETUN_{N}_AIRVPN_API_KEY` | _(empty)_ | AirVPN API key for server status & port forwarding (also settable globally via `AIRVPN_API_KEY`) |
| `AIRVPN_API_KEY` | _(empty)_ | **Global** AirVPN API key used across all instances unless overridden per-instance |
| `MULLVAD_ACCOUNT_NUMBER` | _(empty)_ | Mullvad account number; when set, the Mullvad provider card also shows the account expiry date |
| `SURFSHARK_USER` / `SURFSHARK_PASSWORD` | _(empty)_ | Optional — Surfshark account credentials. Only needed for the Surfshark provider card (server name, location, load, subscription expiry); without them no Surfshark card is shown and no network calls are made |
| `PROTONVPN_USER` / `PROTONVPN_PASSWORD` | _(empty)_ | Optional — ProtonVPN account credentials. Only needed for the ProtonVPN provider card (server name, location, load); without them no ProtonVPN card is shown and no network calls are made. Accounts with two-factor authentication (2FA) enabled are not supported |
| `FORWARDED_PORT` | _(empty)_ | **Global** forwarded port shown when Gluetun reports 0 (AirVPN doesn't write to its status file) |
| `GLUETUN_{N}_FORWARDED_PORT` | _(empty)_ | Per-instance forwarded port, overrides `FORWARDED_PORT` |
| `GLUETUN_CONTROL_URL` | `http://gluetun:8000` | **Legacy** – single instance only (fallback if no `GLUETUN_1_*` vars) |
| `GLUETUN_API_KEY` | _(empty)_ | **Legacy** – Bearer token for single instance |
| `GLUETUN_USER` | _(empty)_ | **Legacy** – Username for HTTP Basic auth |
| `GLUETUN_PASSWORD` | _(empty)_ | **Legacy** – Password for HTTP Basic auth |
| `PORT` | `3000` | Port the web UI listens on |
| `DEFAULT_POLL_INTERVAL` | _(empty)_ | Default polling interval in milliseconds (e.g., 10000 for 10s). If set, used when no saved preference exists in localStorage. Must be one of: 0, 5000, 10000, 30000, 60000. |
| `TRUST_PROXY` | `false` | Set to `true` if running behind a reverse proxy (nginx, Traefik, etc.) |
| `ALLOWED_HOSTS` | _(defaults always allowed)_ | Extra comma-separated hosts for the Host header allowlist (DNS rebinding protection). `localhost`, `127.0.0.1` and `[::1]` are always allowed. Set it when accessing via LAN IP or a reverse-proxy domain, e.g. `ALLOWED_HOSTS=vpn.example.com`. |
| `LATENCY_CHART` | `true` | Round-trip latency chart is shown by default. Set to `false` to disable it and its polling overhead. |
| `LATENCY_CHART_RENDERER` | `svg` | Chart renderer: `svg` (bundled, no dependency) or `plotly` (loads the Plotly bundle from the image). |
| `SPEEDTEST_ENABLED` | `false` | Enable the speed test card (requires Ookla CLI binary in image) |
| `SPEEDTEST_HISTORY_FILE` | `/data/speedtest-history.json` | Path for persisted speed test history. Falls back to the app directory when `/data` does not exist. |
| `SPEEDTEST_BIN` | `/usr/local/bin/speedtest` | Path to the Ookla speedtest CLI binary |
| `WEBUI_USER` | _(empty)_ | **Optional** – enable Web UI login (must set both `WEBUI_USER` and `WEBUI_PASSWORD`) |
| `WEBUI_PASSWORD` | _(empty)_ | **Optional** – password for Web UI login (also sets the session signing key) |

### Docker Secrets

Most configuration values can be supplied as Docker secrets instead of environment variables. The app reads `/run/secrets/<name>` first and falls back to the environment. The secret name is the lowercase variable name, for example `gluetun_1_api_key`, `gluetun_1_password`, `airvpn_api_key`, `webui_user`, or `webui_password`.

The remaining feature flags (`PORT`, `TRUST_PROXY`, `ALLOWED_HOSTS`, `LATENCY_CHART`, `LATENCY_CHART_RENDERER`, `DEFAULT_POLL_INTERVAL`, `SPEEDTEST_*`, `MULLVAD_ACCOUNT_NUMBER`) are read from environment variables only.

---

## Web UI Authentication

Authentication is **opt-in and disabled by default**. Set both `WEBUI_USER` and `WEBUI_PASSWORD` (as env vars or Docker secrets `webui_user` / `webui_password`) to require a login before the dashboard loads. If only one of the two is set, the app refuses to start.

```yaml
environment:
  - WEBUI_USER=admin
  - WEBUI_PASSWORD=mysecret
```

```yaml
secrets:
  - webui_user
  - webui_password
```

When enabled, all `/api/*` routes except `POST /api/login`, `GET /api/auth`, and `GET /api/healthz` require a signed session cookie. Log in via the UI, or sign out with the **Log out** button in the header. Sessions last 7 days and are invalidated if the password changes. Logout invalidates sessions only until the server restarts, since the session version counter is kept in memory.

> **Docker HEALTHCHECK:** use `http://localhost:3000/api/healthz` (public, no sensitive data) — `/api/health` is protected and returns 401 when auth is enabled.

> **Note:** since Gluetun v3.39.1 the control server requires authentication by default. Set `HTTP_CONTROL_SERVER_AUTH_DEFAULT_ROLE: '{"auth":"none"}'` on the gluetun service (as in the example compose file) or configure `/gluetun/auth/config.toml`, otherwise the web UI's `/v1/*` queries will be rejected.

---

## Security

- Port is bound to `127.0.0.1` — not exposed to the network
- Container runs as non-root with read-only filesystem and dropped capabilities
- Rate limiting applied to all API routes
- Upstream error details are logged server-side only — generic messages returned to the browser

### Reverse-proxy configuration

If you run gluetun-webui behind a reverse proxy (nginx, Traefik, Caddy, etc.), set `TRUST_PROXY=true` in your environment variables:

```yaml
gluetun-webui:
  image: scuzza/gluetun-webui:latest
  environment:
    - GLUETUN_CONTROL_URL=http://gluetun:8000
    - TRUST_PROXY=true  # Required for reverse proxies
```

This allows the app to correctly parse `X-Forwarded-For` and related headers for accurate rate limiting and IP detection. **Note:** Only enable this if you're actually behind a reverse proxy, as it trusts proxy headers from your reverse proxy.

### Reverse-proxy authentication

The VPN start/stop controls have no built-in authentication. If you expose the UI beyond localhost, place it behind a reverse proxy with HTTP Basic auth.

**Caddy** (`Caddyfile`):
```
your.domain.com {
  basicauth {
    user $2a$14$<bcrypt-hash>
  }
  reverse_proxy localhost:3000
}
```
Generate a hash with: `caddy hash-password`

**Nginx** (`nginx.conf`):
```nginx
location / {
  auth_basic "Restricted";
  auth_basic_user_file /etc/nginx/.htpasswd;
  proxy_pass http://localhost:3000;
}
```
Generate a password file with: `htpasswd -c /etc/nginx/.htpasswd user`

**Traefik** (Docker labels):
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.gluetun-webui.rule=Host(`your.domain.com`)"
  - "traefik.http.routers.gluetun-webui.middlewares=auth"
  - "traefik.http.middlewares.auth.basicauth.users=user:$$apr1$$<hash>"
```
Generate a hash with: `htpasswd -nb user password`

---

## Dashboard Layout & Theme

### Edit mode

Click **Edit** in the header to rearrange the dashboard. In edit mode you can:

- Drag a card onto another card to reorder the grid
- Drag the handle on a card's right edge to change its column span
- Use the panel above the grid to hide or show cards
- Click **Reset** to restore the default layout

Layouts are saved per instance in `localStorage` (`gluetun_layout_{N}`), so each Gluetun instance keeps its own arrangement.

### Theme

The moon/sun button in the header cycles through **dark**, **light**, and **auto**. Auto follows the operating system's colour-scheme preference. The choice is saved in `localStorage` (`gluetun_theme`) and applied by `theme-init.js` before first paint to avoid a flash of the wrong theme.

---

## Speed Test

An optional speed test feature powered by the Ookla Speedtest CLI. Off by default.

### Enabling

Set `SPEEDTEST_ENABLED=true` in your environment:

```yaml
gluetun-webui:
  environment:
    - SPEEDTEST_ENABLED=true
```

A "Speed Test" card appears with a **Run Test** button. Each test takes 15–30 seconds and measures download, upload, ping, and server. Results are charted over time (last 20 tests). Use the dropdown on the card to show the last 5/10/20 tests or all.

### Persistence

Results persist across restarts in `SPEEDTEST_HISTORY_FILE` (default `/data/speedtest-history.json` when `/data` exists). To keep history across container recreation, mount a volume at a path **other than `/app`** (that would shadow the app), e.g.:

```yaml
gluetun-webui:
  environment:
    - SPEEDTEST_HISTORY_FILE=/data/speedtest-history.json
  volumes:
    - speedtest-data:/data

volumes:
  speedtest-data:
```

Named volumes inherit the image's `/data` ownership; if you use a bind mount instead, ensure the host directory is writable by the container's non-root user (uid 100).

### Routing Through VPN

By default, the speed test measures the **webui container's connection**, which is typically the host's direct internet — not the VPN tunnel.

To test your **VPN connection speed**, route the webui's traffic through Gluetun:

```yaml
gluetun-webui:
  network_mode: "service:gluetun"   # shares Gluetun's network namespace
  environment:
    - GLUETUN_CONTROL_URL=http://localhost:8000  # changes from gluetun:8000
    - SPEEDTEST_ENABLED=true
  # Remove 'ports' and 'networks' sections — use Gluetun's ports instead
```

**Breaking config changes** when switching to `network_mode: "service:gluetun"`:
- `GLUETUN_CONTROL_URL` must change to `http://localhost:8000`
- Remove `ports:` from the webui service — expose port 3000 through Gluetun's port mappings instead
- Remove `networks:` from the webui service

Monitoring, VPN controls, and all other features continue to work normally.

---

## IPv6 Setup

The web UI **auto-detects** your public IPv6 address via an external service ([api6.ipify.org](https://api6.ipify.org)) and displays it alongside IPv4 when available. No configuration is needed on the web UI side — if Gluetun has IPv6 connectivity, the UI shows both addresses automatically.

> **Network-path caveat:** the IPv6 is detected from the *web UI container's* egress, not Gluetun's tunnel. For the displayed IPv6 to be your VPN exit address, route the web UI through Gluetun (`network_mode: service:gluetun` on the webui service). Otherwise the UI shows the host's own IPv6 (or none). The result is cached for 5 minutes and never blocks dashboard polling.

**However**, Docker containers don't have IPv6 by default. You must configure your Docker daemon and Gluetun for IPv6 to work. Without this, the UI will only show IPv4.

### Step 1: Enable IPv6 in Docker Daemon

Edit `/etc/docker/daemon.json` on your Linux host:

```json
{
  "ipv6": true,
  "ip6tables": true,
  "fixed-cidr-v6": "fd7d:1234::/80"
}
```

> **Note:** `fixed-cidr-v6` assigns IPv6 addresses to containers on the default bridge network. For custom networks (recommended), you'll configure per-network subnets in Step 2. The `fd7d:1234::/80` prefix is a ULA (Unique Local Address) range — any routable ULA works.

Restart Docker after editing:

```bash
sudo systemctl restart docker
```

### Step 2: Configure Gluetun's Docker Network for IPv6

In your `docker-compose.yml`, add IPv6 to the network and sysctls to Gluetun:

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun:latest
    sysctls:
      net.ipv6.conf.all.disable_ipv6: 0          # Enable IPv6 inside the container
    networks:
      - vpn

  gluetun-webui:
    image: scuzza/gluetun-webui:latest
    # ... rest of config ...
    networks:
      - vpn

networks:
  vpn:
    enable_ipv6: true
    ipam:
      config:
        - subnet: 172.28.0.0/16      # IPv4 subnet (adjust to your setup)
        - subnet: fd00:dead:beef::/48  # IPv6 subnet (ULA range)
```

> **Note:** The `fd00:dead:beef::/48` prefix is arbitrary — any ULA prefix works. The `/48` gives you plenty of room for multiple networks.

### Step 3: Add IPv6 to WireGuard Addresses

This is the critical step. Your VPN provider must assign you an IPv6 address via WireGuard. For AirVPN:

1. Go to [AirVPN WireGuard config generator](https://airvpn.org/wireguard/)
2. Note the `AllowedIPs` line — it contains both IPv4 and IPv6 CIDRs, e.g.:
   ```
   AllowedIPs = 0.0.0.0/0, ::/0
   Address = 10.x.x.x/32,2a0a:xxxx:xxxx::128/128
   ```
3. Set `WIREGUARD_ADDRESSES` in Gluetun with **both** addresses:

```yaml
services:
  gluetun:
    environment:
      - VPN_SERVICE_PROVIDER=airvpn
      - VPN_TYPE=wireguard
      - WIREGUARD_PRIVATE_KEY=yourkey
      - WIREGUARD_ADDRESSES=10.x.x.x/32,2a0a:xxxx:xxxx::128/128
```

> **Critical:** `WIREGUARD_ADDRESSES` must include the IPv6 CIDR from your provider. Without it, Gluetun won't route IPv6 traffic even if Docker is configured for it.

### Step 4: Verify

1. Restart Gluetun: `docker compose up -d gluetun`
2. Check Gluetun has IPv6:
   ```bash
   docker exec gluetun wget -qO- https://api6.ipify.org?format=json
   # Should return: {"ipv6":"2a0a:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx"}
   ```
3. Open the web UI — the AirVPN card should now show both IPs with labels:

```
Public IP
  213.152.187.215  (IPv4)
  2a0a:b640:1:5:bc4e:595b:17f4:659c  (IPv6)
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Only IPv4 shows in UI | Gluetun doesn't have IPv6 — check Steps 1–3 |
| UI shows host IPv6 instead of VPN IPv6 | Web UI isn't routed through Gluetun — add `network_mode: service:gluetun` to the webui service |
| `docker exec gluetun wget` returns "Network unreachable" | Docker daemon IPv6 not enabled or network missing `enable_ipv6: true` |
| Gluetun won't start | Check `WIREGUARD_ADDRESSES` format — must be `ipv4/32,ipv6/128` (comma-separated, no spaces) |
| IPv6 works but UI doesn't show it | Open browser devtools → Network tab → check `/api/1/health` response has `publicIpv6.ok: true` |

Dual-stack is shown automatically when the provider supplies IPv6 through the tunnel — no manual IP configuration is needed.

---

## Acknowledgments
- **[Gluetun](https://github.com/qdm12/gluetun)** — The VPN client container this webui was built for
- **[gluetun-monitor](https://github.com/csmarshall/gluetun-monitor)** — Great monitoring tool to pair with this webui
- **AI-Assisted Development** — This project was built with AI assistance

---

## License

MIT
