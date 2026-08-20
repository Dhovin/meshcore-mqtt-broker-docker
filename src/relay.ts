import mqtt from 'mqtt';
import { createAuthToken } from '@michaelhart/meshcore-decoder';

function isEnabled(val?: string): boolean {
  if (!val) return false;
  const normalized = val.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

const ENABLE_RELAY = isEnabled(process.env.ENABLE_OUTBOUND_RELAY) ||
                     isEnabled(process.env.ENABLE_RELAY) ||
                     isEnabled(process.env.ENABLE_MESHMAPPER_RELAY) ||
                     isEnabled(process.env.ENABLE_LETSMESH_RELAY);

// Fallback observer keypair if node raw token is unavailable
const FALLBACK_KEYPAIR = {
  publicKey: process.env.RELAY_PUBLIC_KEY || '4852B69364572B52EFA1B6BB3E6D0ABED4F389A1CBFBB60A9BBA2CCE649CAF0E',
  privateKey: process.env.RELAY_PRIVATE_KEY || '18469d6140447f77de13cd8d761e605431f52269fbff43b0925752ed9e6745435dc6a86d2568af8b70d3365db3f88234760c8ecc645ce469829bc45b65f1d5d5',
};

interface TargetConfig {
  name: string;
  url: string;
  aud: string;
}

const TARGETS: TargetConfig[] = [
  { name: 'MeshMapper', url: 'wss://mqtt.meshmapper.net:443', aud: 'mqtt.meshmapper.net' },
  { name: 'LetsMesh US', url: 'wss://mqtt-us-v1.letsmesh.net:443', aud: 'mqtt-us-v1.letsmesh.net' },
  { name: 'LetsMesh EU', url: 'wss://mqtt-eu-v1.letsmesh.net:443', aud: 'mqtt-eu-v1.letsmesh.net' },
];

interface NodeClient {
  targetName: string;
  pubKey: string;
  client: mqtt.MqttClient;
  lastUsed: number;
}

// Pool of connections keyed by `${targetName}:${pubKey}`
const clientPool = new Map<string, NodeClient>();
let packetCounter = 0;

export async function initRelay(): Promise<void> {
  console.log('====================================================');
  console.log('       MeshCore Outbound Relay Initializing         ');
  console.log('====================================================');
  console.log(`[RELAY] ENABLE_OUTBOUND_RELAY = ${ENABLE_RELAY}`);
  console.log('====================================================');

  if (!ENABLE_RELAY) {
    console.log('[RELAY] Outbound relay service is disabled (ENABLE_OUTBOUND_RELAY=false).');
    return;
  }

  console.log('[RELAY] Relay service active. Dedicated per-node connections will initialize matching topic public keys.');

  // Heartbeat & connection cleanup every 60s
  setInterval(() => {
    console.log(`[RELAY HEARTBEAT] Active per-node connections: ${clientPool.size} | Total Relayed: ${packetCounter}`);
  }, 60000);
}

async function getOrCreateNodeClient(target: TargetConfig, pubKey: string, rawAuthToken?: string): Promise<mqtt.MqttClient | null> {
  const poolKey = `${target.name}:${pubKey.toUpperCase()}`;
  
  const existing = clientPool.get(poolKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  // Create new client matching the node's topic public key
  try {
    const username = `v1_${pubKey.toUpperCase()}`;
    let password = rawAuthToken;

    // If rawAuthToken from node is not present, generate fallback token for audience
    if (!password) {
      const tokenPayload = await createAuthToken(
        { publicKey: pubKey.toUpperCase(), aud: target.aud, iat: Math.floor(Date.now() / 1000) },
        FALLBACK_KEYPAIR.privateKey,
        pubKey.toUpperCase()
      );
      password = tokenPayload;
    }

    console.log(`[RELAY -> ${target.name}] Initializing dedicated client for node ${pubKey.substring(0, 8)}... (username: ${username.substring(0, 12)}...)`);

    const client = mqtt.connect(target.url, {
      username: username,
      password: password,
      keepalive: 20,
      reconnectPeriod: 5000,
      rejectUnauthorized: false,
    });

    client.on('connect', () => {
      console.log(`[RELAY -> ${target.name}] ✓ Connected and authenticated node ${pubKey.substring(0, 8)} with ${target.name}`);
    });

    client.on('error', (err) => {
      console.error(`[RELAY -> ${target.name}] ✗ Node ${pubKey.substring(0, 8)} connection error: ${err.message}`);
    });

    const entry: NodeClient = {
      targetName: target.name,
      pubKey,
      client,
      lastUsed: Date.now(),
    };

    clientPool.set(poolKey, entry);
    return client;
  } catch (err: any) {
    console.error(`[RELAY -> ${target.name}] ✗ Error creating client for ${pubKey.substring(0, 8)}:`, err?.message || err);
    return null;
  }
}

export async function forwardPacketToRelays(
  topic: string,
  payload: Buffer,
  clientPubKey?: string,
  rawAuthToken?: string
): Promise<void> {
  if (!ENABLE_RELAY) return;
  if (!topic.startsWith('meshcore/')) return;
  if (topic.includes('/internal')) return; // Do not forward internal PII topics

  const parts = topic.split('/').map(p => p.trim());
  // Topic format: meshcore / IATA / PUBLIC_KEY / subtopic
  if (parts.length < 4) return;
  const topicPubKey = parts[2].toUpperCase();

  packetCounter++;

  for (const target of TARGETS) {
    try {
      // Get or create client connection matching the topic's public key
      const client = await getOrCreateNodeClient(target, topicPubKey, rawAuthToken);
      if (client && client.connected) {
        client.publish(topic, payload, (err) => {
          if (err) {
            console.error(`[RELAY -> ${target.name}] ✗ Forward error on ${topic}: ${err.message}`);
          } else {
            console.log(`[RELAY -> ${target.name}] ✓ Forwarded ${topic} (${payload.length} bytes)`);
          }
        });
      } else {
        console.warn(`[RELAY -> ${target.name}] ⚠️ Connection initializing for ${topicPubKey.substring(0, 8)} on ${topic}`);
      }
    } catch (err: any) {
      console.error(`[RELAY -> ${target.name}] ✗ Error relaying packet:`, err?.message || err);
    }
  }
}
