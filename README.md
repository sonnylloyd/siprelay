![Logo](images/sip-relay.svg)

> ⚠️ **Project Status: In Development**
>
> This project is a work in progress and is not yet fully functional. Expect breaking changes and incomplete features. Contributions and testing feedback are welcome!

# SIP Relay

**SIP Relay** is a lightweight reverse SIP proxy built for Docker environments. It allows you to route SIP traffic dynamically between containers based on domain names, without requiring multiple IP addresses or complex NAT setups.

It monitors Docker events in real time, discovers labeled containers, and maps SIP domain routes to container endpoints using Docker DNS or optionally specified IPs.

---

## 🔧 Features

- ✅ **Dynamic SIP routing** based on container labels (`sip-proxy-host`, `sip-proxy-port`)
- 🔁 **Live container discovery** via Docker event stream (`start`, `stop`)
- 🧠 **Smart DNS-based routing** using Docker internal DNS (fallback to IP if needed)
- 🗂 **Support for multiple PBX containers** on a single IP with different port mappings
- 📜 Written in **Node.js + TypeScript** for extensibility and clear logic
- 📦 Designed for **testing**, **dev environments**, and **multi-tenant PBX simulation**

---

## 🚀 How It Works

1. **SIP Relay container starts** and begins listening for UDP SIP traffic on port `5060` (or custom).
2. It also **subscribes to Docker events** and builds a routing map:
   - If a container is started with label `sip-proxy-host: pbx-a.example.com`
   - And label `sip-proxy-port: 5070`
   - It will create a route for `pbx-a.example.com` → `sip-debug-a:5070`
3. When a SIP request arrives for `sip:bob@pbx-a.example.com`, the proxy:
   - Parses the request
   - Looks up the target container
   - Rewrites headers (e.g., Via, Contact, SDP if needed)
   - Forwards to the matched container

---

## 🏷 Label Reference

| Label                    | Required | Description                                                                 |
|-------------------------|----------|-----------------------------------------------------------------------------|
| `sip-proxy-host`        | ✅       | The SIP domain this container should handle (e.g. `pbx-a.example.com`)     |
| `sip-proxy-port-udp`    | ❌       | SIP UDP port inside the container (e.g. `5070`)                             |
| `sip-proxy-port-tls`    | ❌       | SIP TLS port inside the container (e.g. `5061`)                             |
| `sip-proxy-ip`          | ❌       | Optional. Override Docker DNS with a static IP (e.g. for MACVLAN networks)  |

----------------------|----------|-----------------------------------------------------------------------------|
| `sip-proxy-host`     | ✅       | The SIP domain this container should handle (e.g. `pbx-a.example.com`)     |
| `sip-proxy-port`     | ✅       | SIP UDP port inside the container (e.g. `5070`)                             |
| `sip-proxy-ip`       | ❌       | Optional. Override Docker DNS with a static IP (e.g. for MACVLAN networks)  |

---

## 📦 Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/) (optional but recommended)

---

## 🛠 Usage

### 1. Clone the repository

```bash
git clone https://github.com/sonnylloyd/sip-relay.git
cd sip-relay
```

### 2. Start SIP Relay with Docker Compose

Create a `docker-compose.yml` with SIP Relay and one or more SIP debug servers:

```yaml
version: '3.8'

services:
  siprelay:
    image: echrom/siprelay
    container_name: siprelay
    ports:
      - "5060:5060/udp"
    networks:
      sipnet:
        ipv4_address: 172.20.0.2

  sip-debug-a:
    image: echrom/sip-debug-server
    container_name: sip-debug-a
    environment:
      SIP_PORT: 5070
    labels:
      sip-proxy-host: pbx-a.example.com
      sip-proxy-port-udp: 5070
    networks:
      sipnet:
        ipv4_address: 172.20.0.10

  sip-debug-b:
    image: echrom/sip-debug-server
    container_name: sip-debug-b
    environment:
      SIP_PORT: 5071
    labels:
      sip-proxy-host: pbx-b.example.com
      sip-proxy-port-udp: 5071
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

Then run:

```bash
docker-compose up -d
```

---

## 🧪 Testing with a Debug SIP Client

Use the included test script or create your own to simulate SIP requests:

```bash
SIP_PROXY=127.0.0.1 SIP_PROXY_PORT=5060 node debug-sip-client.js
```

Make sure the SIP URI matches the domain registered in Docker:

```
To: <sip:bob@pbx-a.example.com>
```

You can also observe debug logs from `sip-debug-server` containers to verify routing.

## ⚙️ Environment Variables

| Variable     | Default      | Description                                                                 |
|--------------|--------------|-----------------------------------------------------------------------------|
| `PROXY_IP`   | `127.0.0.1`  | IP/host the relay uses in Via/Contact headers. Set to the container IP exposed to clients. |
| `MEDIA_MODE` | `passthrough` | `passthrough` leaves SDP untouched so RTP flows directly between endpoints. Set to `proxy` once the relay is configured to relay RTP. |

---

## 🔍 How Routing Works

The proxy builds a routing map from Docker labels like this:

```json
{
  "pbx-a.example.com": { "ip": "172.20.0.10", "udpPort": 5070 },
  "pbx-b.example.com": { "ip": "172.20.0.11", "udpPort": 5071 }
}
```

When a SIP request is received, it:

1. Extracts the domain from the `Request-URI` or `To:` header
2. Finds a matching entry
3. Rewrites SIP headers (Via, Contact, SDP)
4. Sends the message to the correct container

---

## 🛡 Security Notes

- **Authentication** is handled by your PBX (e.g., Asterisk), not the SIP relay
- SIP Relay does **not** rate-limit or block based on IP
- Best practice: run `siprelay` in a **private Docker network** and restrict external access

---

## 📁 Project Structure

```
├── src/
│   ├── proxy/          # SIP proxy logic (UDP, TLS, base)
│   ├── watcher/        # Docker event monitoring
│   ├── store/          # Domain-to-IP/port mapping
│   ├── logging/        # Logger implementation
│   └── index.ts        # Main entry point
├── test/               # Debug SIP client/server
├── Dockerfile
├── docker-compose.yml
└── README.md
```
