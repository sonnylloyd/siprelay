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

## Quick start (Docker Compose)
The relay must see Docker events, so mount the Docker socket. Set `PROXY_IP` to the address clients use to reach the proxy (e.g., the servers IP address).

```yaml
version: '3.9'

services:
  siprelay:
    build: .
    container_name: siprelay
    environment:
      PROXY_IP: 172.20.0.2
      MEDIA_MODE: passthrough   # current supported mode (RTP passthrough)
    ports:
      - "5060:5060/udp"
      - "5061:5061/tcp"
      - "8080:8080/tcp"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # TLS is optional — mount your key/cert to enable it
      # - ./certs/server.key:/ssl/server.key:ro
      # - ./certs/server.crt:/ssl/server.crt:ro
    networks:
      sipnet:
        ipv4_address: 172.20.0.2

  sip-debug-a:
    image: echrom/sip-debug-server
    labels:
      sip-proxy-host: pbx-a.example.com
      sip-proxy-port-udp: 5070
    networks:
      sipnet:
        ipv4_address: 172.20.0.10

  sip-debug-b:
    image: echrom/sip-debug-server
    labels:
      sip-proxy-host: pbx-b.example.com
      sip-proxy-port-udp: 5071
      sip-proxy-port-tls: 5061    # advertise a TLS listener if present
    networks:
      sipnet:
        ipv4_address: 172.20.0.11

networks:
  sipnet:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/24
```

Start everything:
```bash
docker compose up -d --build
```

Browse the dashboard at `http://localhost:8080/` or view JSON routes at `http://localhost:8080/api/routes`.

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
