import mqtt from 'mqtt';

function isEnabled(val?: string): boolean {
  if (!val) return false;
  const normalized = val.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

const ENABLE_RELAY = isEnabled(process.env.ENABLE_OUTBOUND_RELAY) ||
                     isEnabled(process.env.ENABLE_RELAY) ||
                     isEnabled(process.env.ENABLE_MESHMAPPER_RELAY) ||
                     isEnabled(process.env.ENABLE_LETSMESH_RELAY);

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

// Map of node public keys to their authentic Ed25519 signed JWT tokens
export const nodeAuthTokens = new Map<string, string>();

// Pool of active target connections keyed by `${targetName}:${pubKey}`
const clientPool = new Map<string, NodeClient>();
let packetCounter = 0;

export function registerNodeAuthToken(pubKey: string, token: string): void {
  if (pubKey && token) {
    const formattedKey = pubKey.toUpperCase();
    nodeAuthTokens.set(formattedKey, token);
    console.log(`[RELAY] Registered authentic JWT token for node ${formattedKey.substring(0, 8)}`);
  }
}

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

  console.log('[RELAY] Relay service active. Authentic per-node connections will initialize as nodes authenticate.');

  // Heartbeat every 60s
  setInterval(() => {
    console.log(`[RELAY HEARTBEAT] Registered node tokens: ${nodeAuthTokens.size} | Active target connections: ${clientPool.size} | Total Relayed: ${packetCounter}`);
  }, 60000);
}

async function getOrCreateNodeClient(target: TargetConfig, pubKey: string, rawAuthToken: string): Promise<mqtt.MqttClient | null> {
  const poolKey = `${target.name}:${pubKey.toUpperCase()}`;
  
  const existing = clientPool.get(poolKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  try {
    const username = `v1_${pubKey.toUpperCase()}`;
    console.log(`[RELAY -> ${target.name}] Connecting dedicated client for node ${pubKey.substring(0, 8)}... (username: ${username.substring(0, 12)}...)`);

    const client = mqtt.connect(target.url, {
      username: username,
      password: rawAuthToken,
      keepalive: 20,
      reconnectPeriod: 5000,
      rejectUnauthorized: false,
    });

    client.on('connect', () => {
      console.log(`[RELAY -> ${target.name}] ✓ Connected and authenticated node ${pubKey.substring(0, 8)} with ${target.name}!`);
    });

    client.on('error', (err) => {
      console.error(`[RELAY -> ${target.name}] ✗ Node ${pubKey.substring(0, 8)} connection error: ${err.message}`);
    });

    const entry: NodeClient = {
      targetName: target.name,
      pubKey: pubKey.toUpperCase(),
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

  // Retrieve authentic node signed JWT token
  const authToken = rawAuthToken || (clientPubKey ? nodeAuthTokens.get(clientPubKey.toUpperCase()) : undefined) || nodeAuthTokens.get(topicPubKey);

  if (!authToken) {
    // Cannot authenticate with remote broker without node's genuine signed JWT token
    console.warn(`[RELAY] ⚠️ Skipping relay for topic ${topic}: No authentic JWT token registered for node ${topicPubKey.substring(0, 8)} yet.`);
    return;
  }

  packetCounter++;

  for (const target of TARGETS) {
    try {
      const client = await getOrCreateNodeClient(target, topicPubKey, authToken);
      if (client && client.connected) {
        client.publish(topic, payload, (err) => {
          if (err) {
            console.error(`[RELAY -> ${target.name}] ✗ Forward error on ${topic}: ${err.message}`);
          } else {
            console.log(`[RELAY -> ${target.name}] ✓ Forwarded ${topic} (${payload.length} bytes)`);
          }
        });
      } else {
        console.warn(`[RELAY -> ${target.name}] ⚠️ Connection connecting for ${topicPubKey.substring(0, 8)} on ${topic}`);
      }
    } catch (err: any) {
      console.error(`[RELAY -> ${target.name}] ✗ Error relaying packet:`, err?.message || err);
    }
  }
}
