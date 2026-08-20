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

// Dedicated Observer Keypair for Outbound Relaying
const RELAY_KEYPAIR = {
  publicKey: (process.env.RELAY_PUBLIC_KEY || '4852B69364572B52EFA1B6BB3E6D0ABED4F389A1CBFBB60A9BBA2CCE649CAF0E').toUpperCase(),
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

interface RelayedClient {
  name: string;
  url: string;
  aud: string;
  client: mqtt.MqttClient;
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
    username: `v1_${RELAY_KEYPAIR.publicKey}`,
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

  const setupOutbound = async (target: TargetConfig) => {
    try {
      const auth = await createSignedToken(target.aud);
      console.log(`[${target.name}] Connecting observer client to ${target.url}...`);

      const client = mqtt.connect(target.url, {
        username: auth.username,
        password: auth.token,
        keepalive: 30,
        reconnectPeriod: 5000,
        rejectUnauthorized: false,
        resubscribe: true,
      });

      client.on('connect', () => {
        console.log(`[${target.name}] ✓ SUCCESSFULLY CONNECTED AND AUTHENTICATED WITH ${target.name}!`);
      });

      client.on('offline', () => {
        console.log(`[${target.name}] ⚠️ Connection offline: ${target.name}`);
      });

      client.on('error', (err) => {
        console.error(`[${target.name}] ✗ Connection error: ${err.message}`);
      });

      outboundClients.push({
        name: target.name,
        url: target.url,
        aud: target.aud,
        client,
      });
    } catch (err: any) {
      console.error(`[${target.name}] ✗ Error initializing target:`, err?.message || err);
    }
  };

  for (const target of TARGETS) {
    await setupOutbound(target);
  }

  // Heartbeat every 60s
  setInterval(() => {
    if (outboundClients.length > 0) {
      const statusStr = outboundClients.map(c => `${c.name}: ${c.client.connected ? 'CONNECTED' : 'DISCONNECTED'}`).join(' | ');
      console.log(`[RELAY HEARTBEAT] Targets: [ ${statusStr} ] | Total Relayed: ${packetCounter}`);
    }
  }, 60000);
}

export function forwardPacketToRelays(topic: string, payload: Buffer): void {
  if (!ENABLE_RELAY || outboundClients.length === 0) return;
  if (!topic.startsWith('meshcore/')) return;
  if (topic.includes('/internal')) return; // Do not forward internal PII topics

  const parts = topic.split('/').map(p => p.trim());
  // Topic format: meshcore / IATA / PUBLIC_KEY / subtopic
  if (parts.length < 4) return;
  const iata = parts[1];
  const subtopic = parts.slice(3).join('/');

  // Rewrite topic to use our Observer Relay public key to ensure 100% authz match
  // e.g. meshcore/DFW/4852B693.../packets
  const targetTopic = `meshcore/${iata}/${RELAY_KEYPAIR.publicKey}/${subtopic}`;

  packetCounter++;

  for (const { name, client } of outboundClients) {
    if (client.connected) {
      client.publish(targetTopic, payload, (err) => {
        if (err) {
          console.error(`[RELAY -> ${name}] ✗ Forward error on ${targetTopic}: ${err.message}`);
        } else {
          console.log(`[RELAY -> ${name}] ✓ Relayed ${targetTopic} (${payload.length} bytes)`);
        }
      });
    } else {
      console.warn(`[RELAY -> ${name}] ⚠️ Skipped forwarding (target connecting/reconnecting) -> ${targetTopic}`);
    }
  }
}
