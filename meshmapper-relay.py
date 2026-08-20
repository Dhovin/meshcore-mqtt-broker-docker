#!/usr/bin/env python3
import os
import sys
import time
import ssl
import logging
import paho.mqtt.client as mqtt

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)

def str_to_bool(val: str) -> bool:
    return str(val).strip().lower() in ('true', '1', 'yes', 'on', 'enabled')

# Simple Enable Flags from Environment (default to false)
ENABLE_MESHMAPPER = str_to_bool(os.environ.get("ENABLE_MESHMAPPER_RELAY", "false"))
ENABLE_LETSMESH = str_to_bool(os.environ.get("ENABLE_LETSMESH_RELAY", "false"))

# Hardcoded Target Endpoints
MESHMAPPER_HOST = "mqtt.meshmapper.net"
MESHMAPPER_PORT = 443

LETSMESH_US_HOST = "mqtt-us-v1.letsmesh.net"
LETSMESH_EU_HOST = "mqtt-eu-v1.letsmesh.net"
LETSMESH_PORT = 443

TOPIC_FILTER = "meshcore/#"

# Static Internal Subscriber Credentials
LOCAL_HOST = os.environ.get("LOCAL_BROKER_HOST", "meshcore-broker").strip()
LOCAL_PORT = int(os.environ.get("LOCAL_BROKER_PORT", "1883"))
LOCAL_USER = "__internal_relay"
LOCAL_PASS = "meshcore-internal-relay-secret-pass-2026"

if not ENABLE_MESHMAPPER and not ENABLE_LETSMESH:
    logging.info("[RELAY] Outbound relays are disabled (ENABLE_MESHMAPPER_RELAY=false, ENABLE_LETSMESH_RELAY=false).")
    logging.info("[RELAY] Set ENABLE_MESHMAPPER_RELAY=true or ENABLE_LETSMESH_RELAY=true to enable forwarding.")
    while True:
        time.sleep(3600)

logging.info("[RELAY] Starting MQTT relay service...")
logging.info(f"[RELAY] Local Broker Source: {LOCAL_HOST}:{LOCAL_PORT} (User: {LOCAL_USER})")

# Clients container
outbound_clients = []

# Initialize MeshMapper client if enabled
if ENABLE_MESHMAPPER:
    logging.info(f"[RELAY] Enabling MeshMapper Relay -> wss://{MESHMAPPER_HOST}:{MESHMAPPER_PORT}")
    mm_client = mqtt.Client(transport="websockets")
    
    def on_mm_connect(client, userdata, flags, rc):
        if rc == 0:
            logging.info(f"[MESHMAPPER] ✓ Connected to {MESHMAPPER_HOST}:{MESHMAPPER_PORT}")
        else:
            logging.error(f"[MESHMAPPER] ✗ Connection failed (rc {rc})")
            
    mm_client.on_connect = on_mm_connect
    try:
        mm_client.tls_set(cert_reqs=ssl.CERT_NONE)
    except Exception as e:
        logging.warning(f"[MESHMAPPER] TLS warning: {e}")
        
    mm_client.connect_async(MESHMAPPER_HOST, MESHMAPPER_PORT, keepalive=60)
    mm_client.loop_start()
    outbound_clients.append(("MeshMapper", mm_client))

# Initialize LetsMesh clients (both US & EU) if ENABLE_LETSMESH is true
if ENABLE_LETSMESH:
    # LetsMesh US
    logging.info(f"[RELAY] Enabling LetsMesh US Relay -> wss://{LETSMESH_US_HOST}:{LETSMESH_PORT}")
    lm_us_client = mqtt.Client(transport="websockets")
    
    def on_lmus_connect(client, userdata, flags, rc):
        if rc == 0:
            logging.info(f"[LETSMESH US] ✓ Connected to {LETSMESH_US_HOST}:{LETSMESH_PORT}")
        else:
            logging.error(f"[LETSMESH US] ✗ Connection failed (rc {rc})")
            
    lm_us_client.on_connect = on_lmus_connect
    try:
        lm_us_client.tls_set(cert_reqs=ssl.CERT_NONE)
    except Exception as e:
        logging.warning(f"[LETSMESH US] TLS warning: {e}")
        
    lm_us_client.connect_async(LETSMESH_US_HOST, LETSMESH_PORT, keepalive=60)
    lm_us_client.loop_start()
    outbound_clients.append(("LetsMesh US", lm_us_client))

    # LetsMesh EU
    logging.info(f"[RELAY] Enabling LetsMesh EU Relay -> wss://{LETSMESH_EU_HOST}:{LETSMESH_PORT}")
    lm_eu_client = mqtt.Client(transport="websockets")
    
    def on_lmeu_connect(client, userdata, flags, rc):
        if rc == 0:
            logging.info(f"[LETSMESH EU] ✓ Connected to {LETSMESH_EU_HOST}:{LETSMESH_PORT}")
        else:
            logging.error(f"[LETSMESH EU] ✗ Connection failed (rc {rc})")
            
    lm_eu_client.on_connect = on_lmeu_connect
    try:
        lm_eu_client.tls_set(cert_reqs=ssl.CERT_NONE)
    except Exception as e:
        logging.warning(f"[LETSMESH EU] TLS warning: {e}")
        
    lm_eu_client.connect_async(LETSMESH_EU_HOST, LETSMESH_PORT, keepalive=60)
    lm_eu_client.loop_start()
    outbound_clients.append(("LetsMesh EU", lm_eu_client))

# Callback for incoming messages from local broker
def on_local_message(client, userdata, msg):
    for name, target_client in outbound_clients:
        try:
            target_client.publish(msg.topic, msg.payload, qos=msg.qos, retain=msg.retain)
            logging.info(f"[RELAY -> {name}] Forwarded {msg.topic} ({len(msg.payload)} bytes)")
        except Exception as e:
            logging.error(f"[RELAY -> {name}] Error forwarding topic {msg.topic}: {e}")

def on_local_connect(client, userdata, flags, rc):
    if rc == 0:
        logging.info(f"[RELAY] ✓ Connected to local broker. Subscribing to '{TOPIC_FILTER}'...")
        client.subscribe(TOPIC_FILTER)
    else:
        logging.error(f"[RELAY] ✗ Failed to connect to local broker (rc {rc})")

# Set up local subscriber client
local_client = mqtt.Client()
if LOCAL_USER and LOCAL_PASS:
    local_client.username_pw_set(LOCAL_USER, LOCAL_PASS)

local_client.on_connect = on_local_connect
local_client.on_message = on_local_message

while True:
    try:
        logging.info(f"[RELAY] Connecting to local broker {LOCAL_HOST}:{LOCAL_PORT}...")
        local_client.connect(LOCAL_HOST, LOCAL_PORT, keepalive=60)
        local_client.loop_forever()
    except Exception as e:
        logging.error(f"[RELAY] Local connection error: {e}. Retrying in 10 seconds...")
        time.sleep(10)
