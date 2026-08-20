import mqtt from 'mqtt';
import { createAuthToken } from '@michaelhart/meshcore-decoder';

function isEnabled(val?: string): boolean {
  if (!val) return false;
  const normalized = val.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

// Single combined enable flag (supports ENABLE_OUTBOUND_RELAY, ENABLE_RELAY, or legacy flags)
const ENABLE_RELAY = isEnabled(process.env.ENABLE_OUTBOUND_RELAY) ||
                     isEnabled(process.env.ENABLE_RELAY) ||
                     isEnabled(process.env.ENABLE_MESHMAPPER_RELAY) ||
                     isEnabled(process.env.ENABLE_LETSMESH_RELAY);

// Static MeshCore Ed25519 observer keypair used for signing MeshMapper & LetsMesh JWT auth tokens
const RELAY_KEYPAIR = {
  publicKey: process.env.RELAY_PUBLIC_KEY || '4852B69364572B52EFA1B6BB3E6D0ABED4F389A1CBFBB60A9BBA2CCE649CAF0E',
  privateKey: process.env.RELAY_PRIVATE_KEY || '18469d6140447f77de13cd8d761e605431f52269fbff43b0925752ed9e6745435dc6a86d2568af8b70d3365db3f88234760c8ecc645ce469829bc45b65f1d5d5',
};

interface RelayedClient {
  name: string;
  client: mqtt.MqttClient;
  aud: string;
}

const outboundClients: RelayedClient[] = [];
let packetCounter = 0;

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

export async function initRelay(): Promise<void> {
  console.log('====================================================');
  console.log('       MeshCore Outbound Relay Initializing         ');
  console.log('====================================================');
  console.log(`[RELAY] ENABLE_OUTBOUND_RELAY = ${ENABLE_RELAY}`);
  console.log(`[RELAY] Observer Public Key   = ${RELAY_KEYPAIR.publicKey}`);
  console.log('====================================================');

  if (!ENABLE_RELAY) {
    console.log('[RELAY] Outbound relay service is disabled (ENABLE_OUTBOUND_RELAY=false).');
    return;
  }

  const setupOutbound = async (name: string, url: string, aud: string) => {
    try {
      console.log(`[${name}] Generating initial MeshCore Auth Token for audience '${aud}'...`);
      const auth = await createSignedToken(aud);
      console.log(`[${name}] Connecting to ${url} (Username: ${auth.username.substring(0, 12)}...)...`);

      const client = mqtt.connect(url, {
        username: auth.username,
        password: auth.token,
        keepalive: 20, // 20s keepalive prevents Cloudflare/WebSocket proxy idle timeouts
        reconnectPeriod: 5000,
        rejectUnauthorized: false,
        resubscribe: true,
      });

      client.on('connect', () => {
        console.log(`[${name}] ✓ SUCCESSFULLY CONNECTED AND AUTHENTICATED WITH ${name}!`);
      });

      // Regenerate fresh token on every reconnection attempt
      client.on('reconnect', async () => {
        try {
          console.log(`[${name}] 🔄 Refreshing auth token and reconnecting to ${name}...`);
          const freshAuth = await createSignedToken(aud);
          (client as any).options.username = freshAuth.username;
          (client as any).options.password = freshAuth.token;
        } catch (err: any) {
          console.error(`[${name}] ✗ Error generating fresh token during reconnect:`, err?.message || err);
        }
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

      outboundClients.push({ name, client, aud });
    } catch (err: any) {
      console.error(`[${name}] ✗ Error setting up client:`, err?.message || err);
    }
  };

  // Connect to all community relay targets under single enable flag
  await setupOutbound('MeshMapper', 'wss://mqtt.meshmapper.net:443', 'mqtt.meshmapper.net');
  await setupOutbound('LetsMesh US', 'wss://mqtt-us-v1.letsmesh.net:443', 'mqtt-us-v1.letsmesh.net');
  await setupOutbound('LetsMesh EU', 'wss://mqtt-eu-v1.letsmesh.net:443', 'mqtt-eu-v1.letsmesh.net');

  // Periodic heartbeat every 60s in main server logs + periodic token refresh check
  setInterval(async () => {
    if (outboundClients.length > 0) {
      const statusStr = outboundClients.map(c => `${c.name}: ${c.client.connected ? 'CONNECTED' : 'DISCONNECTED'}`).join(' | ');
      console.log(`[RELAY HEARTBEAT] Targets: [ ${statusStr} ] | Total Packets Relayed: ${packetCounter}`);

      // Proactively trigger reconnect if any client is disconnected
      for (const item of outboundClients) {
        if (!item.client.connected) {
          console.log(`[RELAY RECOVERY] Triggering reconnect for disconnected client '${item.name}'...`);
          try {
            const freshAuth = await createSignedToken(item.aud);
            (item.client as any).options.username = freshAuth.username;
            (item.client as any).options.password = freshAuth.token;
            item.client.reconnect();
          } catch (e: any) {
            console.error(`[RELAY RECOVERY] Failed to trigger reconnect for '${item.name}':`, e?.message || e);
          }
        }
      }
    }
  }, 60000);
}

export function forwardPacketToRelays(topic: string, payload: Buffer): void {
  if (outboundClients.length === 0) return;
  if (!topic.startsWith('meshcore/')) return;
  if (topic.includes('/internal')) return; // Do not forward internal PII topics

  packetCounter++;
  for (const { name, client } of outboundClients) {
    if (client.connected) {
      client.publish(topic, payload, (err) => {
        if (err) {
          console.error(`[RELAY -> ${name}] ✗ Forwarding failed on ${topic}: ${err.message}`);
        } else {
          console.log(`[RELAY -> ${name}] ✓ Forwarded topic: ${topic} (${payload.length} bytes)`);
        }
      });
    } else {
      console.warn(`[RELAY -> ${name}] ⚠️ Skipped forwarding (target offline, reconnection queued): ${topic}`);
    }
  }
}
