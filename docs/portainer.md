# Deploying MeshCore MQTT Broker with Portainer

This guide details how to deploy and manage the **MeshCore MQTT Broker** using [Portainer](https://www.portainer.io/), an intuitive Web UI for Docker container management.

---

## Prerequisites

- An active Portainer instance (Portainer CE or BE).
- Access to Portainer's Web UI with rights to create containers or stacks.
- Network access to port `8883` (or your chosen WebSocket port).

---

## Method 1: Deploying via Portainer Stacks (Recommended)

Portainer Stacks allows you to deploy applications using Docker Compose definitions directly from the Portainer interface or directly from a Git repository.

### Step 1: Navigate to Stacks

1. Log in to your Portainer dashboard.
2. Select your Environment (e.g., **local** or **primary**).
3. Click on **Stacks** in the left navigation sidebar.
4. Click **+ Add stack**.

### Step 2: Configure the Stack

1. **Name**: Enter `meshcore-mqtt-broker`.
2. **Build method**: Choose **Web editor** (or **Repository** if linking directly to your fork/repository).
3. **Web editor**: Paste the following Docker Compose configuration:

```yaml
version: '3.8'

services:
  meshcore-broker:
    image: ghcr.io/dhovin/meshcore-mqtt-broker-docker:latest
    container_name: meshcore-mqtt-broker
    restart: unless-stopped
    ports:
      - "${MQTT_WS_PORT:-8883}:8883"
    environment:
      - MQTT_WS_PORT=${MQTT_WS_PORT:-8883}
      - MQTT_HOST=0.0.0.0
      - AUTH_EXPECTED_AUDIENCE=${AUTH_EXPECTED_AUDIENCE:-mqtt.yourdomain.com}
      - SUBSCRIBER_MAX_CONNECTIONS_DEFAULT=${SUBSCRIBER_MAX_CONNECTIONS_DEFAULT:-2}
      - SUBSCRIBER_1=${SUBSCRIBER_1:-viewer1:your-secure-password-here:2}
      - SUBSCRIBER_2=${SUBSCRIBER_2:-admin:admin-password-here:1:10}
      - ABUSE_ENFORCEMENT_ENABLED=${ABUSE_ENFORCEMENT_ENABLED:-false}
      - ABUSE_PERSISTENCE_PATH=/data/abuse-detection.db
    volumes:
      - meshcore_data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://127.0.0.1:8883/ || exit 0"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  meshcore_data:
    driver: local
```

### Step 3: Environment Variables

Scroll down to the **Environment variables** section in Portainer and click **+ Add environment variable** for each parameter you want to customize:

| Name | Example Value | Description |
| :--- | :--- | :--- |
| `MQTT_WS_PORT` | `8883` | Host port for WebSockets |
| `AUTH_EXPECTED_AUDIENCE` | `mqtt.yourdomain.com` | Expected JWT audience claim |
| `SUBSCRIBER_1` | `viewer1:yourpassword:2` | Subscriber user (`user:pass:role`) |
| `SUBSCRIBER_2` | `admin:adminpassword:1:10` | Subscriber user (`user:pass:role:maxConns`) |
| `ABUSE_ENFORCEMENT_ENABLED` | `false` | Enable/disable abuse rate enforcement |

### Step 4: Deploy the Stack

1. Scroll to the bottom and click **Deploy the stack**.
2. Portainer will pull `ghcr.io/dhovin/meshcore-mqtt-broker-docker:latest`, create the volume `meshcore_data`, and start the container.

---

## Method 2: Deploying as a Standalone Container

If you prefer not to use Stacks, you can create the container directly in Portainer's Container menu.

### Step 1: Navigate to Containers

1. Go to **Containers** in the left navigation menu.
2. Click **+ Add container**.

### Step 2: Basic Configuration

- **Name**: `meshcore-mqtt-broker`
- **Image**: `ghcr.io/dhovin/meshcore-mqtt-broker-docker:latest`
- **Network ports configuration**:
  - Click **+ publish a new network port**
  - **host**: `8883` | **container**: `8883` (TCP)

### Step 3: Volumes

1. Under **Advanced container settings**, click the **Volumes** tab.
2. Click **+ map additional volume**.
3. **container**: `/data`
4. Choose **Volume** and select/create `meshcore_data` (or choose **Bind** and specify a host path like `/var/lib/meshcore/data`).

### Step 4: Environment Variables

1. Click the **Env** tab under Advanced container settings.
2. Click **+ Add environment variable** for required settings:
   - `AUTH_EXPECTED_AUDIENCE` = `mqtt.yourdomain.com`
   - `SUBSCRIBER_1` = `viewer:password123:2`
   - `MQTT_WS_PORT` = `8883`

### Step 5: Restart Policy & Healthcheck

1. Click the **Restart policy** tab and choose **Unless stopped**.
2. Click **Deploy the container**.

---

## Verification & Logs

1. Go to **Containers** in Portainer.
2. Click the `meshcore-mqtt-broker` container name.
3. Click the **Logs** icon (page icon) to inspect runtime logs. You should see output indicating the broker has started listening on port 8883.
4. Check the status indicator: it should turn **healthy** after ~10-15 seconds.

---

## Updating the Container in Portainer

When a new image is published to `ghcr.io/dhovin/meshcore-mqtt-broker-docker`:

1. **For Stacks**:
   - Go to **Stacks** > `meshcore-mqtt-broker` > **Editor**.
   - Enable **Re-pull image and redeploy**.
   - Click **Update the stack**.

2. **For Standalone Containers**:
   - Go to **Containers** > `meshcore-mqtt-broker`.
   - Click **Recreate**.
   - Enable **Re-pull image**.
   - Click **Recreate**.
