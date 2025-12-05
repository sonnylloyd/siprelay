![Logo](images/sip-relay.svg)

> ⚠️ **Project Status: In Development**
>
> Expect breaking changes and incomplete features. Feedback and contributions are welcome!

# SIP Relay

**SIP Relay** is a lightweight reverse SIP proxy for Docker environments. It watches container events, builds a routing table from labels, and forwards SIP over UDP and TLS without needing extra IPs or hand-written NAT rules. Media is currently pass-through only.

## Features
- Discovers PBX targets automatically from Docker labels
- Supports UDP and TLS forwarding with Via/Contact rewriting
- Designed for eventual RTP anchoring; today only SDP passthrough is supported
- Live dashboard and JSON API that expose the current routing table
- Minimal TypeScript codebase intended for testing and multi-tenant PBX simulations

## How it works
1. Subscribes to Docker events and records any container with the `sip-proxy-host` label (plus UDP/TLS ports).
2. Listens on `SIP_UDP_PORT` (default `5060`) and `SIP_TLS_PORT` (default `5061`).
3. Extracts the target domain from the SIP message, looks it up in the routing table, and rewrites Via/Contact headers to use `PROXY_IP`.
4. Forwards the message to the matching container IP/port. Responses are mapped back to the original client by Call-ID.

## Quick start (Docker Compose with Traefik + basic auth)
Create a `.env` from the sample in `examples/` and update the credentials and IPs for your lab:

```bash
cp examples/.env.example examples/.env
# then edit SIPRELAY_DASHBOARD_AUTH with your own htpasswd hash
```

Example `.env` values for the compose below:
```env
SIPRELAY_IP=172.30.0.2
SIPCORE_SUBNET=172.30.0.0/24
PBX1_IP=172.30.0.4
PBX2_IP=172.30.0.5
PBX1_ADMIN_PASSWORD=changeme-alpha
PBX2_ADMIN_PASSWORD=changeme-bravo
# Generate with: htpasswd -nb admin 'yourpass'
SIPRELAY_DASHBOARD_AUTH=admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/
```

The relay must see Docker events, so mount the Docker socket. Set `PROXY_IP` to the address clients use to reach the proxy. Below is a shortened version of `examples/traefik-mikopbx-siprelay-compose.yml` (Jaeger removed) with Traefik fronting the SIP Relay dashboard via basic auth.

```yaml
version: '3.9'

services:
  traefik:
    image: traefik:v2.11
    env_file:
      - .env
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=traefik"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      - "--api.dashboard=true"
      - "--providers.file.filename=/etc/traefik/traefik-tls.yml"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-certs:/certs:ro      # contains acme.json
      - ./traefik-tls.yml:/etc/traefik/traefik-tls.yml:ro
    networks: [traefik]

  siprelay:
    image: echrom/siprelay:latest
    env_file:
      - .env
    environment:
      PROXY_IP: ${SIPRELAY_IP:-172.30.0.2}
      MEDIA_MODE: passthrough
      SIP_TLS_KEY_PATH: /ssl/server.key
      SIP_TLS_CERT_PATH: /ssl/server.crt
    ports:
      - "5060:5060/udp"
    expose:
      - "8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - siprelay-certs:/ssl:ro       # populated by certs-dumper
    networks:
      sipcore:
        ipv4_address: ${SIPRELAY_IP:-172.30.0.2}
      traefik:
        aliases: [siprelay.test.local]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.siprelay-dashboard.rule=Host(`siprelay.test.local`)"
      - "traefik.http.routers.siprelay-dashboard.entrypoints=websecure"
      - "traefik.http.routers.siprelay-dashboard.tls=true"
      - "traefik.http.routers.siprelay-dashboard.middlewares=siprelay-basic-auth"
      - "traefik.http.middlewares.siprelay-basic-auth.basicauth.users=${SIPRELAY_DASHBOARD_AUTH}"
      - "traefik.http.services.siprelay-dashboard.loadbalancer.server.port=8080"

  mikopbx-alpha:
    image: ghcr.io/mikopbx/mikopbx-x86-64:latest
    env_file:
      - .env
    hostname: "pbx1.test.local"
    networks:
      sipcore:
        ipv4_address: ${PBX1_IP:-172.30.0.4}
      traefik:
        aliases: [pbx1.test.local]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.pbx1.rule=Host(`pbx1.test.local`)"
      - "traefik.http.routers.pbx1.entrypoints=websecure"
      - "traefik.http.routers.pbx1.tls=true"
      - "traefik.http.services.pbx1.loadbalancer.server.port=80"
      - "sip-proxy-host=pbx1.test.local"
      - "sip-proxy-port-udp=5060"
      - "sip-proxy-port-tls=5061"

  certs-dumper:
    image: ghcr.io/kereis/traefik-certs-dumper:latest
    command:
      - --restart-containers=siprelay
    environment:
      - ACME_FILE_PATH=/certs/acme.json
      - DOMAIN=siprelay.test.local
      - PRIVATE_KEY_FILE_NAME=server
      - PRIVATE_KEY_FILE_EXT=.key
      - CERTIFICATE_FILE_NAME=server
      - CERTIFICATE_FILE_EXT=.crt
      - COMBINED_PEM=ca.crt
    volumes:
      - traefik-certs:/certs:ro      # same volume Traefik writes acme.json into
      - siprelay-certs:/output:rw    # where TLS cert/key are dumped
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [traefik]
    restart: unless-stopped

networks:
  traefik:
    driver: bridge
  sipcore:
    driver: bridge
    ipam:
      config:
        - subnet: ${SIPCORE_SUBNET:-172.30.0.0/24}

volumes:
  traefik-certs:
  siprelay-certs:
```

Start everything:
```bash
docker compose --env-file examples/.env -f examples/traefik-mikopbx-siprelay-compose.yml up -d
```

Browse the SIP Relay dashboard at `https://siprelay.test.local` using the credentials from `.env`. The full two-PBX example lives at `examples/traefik-mikopbx-siprelay-compose.yml`.

To change the dashboard credentials, generate a new hash (e.g. `htpasswd -nb admin 'yourpass'`) and update `SIPRELAY_DASHBOARD_AUTH` in `.env`.

## Container labels

| Label                 | Required | Description                                                                 |
|-----------------------|----------|-----------------------------------------------------------------------------|
| `sip-proxy-host`      | ✅       | SIP domain handled by the container (e.g. `pbx-a.example.com`)              |
| `sip-proxy-port-udp`  | ❌       | UDP port inside the container for SIP signaling                              |
| `sip-proxy-port-tls`  | ❌       | TLS port inside the container for SIP signaling                              |
| `sip-proxy-ip`        | ❌       | Override Docker DNS with a static IP (useful for macvlan/host-networked PBX) |

## Configuration

| Variable            | Default          | Description                                                                 |
|---------------------|------------------|-----------------------------------------------------------------------------|
| `PROXY_IP`          | `127.0.0.1`      | IP/host inserted into Via/Contact (set to the proxy’s reachable address).   |
| `SIP_UDP_PORT`      | `5060`           | UDP listen port.                                                            |
| `SIP_TLS_PORT`      | `5061`           | TLS listen port (requires mounted `SIP_TLS_KEY_PATH` and `SIP_TLS_CERT_PATH`). |
| `HTTP_PORT`         | `8080`           | HTTP dashboard and API port.                                                |
| `SIP_TLS_KEY_PATH`  | `/ssl/server.key`| TLS private key path inside the container.                                  |
| `SIP_TLS_CERT_PATH` | `/ssl/server.crt`| TLS certificate path inside the container.                                  |
| `SIP_TLS_REJECT_UNAUTHORIZED` | `1`  | Set to `0` to skip upstream TLS cert verification (not recommended outside labs). |
| `HTTP_CORS_ORIGINS` | _empty_          | Comma-separated origins to allow via CORS. Leave empty to disable CORS.     |
| `MEDIA_MODE`        | `passthrough`    | Current supported mode; keeps SDP as-is so RTP flows end-to-end.            |

## HTTP Endpoints
- Dashboard: `GET /` — shows discovered routes.
- Health: `GET /api/health` — returns `{ status: "ok" }`.
- Routes: `GET /api/routes` — JSON list of all host → IP/port mappings.

Example:
```bash
curl -s http://localhost:8080/api/routes | jq
```

## Local development
```bash
npm install
npm run build
npm test
```

- The build copies static assets into `dist/`.
- Running the proxy locally (`node dist/server.js`) still requires access to the Docker socket if you want live discovery.
- Media proxying is not yet implemented; use `MEDIA_MODE=passthrough`.

## Notes and tips
- Mount `/var/run/docker.sock` read-only if your environment allows; the watcher only needs event access.
- Set `PROXY_IP` to a stable address (container IP, host IP, or load balancer IP) so Via/Contact rewriting is correct.
- Provide valid TLS key/cert files to enable the TLS listener; otherwise the TLS proxy is skipped.
