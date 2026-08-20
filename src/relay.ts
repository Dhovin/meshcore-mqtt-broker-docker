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

interface QueuedPacket {
  topic: string;
  payload: Buffer;
  timestamp: number;
}

interface RelayedClient {
  name: string;
  url: string;
  aud: string;
  client: mqtt.MqttClient;
  queue: QueuedPacket[];
  isConnecting: boolean;
}

const outboundClients: RelayedClient[] = [];
let packetCounter = 0;
const MAX_QUEUE_SIZE = 100;

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
      const auth = await createSignedToken(aud);
      console.log(`[${name}] Connecting to ${url}...`);

      const item: RelayedClient = {
        name,
        url,
        aud,
        queue: [],
        isConnecting: true,
        client: null as any,
      };

      const client = mqtt.connect(url, {
        username: auth.username,
        password: auth.token,
        keepalive: 10, // 10s keepalive ensures active WebSocket PINGREQ frames
        reconnectPeriod: 3000,
        rejectUnauthorized: false,
        resubscribe: true,
        connectTimeout: 10000,
        wsOptions: {
          handshakeTimeout: 10000,
        },
      });

      item.client = client;

      // Flush queue helper
      const flushQueue = () => {
        if (item.queue.length === 0) return;
        console.log(`[${name}] 🚀 Flushing ${item.queue.length} queued packet(s) after reconnect...`);
        const toSend = [...item.queue];
        item.queue = [];
        for (const pkt of toSend) {
          // Drop stale queued packets older than 5 minutes
          if (Date.now() - pkt.timestamp > 300000) continue;
          client.publish(pkt.topic, pkt.payload, (err) => {
            if (err) {
              console.error(`[RELAY -> ${name}] ✗ Flush publish error: ${err.message}`);
            } else {
              console.log(`[RELAY -> ${name}] ✓ Flushed queued packet -> ${pkt.topic}`);
            }
          });
        }
      };

      client.on('connect', () => {
        item.isConnecting = false;
        console.log(`[${name}] ✓ SUCCESSFULLY CONNECTED AND AUTHENTICATED WITH ${name}!`);
        flushQueue();
      });

      // Refresh auth token dynamically on reconnect
      client.on('reconnect', async () => {
        item.isConnecting = true;
        try {
          const freshAuth = await createSignedToken(aud);
          (client as any).options.username = freshAuth.username;
          (client as any).options.password = freshAuth.token;
        } catch (err: any) {
          console.error(`[${name}] ✗ Error generating fresh token during reconnect:`, err?.message || err);
        }
      });

      client.on('offline', () => {
        item.isConnecting = true;
      });

      client.on('close', () => {
        item.isConnecting = true;
      });

      client.on('error', (err) => {
        item.isConnecting = true;
        console.error(`[${name}] ✗ Connection error: ${err.message}`);
      });

      outboundClients.push(item);
    } catch (err: any) {
      console.error(`[${name}] ✗ Error setting up client:`, err?.message || err);
    }
  };

  // Setup all 3 targets
  await setupOutbound('MeshMapper', 'wss://mqtt.meshmapper.net:443', 'mqtt.meshmapper.net');
  await setupOutbound('LetsMesh US', 'wss://mqtt-us-v1.letsmesh.net:443', 'mqtt-us-v1.letsmesh.net');
  await setupOutbound('LetsMesh EU', 'wss://mqtt-eu-v1.letsmesh.net:443', 'mqtt-eu-v1.letsmesh.net');

  // Heartbeat & automatic recovery loop (runs every 30s)
  setInterval(async () => {
    if (outboundClients.length > 0) {
      const statusStr = outboundClients.map(c => `${c.name}: ${c.client.connected ? 'CONNECTED' : 'RECONNECTING'} (Queue: ${c.queue.length})`).join(' | ');
      console.log(`[RELAY HEARTBEAT] Targets: [ ${statusStr} ] | Total Relayed: ${packetCounter}`);

      for (const item of outboundClients) {
        if (!item.client.connected) {
          try {
            const freshAuth = await createSignedToken(item.aud);
            (item.client as any).options.username = freshAuth.username;
            (item.client as any).options.password = freshAuth.token;
            item.client.reconnect();
          } catch (e: any) {
            // Ignore temporary reconnect errors
          }
        }
      }
    }
  }, 30000);
}

export function forwardPacketToRelays(topic: string, payload: Buffer): void {
  if (outboundClients.length === 0) return;
  if (!topic.startsWith('meshcore/')) return;
  if (topic.includes('/internal')) return; // Do not forward internal PII topics

  packetCounter++;
  for (const item of outboundClients) {
    if (item.client.connected) {
      item.client.publish(topic, payload, (err) => {
        if (err) {
          console.error(`[RELAY -> ${item.name}] ✗ Forwarding error on ${topic}: ${err.message}`);
          queuePacket(item, topic, payload);
        } else {
          console.log(`[RELAY -> ${item.name}] ✓ Forwarded topic: ${topic} (${payload.length} bytes)`);
        }
      });
    } else {
      // Client is temporarily reconnecting - queue packet so it gets delivered on reconnect!
      queuePacket(item, topic, payload);
    }
  }
}

function queuePacket(item: RelayedClient, topic: string, payload: Buffer): void {
  if (item.queue.length >= MAX_QUEUE_SIZE) {
    item.queue.shift(); // Remove oldest packet
  }
  item.queue.push({
    topic,
    payload,
    timestamp: Date.now(),
  });
  console.log(`[RELAY -> ${item.name}] 📥 Queued packet for delivery upon reconnect -> ${topic} (Queue size: ${item.queue.length})`);
}
