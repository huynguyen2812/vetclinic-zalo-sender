// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Đăng ký Gateway client và channel account (thao tác của người vận hành, qua script
 * scripts/gateway-v2-admin.ts — không có HTTP route công khai cho việc này).
 * Signing key chỉ hiện MỘT LẦN khi tạo/xoay; DB chỉ giữ bản mã hoá.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { sealSigningKey } from './gateway-v2-auth.js';
import { V2_CAPABILITIES } from './gateway-v2-types.js';
import type { ZaloSessionProvider } from './zalo-session-provider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const newKey = () => randomBytes(32).toString('base64url');

export async function registerClient(input: { clientId: string; orgId: string; ownerUserId: string; healthCallbackUrl?: string | null }) {
  if (!/^[A-Za-z0-9._:-]{3,100}$/.test(input.clientId)) throw new Error('clientId không hợp lệ');
  if (process.env.GATEWAY_SENDER_CLIENT_ID && input.clientId === process.env.GATEWAY_SENDER_CLIENT_ID) throw new Error('clientId trùng client pilot v1');
  const owner = await runSystemQuery(() => prisma.user.findUnique({ where: { id: input.ownerUserId }, select: { orgId: true } }));
  if (!owner || owner.orgId !== input.orgId) throw new Error('ownerUserId phải thuộc orgId');
  const signingKey = newKey();
  const client = await runSystemQuery(() => prisma.gatewaySenderClient.create({ data: {
    clientId: input.clientId, orgId: input.orgId, ownerUserId: input.ownerUserId, signingKeyEnc: sealSigningKey(signingKey), healthCallbackUrl: input.healthCallbackUrl ?? null,
  } }));
  return { client, signingKey };
}

/** Xoay khoá: khoá cũ còn hiệu lực graceMinutes để Gateway kịp cập nhật. */
export async function rotateClientKey(clientId: string, graceMinutes = 60) {
  const c = await runSystemQuery(() => prisma.gatewaySenderClient.findUniqueOrThrow({ where: { clientId } }));
  if (c.revokedAt) throw new Error('client đã thu hồi');
  const signingKey = newKey();
  await runSystemQuery(() => prisma.gatewaySenderClient.update({ where: { id: c.id }, data: {
    signingKeyEnc: sealSigningKey(signingKey), keyVersion: { increment: 1 },
    previousSigningKeyEnc: c.signingKeyEnc, previousKeyExpiresAt: new Date(Date.now() + Math.max(0, graceMinutes) * 60_000),
  } }));
  return { signingKey };
}

export async function revokeClient(clientId: string) {
  await runSystemQuery(() => prisma.gatewaySenderClient.update({ where: { clientId }, data: { revokedAt: new Date(), previousSigningKeyEnc: null, previousKeyExpiresAt: null } }));
}

/** Gắn channelAccountId của Gateway vào client. Một channelAccountId chỉ thuộc một client (unique). */
export async function registerAccount(clientId: string, channelAccountId: string) {
  if (!UUID.test(channelAccountId)) throw new Error('channelAccountId phải là UUID');
  const c = await runSystemQuery(() => prisma.gatewaySenderClient.findUniqueOrThrow({ where: { clientId } }));
  if (c.revokedAt) throw new Error('client đã thu hồi');
  return runSystemQuery(() => prisma.gatewayChannelAccount.create({ data: {
    clientRef: c.id, channelAccountId: channelAccountId.toLowerCase(), capabilities: V2_CAPABILITIES,
  } }));
}

/** Thu hồi account: dừng + xoá phiên Zalo của đúng nick, không đụng account khác. */
export async function revokeAccount(channelAccountId: string, provider: ZaloSessionProvider) {
  const acc = await runSystemQuery(() => prisma.gatewayChannelAccount.findUniqueOrThrow({ where: { channelAccountId: channelAccountId.toLowerCase() } }));
  if (acc.zaloAccountId) await provider.terminate(acc.zaloAccountId);
  await runSystemQuery(() => prisma.gatewayChannelAccount.update({ where: { id: acc.id }, data: { status: 'REVOKED', revokedAt: new Date(), sessionVersion: { increment: 1 } } }));
}
