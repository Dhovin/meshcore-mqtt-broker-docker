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

if (!ENABLE_MESHMAPPER && !ENABLE_LETSMESH) {
  console.log('[RELAY] Outbound relays are disabled (ENABLE_MESHMAPPER_RELAY=false, ENABLE_LETSMESH_RELAY=false).');
  console.log('[RELAY] Set ENABLE_MESHMAPPER_RELAY=true or ENABLE_LETSMESH_RELAY=true to enable forwarding.');
  setInterval(() => {}, 3600000);
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
  console.log('[RELAY] Starting MeshCore MQTT Relay service...');
  console.log(`[RELAY] Local broker source: mqtt://${LOCAL_HOST}:${LOCAL_PORT}`);

  const outboundClients: { name: string; client: mqtt.MqttClient }[] = [];

  // Initialize MeshMapper target
  if (ENABLE_MESHMAPPER) {
    try {
      const aud = 'mqtt.meshmapper.net';
      const auth = await createSignedToken(aud);
      console.log(`[MESHMAPPER] Connecting to wss://mqtt.meshmapper.net:443 (Username: ${auth.username.substring(0, 12)}...)`);
      const client = mqtt.connect('wss://mqtt.meshmapper.net:443', {
        username: auth.username,
        password: auth.token,
        keepalive: 60,
        reconnectPeriod: 10000,
        rejectUnauthorized: false,
      });
      client.on('connect', () => console.log('[MESHMAPPER] ✓ Connected and authenticated with MeshMapper'));
      client.on('error', (err) => console.error('[MESHMAPPER] ✗ Connection error:', err.message));
      outboundClients.push({ name: 'MeshMapper', client });
    } catch (err: any) {
      console.error('[MESHMAPPER] ✗ Failed to initialize auth token:', err?.message || err);
    }
  }

  // Initialize LetsMesh targets (US & EU)
  if (ENABLE_LETSMESH) {
    // LetsMesh US
    try {
      const audUS = 'mqtt-us-v1.letsmesh.net';
      const authUS = await createSignedToken(audUS);
      console.log(`[LETSMESH US] Connecting to wss://mqtt-us-v1.letsmesh.net:443 (Username: ${authUS.username.substring(0, 12)}...)`);
      const clientUS = mqtt.connect('wss://mqtt-us-v1.letsmesh.net:443', {
        username: authUS.username,
        password: authUS.token,
        keepalive: 60,
        reconnectPeriod: 10000,
        rejectUnauthorized: false,
      });
      clientUS.on('connect', () => console.log('[LETSMESH US] ✓ Connected and authenticated with LetsMesh US'));
      clientUS.on('error', (err) => console.error('[LETSMESH US] ✗ Connection error:', err.message));
      outboundClients.push({ name: 'LetsMesh US', client: clientUS });
    } catch (err: any) {
      console.error('[LETSMESH US] ✗ Failed to initialize auth token:', err?.message || err);
    }

    // LetsMesh EU
    try {
      const audEU = 'mqtt-eu-v1.letsmesh.net';
      const authEU = await createSignedToken(audEU);
      console.log(`[LETSMESH EU] Connecting to wss://mqtt-eu-v1.letsmesh.net:443 (Username: ${authEU.username.substring(0, 12)}...)`);
      const clientEU = mqtt.connect('wss://mqtt-eu-v1.letsmesh.net:443', {
        username: authEU.username,
        password: authEU.token,
        keepalive: 60,
        reconnectPeriod: 10000,
        rejectUnauthorized: false,
      });
      clientEU.on('connect', () => console.log('[LETSMESH EU] ✓ Connected and authenticated with LetsMesh EU'));
      clientEU.on('error', (err) => console.error('[LETSMESH EU] ✗ Connection error:', err.message));
      outboundClients.push({ name: 'LetsMesh EU', client: clientEU });
    } catch (err: any) {
      console.error('[LETSMESH EU] ✗ Failed to initialize auth token:', err?.message || err);
    }
  }

  // Connect to local broker
  const localClient = mqtt.connect(`mqtt://${LOCAL_HOST}:${LOCAL_PORT}`, {
    username: LOCAL_USER,
    password: LOCAL_PASS,
    keepalive: 60,
    reconnectPeriod: 10000,
  });

  localClient.on('connect', () => {
    console.log('[RELAY] ✓ Connected to local broker. Subscribing to meshcore/#...');
    localClient.subscribe('meshcore/#', (err) => {
      if (err) console.error('[RELAY] ✗ Subscription error:', err.message);
    });
  });

  localClient.on('message', (topic, payload) => {
    for (const { name, client } of outboundClients) {
      if (client.connected) {
        client.publish(topic, payload);
        console.log(`[RELAY -> ${name}] Forwarded -> ${topic} (${payload.length} bytes)`);
      }
    }
  });

  localClient.on('error', (err) => {
    console.error('[RELAY] Local broker connection error:', err.message);
  });
}
