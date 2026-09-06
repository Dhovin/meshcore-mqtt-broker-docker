# MeshCore MQTT Broker (Docker Edition)

[![Build and Push Docker Image](https://github.com/Dhovin/meshcore-mqtt-broker-docker/actions/workflows/docker-build.yml/badge.svg)](https://github.com/Dhovin/meshcore-mqtt-broker-docker/actions/workflows/docker-build.yml)

Docker container and `docker-compose` deployment setup for [MeshCore MQTT Broker](https://github.com/michaelhart/meshcore-mqtt-broker) — a WebSocket-based MQTT broker with MeshCore public key authentication and abuse detection.

## Features

- 🐳 **Containerized & Production Ready**: Multi-stage Docker build built on `node:22-alpine` with healthchecks.
- 🚀 **Docker Compose Out-of-the-Box**: Easily spin up the broker with persistent volume storage for SQLite.
- 🔑 **Public Key & JWT Authentication**: Supports MeshCore Ed25519 authentication for publishers and role-based subscribe-only accounts.
- 🛡️ **Abuse Detection & Rate Limiting**: Built-in persistence for tracking abuse metrics.
- 📦 **Automated GHCR Builds**: Multi-architecture container images pushed via GitHub Actions.

---

## Quick Start

You don't need to clone this repository or create a `.env` file. You can run the pre-built multi-arch image (`amd64`/`arm64`) directly using Docker Compose or Docker CLI with all settings configured as container environment variables.

### Option 1: Docker Compose (Recommended)

Create a `docker-compose.yml` file anywhere on your system:

```yaml
services:
  meshcore-broker:
    image: ghcr.io/dhovin/meshcore-mqtt-broker-docker:latest
    container_name: meshcore-mqtt-broker
    restart: unless-stopped
    ports:
      - "8883:8883"
      # - "1883:1883" # Uncomment if standard TCP MQTT is enabled
    environment:
      - MQTT_HOST=0.0.0.0
      - MQTT_WS_PORT=8883
      - AUTH_EXPECTED_AUDIENCE=mqtt.yourdomain.com
      # Subscriber accounts format: username:password:role (1=Admin, 2=Full, 3=Limited)
      - SUBSCRIBER_1=admin:your-admin-password:1
      - SUBSCRIBER_2=viewer:your-viewer-password:2
      # Optional Standard TCP MQTT listener (for Mosquitto bridges)
      # - ENABLE_TCP_MQTT=true
      # - MQTT_TCP_PORT=1883
    volumes:
      - meshcore_data:/data

volumes:
  meshcore_data:
```

Start the container:

```bash
docker compose up -d
docker compose logs -f
```

---

### Option 2: Docker CLI (`docker run`)

```bash
docker run -d \
  --name meshcore-mqtt-broker \
  --restart unless-stopped \
  -p 8883:8883 \
  -e AUTH_EXPECTED_AUDIENCE="mqtt.yourdomain.com" \
  -e SUBSCRIBER_1="admin:your-admin-password:1" \
  -e SUBSCRIBER_2="viewer:your-viewer-password:2" \
  -v meshcore_data:/data \
  ghcr.io/dhovin/meshcore-mqtt-broker-docker:latest
```

---

### Option 3: Building from Source (Local Development)

If you wish to modify the code or build the image locally:

```bash
git clone https://github.com/Dhovin/meshcore-mqtt-broker-docker.git
cd meshcore-mqtt-broker-docker

# Copy and customize environment variables
cp .env.example .env

# Build and run
docker compose up -d --build
```

---

## Automated Upstream Sync & Upgrades

This repository includes automated pipelines to stay updated with upstream [`michaelhart/meshcore-mqtt-broker`](https://github.com/michaelhart/meshcore-mqtt-broker):

1. **Daily Upstream Sync (GitHub Actions)**:
   - A scheduled workflow (`.github/workflows/upstream-sync.yml`) runs daily at 00:00 UTC.
   - It automatically checks the original repository for new commits/releases.
   - If updates exist, it syncs the source code, commits the updates, and triggers the Docker build workflow to publish an updated image to GHCR.

2. **Automatic Container Redeployment**:
   - **Portainer Webhooks**: Set up Portainer Stack Webhooks and add your webhook URL to GitHub Repository Secrets as `PORTAINER_WEBHOOK_URL`. GitHub will automatically trigger Portainer to redeploy whenever a new image is built. (See [Portainer Guide](docs/portainer.md)).
   - **Watchtower**: Enable the optional Watchtower service in `docker-compose.yml` to automatically pull new GHCR builds and restart the broker.
   - **unRAID**: Use unRAID's CA Auto Update Applications plugin or Watchtower. (See [unRAID Guide](docs/unraid.md)).

---

## Volume Persistence

The container stores SQLite abuse detection data at `/data/abuse-detection.db`.
When using `docker-compose.yml`, a named volume `meshcore_data` is mounted to `/data` automatically to preserve state across restarts.

---

## Connecting Clients

Clients connect to the broker via **WebSockets** on port `8883` (or your configured `MQTT_WS_PORT`).

### Publishers
- **Username**: `v1_{UPPERCASE_PUBLIC_KEY}`
- **Password**: JWT authentication token signed with your MeshCore Ed25519 private key.

### Subscribers (Read-Only Accounts)
- **Username**: Configured in `SUBSCRIBER_N`
- **Password**: Configured in `SUBSCRIBER_N`
- **Roles**:
  - `1` (Admin): Full access including `/internal` PII topics and delete rights.
  - `2` (Full Access): Access to public topics with full telemetry data.
  - `3` (Limited): Access to public topics with sensitive fields filtered out.

### Mosquitto Bridge & Standard TCP MQTT Support
To allow an external Mosquitto server to pull topics from this broker natively over standard TCP MQTT (port 1883), enable the optional TCP listener:

Set environment variables in your `.env` or `docker-compose.yml`:
```bash
ENABLE_TCP_MQTT=true
MQTT_TCP_PORT=1883
```

Then configure your external `mosquitto.conf`:
```ini
connection meshcore-pull-bridge
address your-meshcore-broker-host:1883
topic meshcore/# in 0
remote_username viewer
remote_password your-subscriber-password
```


---

## Upstream Acknowledgements

This Docker project is based on [michaelhart/meshcore-mqtt-broker](https://github.com/michaelhart/meshcore-mqtt-broker).

## License

MIT License. See [LICENSE.md](LICENSE.md) for details.
