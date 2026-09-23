// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Công cụ vận hành Gateway sender v2 (chạy trên máy chủ sender, không qua HTTP):
 *   npx tsx scripts/gateway-v2-admin.ts register-client <clientId> <orgId> <ownerUserId> [healthCallbackUrl]
 *   npx tsx scripts/gateway-v2-admin.ts rotate-key <clientId> [graceMinutes]
 *   npx tsx scripts/gateway-v2-admin.ts revoke-client <clientId>
 *   npx tsx scripts/gateway-v2-admin.ts register-account <clientId> <channelAccountId>
 *   npx tsx scripts/gateway-v2-admin.ts revoke-account <channelAccountId>
 * Signing key chỉ in ra MỘT LẦN (register-client / rotate-key) để cấu hình phía Gateway; không lưu log.
 */
import { existsSync } from 'node:fs';

// Trong image Docker chỉ có dist/ (không có src/) → tự chọn dist khi có.
const BASE = existsSync(new URL('../dist/modules/gateway-v2/gateway-v2-registry.js', import.meta.url)) ? '../dist' : '../src';
const { prisma } = await import(`${BASE}/shared/database/prisma-client.js`);
const { registerAccount, registerClient, revokeAccount, revokeClient, rotateClientKey } = await import(`${BASE}/modules/gateway-v2/gateway-v2-registry.js`);
const { V2_CAPABILITIES } = await import(`${BASE}/modules/gateway-v2/gateway-v2-types.js`);

async function main() {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  switch (cmd) {
    case 'register-client': {
      const { client, signingKey } = await registerClient({ clientId: a, orgId: b, ownerUserId: c, healthCallbackUrl: d ?? null });
      process.stdout.write(`${JSON.stringify({ clientId: client.clientId, signingKey, note: 'Lưu signingKey vào Gateway ngay; không hiện lại.' })}\n`);
      break;
    }
    case 'rotate-key': {
      const { signingKey } = await rotateClientKey(a, b ? Number(b) : 60);
      process.stdout.write(`${JSON.stringify({ clientId: a, signingKey })}\n`);
      break;
    }
    case 'revoke-client': await revokeClient(a); break;
    case 'register-account': {
      const acc = await registerAccount(a, b);
      process.stdout.write(`${JSON.stringify({ channelAccountId: acc.channelAccountId, capabilities: V2_CAPABILITIES })}\n`);
      break;
    }
    case 'revoke-account': {
      const { poolSessionProvider } = await import(`${BASE}/modules/gateway-v2/pool-session-provider.js`);
      await revokeAccount(a, poolSessionProvider);
      break;
    }
    default:
      process.stderr.write('Lệnh: register-client | rotate-key | revoke-client | register-account | revoke-account\n');
      process.exitCode = 2;
  }
}

main().catch((e) => { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
