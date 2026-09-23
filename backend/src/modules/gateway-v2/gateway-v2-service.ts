// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Customer Care Gateway sender contract v2 — nghiệp vụ.
 *
 * Mapping: GatewayChannelAccount.channelAccountId (UUID của Gateway) ↔ đúng 1 nick (zalo_accounts).
 * Một account chỉ thuộc một Gateway client; account của client khác và id ngẫu nhiên → cùng 404.
 *
 * Gửi (idempotent theo deliveryAttemptId, ràng buộc DB unique(client, deliveryAttemptId)):
 *   CLAIMED ──kiểm tra trước khi gửi thất bại──▶ NOT_SENT (được claim lại cùng request hash)
 *   CLAIMED ──ghi SENDING bền TRƯỚC khi gọi Zalo──▶ SENDING ──▶ SENT(providerMessageId) | UNKNOWN
 *   Gửi lại: hash khác → 409; SENT → trả lại cùng id; SENDING/UNKNOWN/CLAIMED → UNKNOWN (không gửi mù).
 *
 * Không bao giờ: gửi lời mời kết bạn, tạo hội thoại, thêm danh bạ, dò người lạ. Người nhận phải là
 * bạn bè hoặc đã có hội thoại với ĐÚNG nick đó (dữ liệu đã đồng bộ).
 */
import { randomBytes } from 'node:crypto';
import type { GatewayChannelAccount, GatewayLoginAttempt, GatewaySenderClient } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery, withTenant } from '../../shared/tenant/tenant-context.js';
import { normalizePhone } from '../../shared/utils/phone.js';
import { sessionEncryptionEnabled } from '../../shared/zalo-session-codec.js';
import { logger } from '../../shared/utils/logger.js';
import { KeyedMutex } from './account-lock.js';
import { sha256Hex } from './gateway-v2-auth.js';
import { ProviderNotConnectedError, type ZaloSessionProvider } from './zalo-session-provider.js';
import {
  GatewayV2Error, NOT_FOUND, V2_CAPABILITIES, type Eligibility, type LoginEvent, type LoginStatus, type NotSentCode, type SendResult,
} from './gateway-v2-types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_LOGIN = ['PENDING', 'SCANNED'];
export const MIN_RETENTION_DAYS = 7;

type EffectiveState = 'REVOKED' | 'DISCONNECTED' | 'RESTRICTED' | 'PENDING_LOGIN' | 'CONNECTING' | 'CONNECTED' | 'UNAVAILABLE' | 'RELOGIN_REQUIRED';

export interface ServiceOptions {
  qrTtlMs?: number;
  qrWaitMs?: number;
  sendTimeoutMs?: number;
  now?: () => Date;
}

export function maskPhone(phone: string | null | undefined): string | null {
  const d = (phone || '').replace(/\D/g, '');
  if (d.length < 8) return null;
  const local = d.startsWith('84') ? `0${d.slice(2)}` : d;
  return `${local.slice(0, 3)}****${local.slice(-3)}`;
}

export class GatewayV2Service {
  private readonly lock = new KeyedMutex();
  private readonly qrTtlMs: number;
  private readonly qrWaitMs: number;
  private readonly sendTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly provider: ZaloSessionProvider, opts: ServiceOptions = {}) {
    this.qrTtlMs = Math.min(opts.qrTtlMs ?? 180_000, 180_000); // hợp đồng: QR tối đa 3 phút
    this.qrWaitMs = opts.qrWaitMs ?? 20_000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 8_000; // < timeout 10 s phía Gateway
    this.now = opts.now ?? (() => new Date());
  }

  // ───────────────────────── registration ─────────────────────────
  /**
   * Gateway tự đăng ký channelAccountId cho CHÍNH client đã ký request (không chọn được client/tenant khác).
   * Idempotent: gọi lại → trả cùng kết quả. Id đã thuộc client khác hoặc đã thu hồi → cùng 404 như id lạ.
   */
  async register(client: GatewaySenderClient, channelAccountId: string): Promise<{ channelAccountId: string; status: string; capabilities: typeof V2_CAPABILITIES }> {
    if (!UUID.test(channelAccountId)) throw NOT_FOUND();
    const id = channelAccountId.toLowerCase();
    const view = (a: GatewayChannelAccount) => {
      if (a.clientRef !== client.id || a.revokedAt || a.status === 'REVOKED') throw NOT_FOUND();
      return { channelAccountId: a.channelAccountId, status: a.status, capabilities: V2_CAPABILITIES };
    };
    const existing = await runSystemQuery(() => prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: id } }));
    if (existing) return view(existing);
    try {
      return view(await runSystemQuery(() => prisma.gatewayChannelAccount.create({ data: { clientRef: client.id, channelAccountId: id, capabilities: V2_CAPABILITIES } })));
    } catch (err) {
      // Hai request đăng ký đồng thời: unique(channel_account_id) chỉ cho một bản ghi; bên thua đọc lại.
      const again = await runSystemQuery(() => prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: id } }));
      if (again) return view(again);
      throw err;
    }
  }

  // ───────────────────────── account ownership ─────────────────────────
  /** Account thuộc client này (chưa thu hồi) — ngược lại cùng một 404. */
  async ownedAccount(client: GatewaySenderClient, channelAccountId: string): Promise<GatewayChannelAccount> {
    if (!UUID.test(channelAccountId)) throw NOT_FOUND();
    const acc = await runSystemQuery(() => prisma.gatewayChannelAccount.findUnique({ where: { channelAccountId: channelAccountId.toLowerCase() } }));
    if (!acc || acc.clientRef !== client.id || acc.revokedAt || acc.status === 'REVOKED') throw NOT_FOUND();
    return acc;
  }

  private async effectiveState(acc: GatewayChannelAccount): Promise<EffectiveState> {
    if (acc.revokedAt || acc.status === 'REVOKED') return 'REVOKED';
    if (acc.status === 'DISCONNECTED') return 'DISCONNECTED';
    if (acc.status === 'RESTRICTED') return 'RESTRICTED';
    if (!acc.zaloAccountId) return acc.status === 'CONNECTING' ? 'CONNECTING' : 'PENDING_LOGIN';
    const st = this.provider.status(acc.zaloAccountId);
    if (st === 'connected') return 'CONNECTED';
    if (st === 'connecting' || st === 'qr_pending') return 'CONNECTING';
    return (await this.provider.hasSavedSession(acc.zaloAccountId)) ? 'UNAVAILABLE' : 'RELOGIN_REQUIRED';
  }

  // ───────────────────────── QR login ─────────────────────────
  async loginStart(client: GatewaySenderClient, channelAccountId: string): Promise<{ loginId: string; qrImage: string; expiresAt: string }> {
    const acc = await this.ownedAccount(client, channelAccountId);
    if (!sessionEncryptionEnabled()) throw new GatewayV2Error(503, 'SESSION_ENCRYPTION_REQUIRED');
    let qrResolve!: (img: string) => void; let qrReject!: (code: string) => void;
    const qr = new Promise<string>((res, rej) => { qrResolve = res; qrReject = rej; });
    const attempt = await this.lock.run(acc.id, async () => {
      await this.closeOpenLogins(acc, 'SUPERSEDED');
      const fresh = await runSystemQuery(() => prisma.gatewayChannelAccount.findUniqueOrThrow({ where: { id: acc.id } }));
      let nickId = fresh.zaloAccountId; let provisional: string | null = null; let expectedUid: string | null = null;
      if (nickId) {
        expectedUid = (await runSystemQuery(() => prisma.zaloAccount.findUnique({ where: { id: nickId! }, select: { zaloUid: true } })))?.zaloUid ?? null;
      } else {
        // Nick tạm: chỉ giữ lại nếu QR kết nối thành công; hết hạn/thất bại thì xoá (không để nick rác).
        const nick = await withTenant(client.orgId, () => prisma.zaloAccount.create({ data: {
          orgId: client.orgId, ownerUserId: client.ownerUserId, status: 'disconnected', displayName: `Gateway ${channelAccountId.slice(0, 8)}`,
        }, select: { id: true } }));
        nickId = provisional = nick.id;
      }
      const loginId = randomBytes(24).toString('base64url');
      const expiresAt = new Date(this.now().getTime() + this.qrTtlMs);
      const created = await runSystemQuery(() => prisma.$transaction([
        prisma.gatewayLoginAttempt.create({ data: { id: loginId, accountRef: acc.id, status: 'PENDING', provisionalZaloAccountId: provisional, expectedZaloUid: expectedUid, expiresAt } }),
        prisma.gatewayChannelAccount.update({ where: { id: acc.id }, data: { status: fresh.status === 'DISCONNECTED' || !fresh.zaloAccountId ? 'CONNECTING' : fresh.status } }),
      ]));
      let gotQr = false;
      this.provider.startQrLogin(nickId, (e) => {
        if (e.type === 'qr' && !gotQr) { gotQr = true; qrResolve(e.image); return; }
        if ((e.type === 'failed' || e.type === 'expired') && !gotQr) qrReject(e.type === 'failed' ? e.code : 'EXPIRED');
        void this.onLoginEvent(created[0], nickId!, e).catch((err) => logger.warn(`[gateway-v2] login event error`, err?.message ?? err));
      });
      return created[0];
    });
    const timer = setTimeout(() => qrReject('QR_TIMEOUT'), this.qrWaitMs);
    try {
      const image = await qr;
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error('BAD_QR');
      return { loginId: attempt.id, qrImage: image, expiresAt: attempt.expiresAt.toISOString() };
    } catch {
      await this.finishLogin(attempt.id, 'FAILED', 'QR_NOT_GENERATED');
      throw new GatewayV2Error(503, 'SENDER_LOGIN_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  private async onLoginEvent(attempt: GatewayLoginAttempt, nickId: string, e: LoginEvent): Promise<void> {
    if (e.type === 'scanned') {
      await runSystemQuery(() => prisma.gatewayLoginAttempt.updateMany({ where: { id: attempt.id, status: 'PENDING' }, data: { status: 'SCANNED' } }));
    } else if (e.type === 'expired') {
      await this.finishLogin(attempt.id, 'EXPIRED');
    } else if (e.type === 'failed') {
      await this.finishLogin(attempt.id, 'FAILED', e.code);
    } else if (e.type === 'connected') {
      await this.lock.run(attempt.accountRef, () => this.onConnected(attempt, nickId, e.zaloUid));
    }
  }

  private async onConnected(attempt: GatewayLoginAttempt, nickId: string, zaloUid: string): Promise<void> {
    const current = await runSystemQuery(() => prisma.gatewayLoginAttempt.findUnique({ where: { id: attempt.id } }));
    if (!current || !OPEN_LOGIN.includes(current.status)) {
      // Phiên QR đã bị thay/hết hạn nhưng Zalo vẫn kết nối: không gán vào account.
      this.provider.cancelLogin(nickId);
      if (current?.provisionalZaloAccountId === nickId) await this.provider.terminate(nickId).catch(() => undefined);
      return;
    }
    if (current.expectedZaloUid && current.expectedZaloUid !== zaloUid) {
      // Đăng nhập lại bằng MỘT tài khoản Zalo khác → từ chối, không trộn phiên.
      await this.provider.terminate(nickId).catch(() => undefined);
      await runSystemQuery(() => prisma.zaloAccount.update({ where: { id: nickId }, data: { zaloUid: current.expectedZaloUid } })).catch(() => undefined);
      await this.finishLogin(attempt.id, 'FAILED', 'ACCOUNT_MISMATCH');
      await runSystemQuery(() => prisma.gatewayChannelAccount.update({ where: { id: attempt.accountRef }, data: { status: 'RELOGIN_REQUIRED' } }));
      await this.enqueueHealth(attempt.accountRef, 'RELOGIN_REQUIRED', 'ACCOUNT_MISMATCH');
      return;
    }
    const nick = await runSystemQuery(() => prisma.zaloAccount.findUnique({ where: { id: nickId }, select: { displayName: true, phone: true } }));
    await runSystemQuery(() => prisma.$transaction([
      prisma.gatewayChannelAccount.update({ where: { id: attempt.accountRef }, data: {
        zaloAccountId: nickId, status: 'CONNECTED', sessionVersion: { increment: 1 },
        displayName: nick?.displayName?.slice(0, 160) ?? null, phoneMasked: maskPhone(nick?.phone),
      } }),
      prisma.gatewayLoginAttempt.update({ where: { id: attempt.id }, data: { status: 'CONNECTED', provisionalZaloAccountId: null } }),
    ]));
    await this.enqueueHealth(attempt.accountRef, 'CONNECTED', 'QR_LOGIN');
  }

  /** Đóng một phiên QR đang mở; dọn nick tạm nếu phiên chưa kết nối. */
  private async finishLogin(loginId: string, status: 'EXPIRED' | 'FAILED' | 'SUPERSEDED', code?: string): Promise<boolean> {
    const att = await runSystemQuery(() => prisma.gatewayLoginAttempt.findUnique({ where: { id: loginId }, include: { account: true } }));
    if (!att) return false;
    const provisional = att.provisionalZaloAccountId && att.account.zaloAccountId !== att.provisionalZaloAccountId ? att.provisionalZaloAccountId : null;
    // Đóng phiên + xoá nick tạm trong CÙNG transaction: không ai thấy trạng thái đóng mà nick rác còn.
    const closed = await runSystemQuery(() => prisma.$transaction(async (tx) => {
      const r = await tx.gatewayLoginAttempt.updateMany({ where: { id: loginId, status: { in: OPEN_LOGIN } }, data: { status, failureCode: code ?? null } });
      if (!r.count) return false;
      if (provisional) {
        await tx.zaloAccount.deleteMany({ where: { id: provisional, zaloUid: null } });
        await tx.gatewayChannelAccount.updateMany({ where: { id: att.accountRef, status: 'CONNECTING', zaloAccountId: null }, data: { status: 'PENDING_LOGIN' } });
      }
      return true;
    }));
    if (!closed) return false;
    const nickId = att.provisionalZaloAccountId ?? att.account.zaloAccountId;
    if (nickId) this.provider.cancelLogin(nickId);
    if (!provisional && att.account.zaloAccountId && status !== 'SUPERSEDED') {
      // Đăng nhập lại thất bại: thử khôi phục phiên cũ đã lưu (nếu còn), trạng thái đọc trực tiếp từ pool.
      this.provider.restoreSaved(att.account.zaloAccountId);
    }
    return true;
  }

  private async closeOpenLogins(acc: GatewayChannelAccount, status: 'SUPERSEDED' | 'EXPIRED'): Promise<void> {
    const open = await runSystemQuery(() => prisma.gatewayLoginAttempt.findMany({ where: { accountRef: acc.id, status: { in: OPEN_LOGIN } }, select: { id: true } }));
    for (const o of open) await this.finishLogin(o.id, status);
  }

  async loginStatus(client: GatewaySenderClient, channelAccountId: string, loginId: string): Promise<{ status: LoginStatus; displayName?: string; phoneMasked?: string }> {
    const acc = await this.ownedAccount(client, channelAccountId);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(loginId)) throw NOT_FOUND();
    let att = await runSystemQuery(() => prisma.gatewayLoginAttempt.findUnique({ where: { id: loginId } }));
    if (!att || att.accountRef !== acc.id) throw NOT_FOUND(); // loginId của account/client khác = không tồn tại
    if (OPEN_LOGIN.includes(att.status) && att.expiresAt.getTime() <= this.now().getTime()) {
      await this.lock.run(acc.id, () => this.finishLogin(att!.id, 'EXPIRED'));
      att = (await runSystemQuery(() => prisma.gatewayLoginAttempt.findUnique({ where: { id: loginId } })))!;
    }
    const status: LoginStatus = att.status === 'SUPERSEDED' ? 'EXPIRED' : (att.status as LoginStatus);
    if (status !== 'CONNECTED') return { status };
    const fresh = await runSystemQuery(() => prisma.gatewayChannelAccount.findUniqueOrThrow({ where: { id: acc.id } }));
    return { status, ...(fresh.displayName ? { displayName: fresh.displayName } : {}), ...(fresh.phoneMasked ? { phoneMasked: fresh.phoneMasked } : {}) };
  }

  // ───────────────────────── remote control ─────────────────────────
  async pause(client: GatewaySenderClient, channelAccountId: string) {
    const acc = await this.ownedAccount(client, channelAccountId);
    await this.lock.run(acc.id, async () => {
      const before = await runSystemQuery(() => prisma.gatewayChannelAccount.findUniqueOrThrow({ where: { id: acc.id } }));
      await runSystemQuery(() => prisma.gatewayChannelAccount.update({ where: { id: acc.id }, data: { paused: true } }));
      if (!before.paused) await this.enqueueHealth(acc.id, 'PAUSED', 'REMOTE_PAUSE');
    });
    return { ok: true, paused: true };
  }

  async resume(client: GatewaySenderClient, channelAccountId: string) {
    const acc = await this.ownedAccount(client, channelAccountId);
    return this.lock.run(acc.id, async () => {
      const fresh = await runSystemQuery(() => prisma.gatewayChannelAccount.findUniqueOrThrow({ where: { id: acc.id } }));
      const state = await this.effectiveState(fresh);
      if (state !== 'CONNECTED') throw new GatewayV2Error(409, state === 'UNAVAILABLE' || state === 'CONNECTING' ? 'ACCOUNT_UNAVAILABLE' : 'RELOGIN_REQUIRED');
      await runSystemQuery(() => prisma.gatewayChannelAccount.update({ where: { id: acc.id }, data: { paused: false } }));
      if (fresh.paused) await this.enqueueHealth(acc.id, 'CONNECTED', 'REMOTE_RESUME');
      return { ok: true, paused: false };
    });
  }

  async disconnect(client: GatewaySenderClient, channelAccountId: string) {
    const acc = await this.ownedAccount(client, channelAccountId);
    return this.lock.run(acc.id, async () => {
      await this.closeOpenLogins(acc, 'SUPERSEDED');
      const fresh = await runSystemQuery(() => prisma.gatewayChannelAccount.findUniqueOrThrow({ where: { id: acc.id } }));
      if (fresh.zaloAccountId) await this.provider.terminate(fresh.zaloAccountId);
      await runSystemQuery(() => prisma.gatewayChannelAccount.update({ where: { id: acc.id }, data: { status: 'DISCONNECTED', sessionVersion: { increment: 1 } } }));
      await this.enqueueHealth(acc.id, 'DISCONNECTED', 'REMOTE_DISCONNECT');
      return { ok: true };
    });
  }

  // ───────────────────────── recipient ─────────────────────────
  /** Chỉ đọc dữ liệu đã đồng bộ của ĐÚNG nick: bạn bè đã chấp nhận hoặc đã có hội thoại. */
  private async findKnownRecipient(orgId: string, nickId: string, phoneNormalized: string) {
    const rows = await withTenant(orgId, () => prisma.friend.findMany({
      where: { orgId, zaloAccountId: nickId, contact: { phoneNormalized, mergedInto: null }, OR: [{ friendshipStatus: 'accepted' }, { hasConversation: true }] },
      select: { zaloUidInNick: true, friendshipStatus: true, hasConversation: true },
      take: 5,
    }));
    const friend = rows.find((r) => r.friendshipStatus === 'accepted');
    if (friend) return { uid: friend.zaloUidInNick, kind: 'ELIGIBLE_EXISTING_FRIEND' as const };
    const conv = rows.find((r) => r.hasConversation);
    if (conv) return { uid: conv.zaloUidInNick, kind: 'ELIGIBLE_EXISTING_CONVERSATION' as const };
    return null;
  }

  async eligibility(client: GatewaySenderClient, channelAccountId: string, body: unknown): Promise<Eligibility> {
    const acc = await this.ownedAccount(client, channelAccountId);
    const phone = normalizePhone((body as { phoneE164?: unknown })?.phoneE164 as string);
    if (!phone) throw new GatewayV2Error(400, 'INVALID_REQUEST');
    const state = await this.effectiveState(acc);
    if (state !== 'CONNECTED' || acc.paused) return 'ACCOUNT_UNAVAILABLE';
    try {
      const r = await this.findKnownRecipient(client.orgId, acc.zaloAccountId!, phone);
      return r ? r.kind : 'NOT_FOUND';
    } catch {
      return 'UNKNOWN';
    }
  }

  // ───────────────────────── idempotent send ─────────────────────────
  async send(client: GatewaySenderClient, headerAccountId: string, body: unknown): Promise<{ status: number; result: SendResult | { code: string } }> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.channelAccountId !== 'string' || b.channelAccountId.toLowerCase() !== headerAccountId) throw new GatewayV2Error(401, 'UNAUTHORIZED', 'Invalid request authentication');
    const acc = await this.ownedAccount(client, headerAccountId);
    const phone = normalizePhone(typeof b.phoneE164 === 'string' ? b.phoneE164 : null);
    const id = typeof b.deliveryAttemptId === 'string' ? b.deliveryAttemptId.toLowerCase() : '';
    const content = typeof b.content === 'string' ? b.content : '';
    const ref = typeof b.externalReferenceId === 'string' ? b.externalReferenceId : '';
    if (!UUID.test(id) || String(b.idempotencyKey ?? '').toLowerCase() !== id || !phone || !content.trim() || content.length > 2000 || !ref || ref.length > 200) {
      return { status: 400, result: { delivery: 'NOT_SENT', code: 'INVALID_REQUEST' } };
    }
    const requestHash = sha256Hex(JSON.stringify([acc.channelAccountId, phone, content, ref]));

    // 1) Claim idempotency record (unique(client, deliveryAttemptId) — ràng buộc DB).
    const inserted = await runSystemQuery(() => prisma.$executeRaw`
      INSERT INTO "gateway_delivery_attempts" ("id", "client_ref", "account_ref", "delivery_attempt_id", "request_hash", "state", "created_at", "updated_at")
      VALUES (gen_random_uuid()::text, ${client.id}, ${acc.id}, ${id}, ${requestHash}, 'CLAIMED', NOW(), NOW())
      ON CONFLICT ("client_ref", "delivery_attempt_id") DO NOTHING`);
    if (!inserted) {
      const prev = await runSystemQuery(() => prisma.gatewayDeliveryAttempt.findUniqueOrThrow({ where: { clientRef_deliveryAttemptId: { clientRef: client.id, deliveryAttemptId: id } } }));
      if (prev.requestHash !== requestHash || prev.accountRef !== acc.id) return { status: 409, result: { code: 'IDEMPOTENCY_CONFLICT' } };
      if (prev.state === 'SENT') return { status: 200, result: { delivery: 'SENT', providerMessageId: prev.providerMessageId! } };
      if (prev.state !== 'NOT_SENT') return { status: 502, result: { delivery: 'UNKNOWN', code: prev.state === 'CLAIMED' ? 'ATTEMPT_IN_PROGRESS' : 'PREVIOUS_OUTCOME_UNKNOWN' } };
      // Lần trước chắc chắn chưa gửi → được claim lại (nguyên tử: chỉ một request thắng).
      const re = await runSystemQuery(() => prisma.gatewayDeliveryAttempt.updateMany({ where: { id: prev.id, state: 'NOT_SENT' }, data: { state: 'CLAIMED', outcomeCode: null } }));
      if (!re.count) return { status: 502, result: { delivery: 'UNKNOWN', code: 'ATTEMPT_IN_PROGRESS' } };
    }
    const rec = await runSystemQuery(() => prisma.gatewayDeliveryAttempt.findUniqueOrThrow({ where: { clientRef_deliveryAttemptId: { clientRef: client.id, deliveryAttemptId: id } } }));

    const notSent = async (code: NotSentCode, status: number) => {
      await runSystemQuery(() => prisma.gatewayDeliveryAttempt.update({ where: { id: rec.id }, data: { state: 'NOT_SENT', outcomeCode: code, completedAt: this.now() } }));
      return { status, result: { delivery: 'NOT_SENT' as const, code } };
    };

    // 2) Kiểm tra trước khi gửi + gửi, tuần tự theo account (disconnect/pause không chen giữa).
    return this.lock.run(acc.id, async (): Promise<{ status: number; result: SendResult }> => {
      const fresh = await runSystemQuery(() => prisma.gatewayChannelAccount.findUniqueOrThrow({ where: { id: acc.id } }));
      const state = await this.effectiveState(fresh);
      if (state === 'REVOKED' || state === 'DISCONNECTED' || state === 'PENDING_LOGIN' || state === 'CONNECTING' || state === 'UNAVAILABLE') return notSent('ACCOUNT_UNAVAILABLE', 423);
      if (state === 'RELOGIN_REQUIRED') return notSent('RELOGIN_REQUIRED', 423);
      if (state === 'RESTRICTED') return notSent('ACCOUNT_RESTRICTED', 423);
      if (fresh.paused) return notSent('ACCOUNT_PAUSED', 423);
      let recipient;
      try { recipient = await this.findKnownRecipient(client.orgId, fresh.zaloAccountId!, phone); } catch { return notSent('ACCOUNT_UNAVAILABLE', 423); }
      if (!recipient) return notSent('RECIPIENT_NOT_FOUND', 404);
      if (!(await this.provider.checkSendAllowed(fresh.zaloAccountId!))) return notSent('RATE_LIMITED', 429);

      // Ghi SENDING bền vững TRƯỚC khi gọi Zalo: nếu tiến trình chết từ đây, lần sau trả UNKNOWN.
      const marked = await runSystemQuery(() => prisma.gatewayDeliveryAttempt.updateMany({ where: { id: rec.id, state: 'CLAIMED' }, data: { state: 'SENDING', sendingAt: this.now(), sendCalls: { increment: 1 } } }));
      if (!marked.count) return { status: 502, result: { delivery: 'UNKNOWN' as const, code: 'ATTEMPT_IN_PROGRESS' } };
      return this.callZalo(rec.id, this.provider.sendText(fresh.zaloAccountId!, recipient.uid, content));
    });
  }

  /** Chờ kết quả Zalo (có timeout) — gọi bên trong khoá account. */
  private async callZalo(recId: string, call: Promise<{ msgId: string | null }>): Promise<{ status: number; result: SendResult }> {
    const settle = (state: 'SENT' | 'UNKNOWN', data: { providerMessageId?: string; outcomeCode?: string | null }) =>
      runSystemQuery(() => prisma.gatewayDeliveryAttempt.updateMany({ where: { id: recId, state: { in: ['SENDING', 'UNKNOWN'] } }, data: { state, ...data, completedAt: this.now() } }));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'TIMEOUT'>((r) => { timer = setTimeout(() => r('TIMEOUT'), this.sendTimeoutMs); });
    const outcome = await Promise.race([call.then((v) => ({ ok: true as const, v }), (err) => ({ ok: false as const, err })), timeout]);
    clearTimeout(timer);
    if (outcome === 'TIMEOUT') {
      await settle('UNKNOWN', { outcomeCode: 'ZALO_TIMEOUT' });
      // Zalo trả về muộn KÈM msgId = xác nhận chắc chắn → ghi SENT cho các lần hỏi lại sau.
      call.then((v) => { if (v.msgId) settle('SENT', { providerMessageId: v.msgId, outcomeCode: null }).catch((e) => logger.warn('[gateway-v2] late SENT confirmation not saved', (e as Error)?.message)); }, () => undefined);
      return { status: 502, result: { delivery: 'UNKNOWN', code: 'ZALO_TIMEOUT' } };
    }
    if (!outcome.ok) {
      if (outcome.err instanceof ProviderNotConnectedError) {
        // Ném trước khi gọi Zalo → chắc chắn chưa gửi.
        await runSystemQuery(() => prisma.gatewayDeliveryAttempt.update({ where: { id: recId }, data: { state: 'NOT_SENT', outcomeCode: 'ACCOUNT_UNAVAILABLE', completedAt: this.now() } }));
        return { status: 423, result: { delivery: 'NOT_SENT', code: 'ACCOUNT_UNAVAILABLE' } };
      }
      await settle('UNKNOWN', { outcomeCode: 'ZALO_SEND_ERROR' });
      return { status: 502, result: { delivery: 'UNKNOWN', code: 'ZALO_SEND_ERROR' } };
    }
    if (!outcome.v.msgId) {
      await settle('UNKNOWN', { outcomeCode: 'SENT_WITHOUT_MESSAGE_ID' });
      return { status: 502, result: { delivery: 'UNKNOWN', code: 'SENT_WITHOUT_MESSAGE_ID' } };
    }
    await settle('SENT', { providerMessageId: outcome.v.msgId, outcomeCode: null });
    return { status: 200, result: { delivery: 'SENT', providerMessageId: outcome.v.msgId } };
  }

  // ───────────────────────── maintenance ─────────────────────────
  /** Sau khi khởi động lại: phiên QR đang mở không còn sống → EXPIRED + dọn nick tạm. */
  async recoverOnBoot(): Promise<number> {
    const open = await runSystemQuery(() => prisma.gatewayLoginAttempt.findMany({ where: { status: { in: OPEN_LOGIN } }, select: { id: true } }));
    for (const o of open) await this.finishLogin(o.id, 'EXPIRED', 'SENDER_RESTARTED');
    return open.length;
  }

  /** Xoá bản ghi idempotency cũ hơn retentionDays (tối thiểu 7 ngày). */
  async purgeIdempotency(retentionDays = MIN_RETENTION_DAYS): Promise<number> {
    const days = Math.max(MIN_RETENTION_DAYS, Math.floor(retentionDays));
    const cutoff = new Date(this.now().getTime() - days * 86_400_000);
    const r = await runSystemQuery(() => prisma.gatewayDeliveryAttempt.deleteMany({ where: { createdAt: { lt: cutoff }, state: { in: ['SENT', 'NOT_SENT', 'UNKNOWN'] } } }));
    return r.count;
  }

  async enqueueHealth(accountRef: string, status: string, reason?: string): Promise<void> {
    await runSystemQuery(() => prisma.gatewayHealthOutbox.create({ data: { accountRef, status, reason: reason ?? null, at: this.now() } })).catch(() => undefined);
  }
}
