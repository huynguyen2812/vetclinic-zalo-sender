// SPDX-License-Identifier: AGPL-3.0-or-later
// Phần sửa đổi của ZaloCRM (AGPL-3.0; xem NOTICE) cho sender nội bộ Customer Care Gateway.
/**
 * Khoá tuần tự theo account (login / disconnect / pause / send cùng account chạy nối tiếp,
 * account khác không bị chặn). Phạm vi: một tiến trình sender. Chạy nhiều bản sender cùng
 * lúc KHÔNG được hỗ trợ (phiên zca-js cũng chỉ sống trong một tiến trình); chống gửi trùng
 * giữa tiến trình vẫn do ràng buộc duy nhất trong DB (gateway_delivery_attempts) đảm bảo.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
