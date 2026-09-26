// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Bản PC: tạo (một lần) tổ chức nội bộ + người dùng hệ thống (không đăng nhập được) + Gateway client cho
 * VETCLINIC CRM trên cùng máy. In {clientId, signingKey} ra stdout đúng MỘT lần cho bộ cài bọc DPAPI.
 *   node scripts/standalone-provision.mjs <clientId> [healthCallbackUrl]
 * Chạy lại khi client đã có → thoát mã 3, không in khóa (khóa không hiện lại; dùng rotate-key nếu mất).
 */
import { randomBytes } from 'node:crypto';

const { prisma } = await import('../dist/shared/database/prisma-client.js');
const { runSystemQuery } = await import('../dist/shared/tenant/tenant-context.js');
const { registerClient } = await import('../dist/modules/gateway-v2/gateway-v2-registry.js');

const [clientId, healthCallbackUrl] = process.argv.slice(2);
try {
  if (!clientId) { process.stderr.write('usage: standalone-provision.mjs <clientId> [healthCallbackUrl]\n'); process.exit(2); }
  const existing = await runSystemQuery(() => prisma.gatewaySenderClient.findUnique({ where: { clientId } }));
  if (existing) { process.stderr.write('client already provisioned\n'); process.exit(3); }
  const org = await runSystemQuery(() => prisma.organization.create({ data: { name: 'VETCLINIC CRM (máy này)' } }));
  // Người dùng kỹ thuật: mật khẩu ngẫu nhiên không lưu ở đâu, bị khóa (isActive=false) — chỉ để làm chủ sở hữu client.
  const user = await runSystemQuery(() => prisma.user.create({ data: {
    orgId: org.id, fullName: 'VETCLINIC CRM (hệ thống)', role: 'owner', isActive: false,
    passwordHash: `disabled$${randomBytes(32).toString('hex')}`,
  } }));
  const { client, signingKey } = await registerClient({ clientId, orgId: org.id, ownerUserId: user.id, healthCallbackUrl: healthCallbackUrl || null });
  process.stdout.write(`${JSON.stringify({ clientId: client.clientId, signingKey })}\n`);
} finally {
  await prisma.$disconnect();
}
