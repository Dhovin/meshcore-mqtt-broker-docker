import mqtt from 'mqtt';
import { createAuthToken } from '@michaelhart/meshcore-decoder';

function isEnabled(val?: string): boolean {
  if (!val) return false;
  const normalized = val.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

const ENABLE_MESHMAPPER = isEnabled(process.env.ENABLE_MESHMAPPER_RELAY);
const ENABLE_LETSMESH = isEnabled(process.env.ENABLE_LETSMESH_RELAY);

// Local Broker configuration
const LOCAL_HOST = process.env.LOCAL_BROKER_HOST || 'meshcore-broker';
const LOCAL_PORT = process.env.LOCAL_BROKER_PORT || '1883';
const LOCAL_USER = '__internal_relay';
const LOCAL_PASS = 'meshcore-internal-relay-secret-pass-2026';

// Static MeshCore Ed25519 observer keypair used for signing MeshMapper & LetsMesh JWT auth tokens
const RELAY_KEYPAIR = {
  publicKey: process.env.RELAY_PUBLIC_KEY || '4852B69364572B52EFA1B6BB3E6D0ABED4F389A1CBFBB60A9BBA2CCE649CAF0E',
  privateKey: process.env.RELAY_PRIVATE_KEY || '18469d6140447f77de13cd8d761e605431f52269fbff43b0925752ed9e6745435dc6a86d2568af8b70d3365db3f88234760c8ecc645ce469829bc45b65f1d5d5',
};

console.log('====================================================');
console.log('       MeshCore MQTT Relay Service Initializing     ');
console.log('====================================================');
console.log(`[CONFIG] ENABLE_MESHMAPPER_RELAY = ${ENABLE_MESHMAPPER}`);
console.log(`[CONFIG] ENABLE_LETSMESH_RELAY   = ${ENABLE_LETSMESH}`);
console.log(`[CONFIG] Local Broker Target     = mqtt://${LOCAL_HOST}:${LOCAL_PORT}`);
console.log(`[CONFIG] Internal Relay Account  = ${LOCAL_USER}`);
console.log(`[CONFIG] Observer Public Key     = ${RELAY_KEYPAIR.publicKey}`);
console.log('====================================================');

if (!ENABLE_MESHMAPPER && !ENABLE_LETSMESH) {
  console.log('[RELAY STANDBY] Both ENABLE_MESHMAPPER_RELAY and ENABLE_LETSMESH_RELAY are set to false.');
  console.log('[RELAY STANDBY] To enable forwarding, set ENABLE_MESHMAPPER_RELAY=true or ENABLE_LETSMESH_RELAY=true in your .env file.');
  // Periodic status heartbeat so docker compose logs always shows progress
  setInterval(() => {
    console.log('[RELAY STANDBY] Standby heartbeat: ENABLE_MESHMAPPER_RELAY=false, ENABLE_LETSMESH_RELAY=false.');
  }, 30000);
} else {
  startRelay();
}

async function createSignedToken(aud: string): Promise<{ username: string; token: string }> {
  const token = await createAuthToken(
    {
      publicKey: RELAY_KEYPAIR.publicKey,
      aud: aud,
      iat: Math.floor(Date.now() / 1000),
    },
    RELAY_KEYPAIR.privateKey,
    RELAY_KEYPAIR.publicKey
  );
  return {
    username: `v1_${RELAY_KEYPAIR.publicKey.toUpperCase()}`,
    token,
  };
}

async function startRelay() {
  console.log('[RELAY] Starting active packet relay loop...');

  const outboundClients: { name: string; client: mqtt.MqttClient }[] = [];

  const setupOutbound = async (name: string, url: string, aud: string) => {
    try {
      console.log(`[${name}] Generating MeshCore Auth Token for audience '${aud}'...`);
      const auth = await createSignedToken(aud);
      console.log(`[${name}] Connecting to ${url}...`);
      console.log(`[${name}] Authenticating with username: ${auth.username}`);

      const client = mqtt.connect(url, {
        username: auth.username,
        password: auth.token,
        keepalive: 60,
        reconnectPeriod: 10000,
        rejectUnauthorized: false,
      });

      client.on('connect', () => {
        console.log(`[${name}] ✓ SUCCESSFULLY CONNECTED AND AUTHENTICATED WITH ${name}!`);
      });

      client.on('reconnect', () => {
        console.log(`[${name}] 🔄 Reconnecting to ${name}...`);
      });

      client.on('offline', () => {
        console.log(`[${name}] ⚠️ Connection offline: ${name}`);
      });

      client.on('close', () => {
        console.log(`[${name}] Connection closed: ${name}`);
      });

      client.on('error', (err) => {
        console.error(`[${name}] ✗ Connection error: ${err.message}`);
      });

      outboundClients.push({ name, client });
    } catch (err: any) {
      console.error(`[${name}] ✗ Error setting up client:`, err?.message || err);
    }
  };

  if (ENABLE_MESHMAPPER) {
    await setupOutbound('MeshMapper', 'wss://mqtt.meshmapper.net:443', 'mqtt.meshmapper.net');
  }

  if (ENABLE_LETSMESH) {
    await setupOutbound('LetsMesh US', 'wss://mqtt-us-v1.letsmesh.net:443', 'mqtt-us-v1.letsmesh.net');
    await setupOutbound('LetsMesh EU', 'wss://mqtt-eu-v1.letsmesh.net:443', 'mqtt-eu-v1.letsmesh.net');
  }

  // Connect to local broker with detailed lifecycle logging
  console.log(`[LOCAL BROKER] Connecting to local broker at mqtt://${LOCAL_HOST}:${LOCAL_PORT}...`);
  const localClient = mqtt.connect(`mqtt://${LOCAL_HOST}:${LOCAL_PORT}`, {
    username: LOCAL_USER,
    password: LOCAL_PASS,
    keepalive: 60,
    reconnectPeriod: 5000,
  });

  localClient.on('connect', () => {
    console.log(`[LOCAL BROKER] ✓ SUCCESSFULLY CONNECTED TO LOCAL BROKER (${LOCAL_HOST}:${LOCAL_PORT})`);
    console.log('[LOCAL BROKER] Subscribing to topic filter: meshcore/# ...');
    localClient.subscribe('meshcore/#', (err) => {
      if (err) {
        console.error('[LOCAL BROKER] ✗ Subscription failed:', err.message);
      } else {
        console.log('[LOCAL BROKER] ✓ Subscribed to meshcore/# successfully. Waiting for incoming packets...');
      }
    });
  });

  localClient.on('reconnect', () => {
    console.log(`[LOCAL BROKER] 🔄 Reconnecting to local broker (${LOCAL_HOST}:${LOCAL_PORT})...`);
  });

  localClient.on('offline', () => {
    console.log('[LOCAL BROKER] ⚠️ Local broker connection offline');
  });

  localClient.on('error', (err) => {
    console.error(`[LOCAL BROKER] ✗ Connection error: ${err.message}`);
    if (err.message.includes('ECONNREFUSED')) {
      console.error('[LOCAL BROKER] HINT: TCP port 1883 is refused. Make sure ENABLE_TCP_MQTT=true or ENABLE_MESHMAPPER_RELAY=true is set!');
    }
  });

  let packetCounter = 0;
  localClient.on('message', (topic, payload) => {
    packetCounter++;
    console.log(`[PACKET #${packetCounter}] Received from local broker: ${topic} (${payload.length} bytes)`);

    for (const { name, client } of outboundClients) {
      if (client.connected) {
        client.publish(topic, payload, (err) => {
          if (err) {
            console.error(`[RELAY -> ${name}] ✗ Forwarding failed: ${err.message}`);
          } else {
            console.log(`[RELAY -> ${name}] ✓ Forwarded topic: ${topic}`);
          }
        });
      } else {
        console.warn(`[RELAY -> ${name}] ⚠️ Skipped forwarding (client disconnected): ${topic}`);
      }
    }
  });

  // Periodic heartbeat every 60s
  setInterval(() => {
    const localStatus = localClient.connected ? 'CONNECTED' : 'DISCONNECTED';
    const targetsStatus = outboundClients.map(c => `${c.name}: ${c.client.connected ? 'CONNECTED' : 'DISCONNECTED'}`).join(' | ');
    console.log(`[HEARTBEAT] Local: ${localStatus} | Outbound targets: [ ${targetsStatus} ] | Total Packets Relayed: ${packetCounter}`);
  }, 60000);
}
