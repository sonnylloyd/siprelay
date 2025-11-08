# Traefik + SIP Relay + Dual MikoPBX Demo

This compose file (`examples/traefik-mikopbx-siprelay-compose.yml`) spins up a
local lab with:

- **Traefik v2.11** terminating HTTPS and routing the PBX web UIs by hostname
  (that version still exposes the native Jaeger tracing flags used below). The
  compose file pins its Docker network names (`traefik`, `sipcore`) so Traefik
  can always reach the PBX containers while proxying them over HTTP on port 80.
- **SIP Relay** (`echrom/siprelay:latest`) listening on UDP port `5060` and
  forwarding SIP traffic to containers based on the `sip-proxy-…` labels.
- **Two MikoPBX instances** (Alpha and Bravo) configured following the [official
  Docker guide](https://docs.mikopbx.com/mikopbx/english/setup/docker/running-mikopbx-using-docker-compose).

Use it to validate that SIP Relay sends `pbx1.test.local` traffic to the first
PBX and `pbx2.test.local` traffic to the second one while Traefik exposes both
admin front‑ends on your workstation.

## 1. Prepare the host

1. Create (once) the non-root user expected by MikoPBX or reuse an existing
   unprivileged account:

   ```bash
   sudo adduser --system --group --home /var/lib/mikopbx www-user
   export ID_WWW_USER=$(id -u www-user)
   export ID_WWW_GROUP=$(id -g www-user)
   ```

2. Pick strong admin passwords for each PBX instance and export them before
   running Compose:

   ```bash
   export PBX1_ADMIN_PASSWORD='change-me-alpha'
   export PBX2_ADMIN_PASSWORD='change-me-bravo'
   ```

3. Add fake domains that both Traefik (HTTPS) and SIP Relay will see. Replace
   `127.0.0.1` with the IP of the Docker host if you are testing from another
   machine:

   ```
   sudo tee -a /etc/hosts >/dev/null <<'EOF'
   127.0.0.1 pbx1.test.local
   127.0.0.1 pbx2.test.local
   127.0.0.1 traefik.test.local
   EOF
   ```

   ✅ Browsers and SIP tools can now resolve the same hostnames SIP Relay uses.

## 2. Start the stack

```bash
docker compose -f examples/traefik-mikopbx-siprelay-compose.yml up -d
```

What happens:

- Traefik exposes `https://pbx1.test.local` and `https://pbx2.test.local`
  using its default self-signed certificate (expect a warning the first time)
  plus `https://traefik.test.local` for the dashboard so you can inspect routes
  and a Jaeger all-in-one container at `http://localhost:16686` collects
  request traces from Traefik.
- SIP Relay binds `udp/5060` on the host and watches Docker labels to keep its
  routing map in sync.
- Both PBX containers listen on `5060/udp` internally; only SIP Relay can reach
  them, so there are no conflicting host ports.

## 3. Test routing

1. Open each PBX UI through Traefik to finish any first-boot wizard. Credentials
   match the passwords you exported above (login `admin` by default).
2. Register two softphones (or use `sipsak`, `baresip`, etc.) against the SIP
   Relay listener:

   ```bash
   # Example OPTIONS ping to PBX Alpha through the relay
   sipsak -s sip:101@pbx1.test.local -sudp 127.0.0.1:5060
   sipsak -s sip:202@pbx2.test.local -sudp 127.0.0.1:5060
   ```

   Watch `docker logs siprelay` to confirm that each domain is forwarded to the
   matching PBX.

## 4. Cleanup

```bash
docker compose -f examples/traefik-mikopbx-siprelay-compose.yml down
```

Volumes (`pbx*_cf`, `pbx*_storage`) are preserved so you can bring the lab back
up without re-running the PBX setup steps.
