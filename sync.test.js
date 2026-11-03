import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingTx, syncAll, normalizeServerUrl } from "./sync.js";

const HOUR = 3_600_000;
const PAIRED = Date.parse("2026-11-01T10:00:00+07:00");
const conn = { url: "https://atmosphere-jb5u.vercel.app", token: "t", pairedAt: PAIRED };
const tx = (id, minutesAfterPairing, extra = {}) => ({
  id, amount: 30999, time: PAIRED + minutesAfterPairing * 60_000, text: "Rp30.999 diterima DANA Bisnis.", note: "", label: "", ...extra,
});

test("pendingTx: hanya yang belum terkirim dan tidak lebih dari 1 jam sebelum pairing, urut terlama dulu", () => {
  const list = [tx("baru", 30), tx("lama", -2 * 60), tx("sudah", 10, { sync: { state: "sent" } }), tx("pas", -30)];
  assert.deepEqual(pendingTx(list, conn).map((t) => t.id), ["pas", "baru"]);
  assert.deepEqual(pendingTx(list, null), []);
});

test("syncAll: hasil MATCHED → status terkirim + label booking terisi otomatis, list asli tidak berubah", async () => {
  const list = [tx("a", 5)];
  const sent = [];
  const out = await syncAll(list, conn, async (payload) => {
    sent.push(payload);
    return { status: 200, data: { success: true, data: { result: "MATCHED", reservationCode: "R5Y2" } } };
  }, PAIRED + HOUR);
  assert.deepEqual(sent, [{ notifId: "a", amount: 30999, time: list[0].time, text: list[0].text }]);
  assert.equal(out.list[0].sync.state, "sent");
  assert.equal(out.list[0].sync.result, "MATCHED");
  assert.equal(out.list[0].label, "Booking R5Y2");
  assert.equal(list[0].sync, undefined);
  assert.equal(out.revoked, false);
});

test("syncAll: label yang sudah diisi pengguna tidak ditimpa", async () => {
  const out = await syncAll([tx("a", 5, { label: "Pak Budi" })], conn, async () => ({
    status: 200, data: { success: true, data: { result: "MATCHED", reservationCode: "R5Y2" } },
  }));
  assert.equal(out.list[0].label, "Pak Budi");
});

test("syncAll: label dari server (Kosinyuk) dipakai apa adanya", async () => {
  const out = await syncAll([tx("a", 5)], conn, async () => ({
    status: 200, data: { success: true, data: { result: "matched", label: "K3 · Budi" } },
  }));
  assert.equal(out.list[0].label, "K3 · Budi");
  assert.equal(out.list[0].sync.label, "K3 · Budi");
});

test("pendingTx: dengan jalur dari pairing, nominal di luar jalur tidak dikirim", () => {
  const kos = { ...conn, band: { min: 500, max: 999 } };
  const list = [tx("kos", 5, { amount: 799873 }), tx("cafe", 6, { amount: 120350 }), tx("pribadi", 7, { amount: 50000 })];
  assert.deepEqual(pendingTx(list, kos).map((t) => t.id), ["kos"]);
  assert.equal(pendingTx(list, conn).length, 3); // web tanpa jalur (Atmosphere lama): semua dikirim
});

test("syncAll: offline → berhenti, sisanya tetap antri untuk dicoba lagi", async () => {
  let calls = 0;
  const out = await syncAll([tx("a", 1), tx("b", 2)], conn, async () => {
    calls += 1;
    throw new Error("Network error");
  });
  assert.equal(calls, 1);
  assert.deepEqual(out.list.map((t) => t.sync?.state), ["queued", undefined]);
  assert.match(out.list[0].sync.error, /Network/);
});

test("syncAll: 401 → koneksi dicabut, tidak ada yang ditandai terkirim", async () => {
  const out = await syncAll([tx("a", 1)], conn, async () => ({ status: 401, data: { success: false, error: { message: "dicabut" } } }));
  assert.equal(out.revoked, true);
  assert.notEqual(out.list[0].sync?.state, "sent");
});

test("syncAll: ditolak server (400) → ditandai gagal supaya tidak dikirim berulang", async () => {
  const out = await syncAll([tx("a", 1)], conn, async () => ({ status: 400, data: { success: false, error: { message: "Waktu notifikasi tidak masuk akal" } } }));
  assert.equal(out.list[0].sync.state, "failed");
  assert.equal(pendingTx(out.list, conn).length, 0);
});

test("normalizeServerUrl: wajib https, buang garis miring & path", () => {
  assert.equal(normalizeServerUrl(" https://atmosphere-jb5u.vercel.app/ "), "https://atmosphere-jb5u.vercel.app");
  assert.equal(normalizeServerUrl("atmosphere-jb5u.vercel.app"), "https://atmosphere-jb5u.vercel.app");
  assert.equal(normalizeServerUrl("https://contoh.id/admin/pengaturan"), "https://contoh.id");
  assert.throws(() => normalizeServerUrl("http://contoh.id"));
  assert.throws(() => normalizeServerUrl("bukan url"));
});

test("mergeSynced: notif baru, edit label, dan hapus selama sinkron tetap terjaga", async () => {
  const { mergeSynced } = await import("./sync.js");
  const a = tx("a", 1), b = tx("b", 2);
  const synced = [{ ...a, sync: { state: "sent", result: "MATCHED", label: "Booking R5Y2" }, label: "Booking R5Y2" }, b];
  const current = [{ ...a, label: "Pak Budi" }, tx("baru", 3)]; // b dihapus, a diberi label, ada notif baru
  const out = mergeSynced(current, synced);
  assert.deepEqual(out.map((t) => t.id), ["a", "baru"]);
  assert.equal(out[0].sync.state, "sent");
  assert.equal(out[0].label, "Pak Budi");
  assert.equal(out[1].sync, undefined);
});

test("notifCopy: kalimat notifikasi mengikuti status kirim", async () => {
  const { notifCopy } = await import("./sync.js");
  const kos = { ...conn, business: "Kos Melati", band: { min: 500, max: 999 } };
  const t = tx("a", 1, { amount: 799873 });
  assert.deepEqual(notifCopy(t, null), { title: "Rp799.873 masuk", text: "DANA · tercatat di HP" });
  assert.equal(notifCopy(t, kos).text, "DANA · mengirim ke Kos Melati…");
  assert.equal(notifCopy({ ...t, amount: 50000 }, kos).text, "DANA · di luar jalur usaha, disimpan di HP saja");
  assert.deepEqual(notifCopy({ ...t, sync: { state: "sent", result: "matched", label: "K3 · Budi" } }, kos), { title: "✅ K3 · Budi lunas", text: "Rp799.873 · Kos Melati" });
  assert.equal(notifCopy({ ...t, sync: { state: "sent", result: "MATCHED", label: "Booking R5Y2" } }, kos).title, "✅ Booking R5Y2 lunas");
  assert.equal(notifCopy({ ...t, sync: { state: "sent", result: "unmatched", label: null } }, kos).text, "Belum cocok dengan tagihan · cek di Kos Melati");
  assert.equal(notifCopy({ ...t, sync: { state: "sent", result: "duplicate", label: null } }, kos).text, "Sudah tercatat di Kos Melati");
});


test("targetConn & pendingTx: banyak usaha, uang dikirim ke pemilik jalurnya", async () => {
  const { targetConn } = await import("./sync.js");
  const kos = { url: "https://kosinyuk.id", token: "a", pairedAt: PAIRED, band: { min: 500, max: 999 } };
  const cafe = { url: "https://atmosphere.cafe", token: "b", pairedAt: PAIRED, band: null };
  const conns = [kos, cafe];
  const list = [tx("k", 5, { amount: 799873 }), tx("c", 6, { amount: 120350 })];
  assert.equal(targetConn(list[0], conns), kos);
  assert.equal(targetConn(list[1], conns), cafe); // web lama tanpa jalur menampung sisanya
  assert.deepEqual(pendingTx(list, kos, conns).map((t) => t.id), ["k"]);
  assert.deepEqual(pendingTx(list, cafe, conns).map((t) => t.id), ["c"]);
  assert.equal(targetConn(list[1], [kos]), null); // hanya Kosinyuk: 120.350 tetap di HP
});

test("syncAll mencatat tujuan kirim; perBusiness mengelompokkan per usaha", async () => {
  const { perBusiness } = await import("./sync.js");
  const kos = { url: "https://kosinyuk.id", business: "Kos Melati", token: "a", pairedAt: PAIRED, band: { min: 500, max: 999 } };
  const out = await syncAll([tx("k", 5, { amount: 799873 }), tx("p", 6, { amount: 50000 })], kos, async () => ({
    status: 200, data: { success: true, data: { result: "matched", label: "K3 · Budi" } },
  }), PAIRED + HOUR, [kos]);
  assert.equal(out.list.find((t) => t.id === "k").sync.to, "https://kosinyuk.id");
  const groups = perBusiness(out.list, [kos], () => true);
  assert.deepEqual(groups.map((g) => [g.name, g.sum, g.count]), [["Kos Melati", 799873, 1], ["Di HP saja", 50000, 1]]);
});

test("parsePairQr: QR Kosinyuk → alamat + kode; QR lain ditolak", async () => {
  const { parsePairQr } = await import("./sync.js");
  assert.deepEqual(parsePairQr("https://kosinyuk.id/setor/pair?c=k7q2-m9xa"), { url: "https://kosinyuk.id", code: "K7Q2M9XA" });
  assert.equal(parsePairQr("00020101021126570011ID.DANA.WWW"), null);
  assert.equal(parsePairQr("http://kosinyuk.id/setor/pair?c=K7Q2M9XA"), null); // bukan https
  assert.equal(parsePairQr("https://kosinyuk.id/"), null);
});

test("bisnis bebas: rentang otomatis, tabrakan ditolak, bisnis tanpa web dicatat di HP", async () => {
  const { freeRange, bandConflict, validBand, targetConn, notifCopy, perBusiness } = await import("./sync.js");
  const kos = { id: "kos", url: "https://kosinyuk.id", business: "Kos Melati", band: { min: 500, max: 999 } };
  assert.deepEqual(freeRange([kos]), { min: 1, max: 499 });
  const bunga = { id: "b", business: "Toko Bunga", band: { min: 200, max: 349 } };
  assert.deepEqual(freeRange([kos, bunga]), { min: 1, max: 199 });
  assert.deepEqual(freeRange([kos, bunga], "b"), { min: 1, max: 499 }); // saat mengedit dirinya sendiri
  assert.equal(freeRange([{ id: "x", band: { min: 1, max: 999 } }]), null);
  assert.equal(bandConflict({ min: 300, max: 400 }, [kos, bunga]), bunga);
  assert.equal(bandConflict({ min: 350, max: 499 }, [kos, bunga]), null);
  assert.equal(validBand({ min: 5, max: 9 }), false);
  const t = tx("f", 1, { amount: 75250 });
  assert.equal(targetConn(t, [kos, bunga]), bunga);
  assert.equal(notifCopy(t, [kos, bunga]).text, "Toko Bunga · tercatat di HP");
  assert.deepEqual(pendingTx([t], bunga, [kos, bunga]), []); // tidak punya web: tidak ada yang dikirim
  assert.deepEqual(perBusiness([t], [kos, bunga], () => true).map((g) => g.name), ["Toko Bunga"]);
});

test("rentang diubah: tagihan lama di rentang lama tetap ke bisnis yang sama selama 45 hari", async () => {
  const { withBand, targetConn } = await import("./sync.js");
  const NOW = 1_800_000_000_000;
  const kos = withBand({ id: "kos", url: "https://kosinyuk.id", band: { min: 500, max: 999 } }, { min: 600, max: 999 }, NOW);
  assert.equal(kos.bandSynced, false);
  const cafe = { id: "c", url: "https://atm.id", band: { min: 100, max: 499 } };
  assert.equal(targetConn(tx("old", 0, { amount: 799512, time: NOW + 1000 }), [kos, cafe]), kos);
  assert.equal(targetConn(tx("late", 0, { amount: 799512, time: NOW + 46 * 86_400_000 }), [kos, cafe]), null);
  assert.equal(targetConn(tx("new", 0, { amount: 799612, time: NOW }), [kos, cafe]), kos);
});

test("fromHistory: riwayat dari web jadi transaksi terkirim yang tidak dobel", async () => {
  const { fromHistory } = await import("./sync.js");
  const { addTx } = await import("./core.js");
  const [h] = fromHistory([{ notifId: "id.dana|5|Rp1.000 diterima", amount: 1000, time: 5, text: "Rp1.000 diterima", result: "matched", label: "K3 · Budi" }, { notifId: 1 }], "https://kosinyuk.id");
  assert.equal(h.sync.state, "sent");
  assert.equal(h.label, "K3 · Budi");
  assert.equal([h].reduce(addTx, [{ ...h, note: "catatan lokal" }]).length, 1);
});
