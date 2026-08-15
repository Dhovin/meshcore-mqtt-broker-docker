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

### 1. Clone the repository

```bash
git clone https://github.com/Dhovin/meshcore-mqtt-broker-docker.git
cd meshcore-mqtt-broker-docker
```

### 2. Configure Environment

Copy `.env.example` to `.env` and adjust your environment variables:

```bash
cp .env.example .env
```

Edit `.env` to configure your WebSocket port, subscriber accounts, and expected audience:

```bash
MQTT_WS_PORT=8883
AUTH_EXPECTED_AUDIENCE=mqtt.yourdomain.com

SUBSCRIBER_1=admin:your-admin-password:1
SUBSCRIBER_2=viewer:your-viewer-password:2
```

### 3. Start with Docker Compose

```bash
docker compose up -d
```

Check logs and container status:

```bash
docker compose logs -f
docker compose ps
```

---

## Deployment Guides

Detailed guides for various platforms and deployment methods:

- 🚢 **[Portainer Guide](docs/portainer.md)**: Deploy via Portainer Stacks (Compose Web Editor) or standalone container.
- 🦔 **[unRAID Guide](docs/unraid.md)**: Deploy via unRAID Docker Web GUI (Manual Add Container) or Docker Compose Plugin.
- 🔒 **[Cloudflare Tunnels Guide](docs/cloudflare-tunnels.md)**: Expose the broker securely with automatic SSL/TLS termination without opening firewall ports.

---

## Docker Image Options

### Running Pre-built Image from GHCR

You can run the latest published image directly without building:

```bash
docker run -d \
  --name meshcore-mqtt-broker \
  -p 8883:8883 \
  -v meshcore_data:/data \
  --env-file .env \
  ghcr.io/dhovin/meshcore-mqtt-broker-docker:latest
```

### Building the Image Locally

```bash
docker build -t meshcore-mqtt-broker .
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

---

## Upstream Acknowledgements

This Docker project is based on [michaelhart/meshcore-mqtt-broker](https://github.com/michaelhart/meshcore-mqtt-broker).

## License

MIT License. See [LICENSE.md](LICENSE.md) for details.
