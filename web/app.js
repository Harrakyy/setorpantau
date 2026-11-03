import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { BarcodeScanner, BarcodeFormat } from "@capacitor-mlkit/barcode-scanning";
import { NotificationsListener } from "capacitor-notifications-listener";
import { parseNotification, addTx, updateTx, deleteTx, totals, filterTx, toCsv, wibDate, toBackup, fromBackup } from "../core.js";
import { pendingTx, syncAll, mergeSynced, normalizeServerUrl, notifCopy, targetConn, perBusiness, parsePairQr, keyOf, withBand, bandConflict, freeRange, validBand, fromHistory } from "../sync.js";

// Plugin lokal (android/.../SetorPlugin.java): notifikasi khusus Setor + cek kesehatan HP
const SetorNative = registerPlugin("Setor");

const isNative = Capacitor.isNativePlatform();
const KEY_TX = "setorpantau.tx";
const KEY_PKGS = "setorpantau.packages";
const KEY_CONNS = "setorpantau.conns"; // [{ url, token, deviceName, business, band, dashboard, pairedAt }] — dibaca juga oleh SetorApp.java
const KEY_CONN_OLD = "setorpantau.conn"; // versi satu usaha, dipindah ke KEY_CONNS
const KEY_EVENTS = "setorpantau.events";
const KEY_OB = "setorpantau.onboarded";
const KEY_BAK = "setorpantau.backup"; // { day, file, at } cadangan otomatis harian terakhir
const DEFAULT_PKGS = ["id.dana"];

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2, .8, .2, 1)";
const rupiah = (n) => "Rp " + n.toLocaleString("id-ID");
const fmtWhen = (ms) =>
  new Date(ms).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " WIB";
const fmtShort = (ms) =>
  new Date(ms).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const monthName = () => new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", month: "long" });
const thisMonth = (ms) => wibDate(ms).slice(0, 7) === wibDate(Date.now()).slice(0, 7);
const nameOf = (c) => c.business || new URL(c.url).host;
const initials = (s) => s.split(/[\s·]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const bandText = (b) => (b ? `${String(b.min).padStart(3, "0")}–${b.max}` : "Semua");

let txs = [];
let packages = DEFAULT_PKGS;
let conns = [];
let events = []; // kotak notifikasi: { id, at, kind: "ok"|"act", who, title, detail }
let reminders = {}; // url usaha → item ringkasan (Protokol Setor §4), hanya di memori
let editingId = null;
let listening = false;
let syncing = false;
let inboxFilter = "all";

// ---------- penyimpanan ----------
async function load() {
  try {
    const get = (key) => Preferences.get({ key }).then((r) => r.value);
    const [rawTx, rawPkgs, rawConns, rawOld, rawEv] = await Promise.all([KEY_TX, KEY_PKGS, KEY_CONNS, KEY_CONN_OLD, KEY_EVENTS].map(get));
    txs = rawTx ? JSON.parse(rawTx) : [];
    packages = rawPkgs ? JSON.parse(rawPkgs) : DEFAULT_PKGS;
    events = rawEv ? JSON.parse(rawEv) : [];
    conns = rawConns ? JSON.parse(rawConns) : rawOld ? [JSON.parse(rawOld)] : [];
    conns = conns.map((c) => ({ ...c, id: keyOf(c) })); // versi lama: kunci = alamat web
    if (!rawConns && rawOld) {
      await saveConns();
      await Preferences.remove({ key: KEY_CONN_OLD });
    }
  } catch {
    txs = [];
    packages = DEFAULT_PKGS;
    toast("Data tersimpan rusak, mulai dari kosong.");
  }
}

const saveTxs = () => Preferences.set({ key: KEY_TX, value: JSON.stringify(txs) });
const saveConns = () => Preferences.set({ key: KEY_CONNS, value: JSON.stringify(conns) });
const saveEvents = () => Preferences.set({ key: KEY_EVENTS, value: JSON.stringify(events.slice(0, 100)) });

function addEvent(ev) {
  events = [{ at: Date.now(), ...ev }, ...events.filter((e) => e.id !== ev.id)].slice(0, 100);
  saveEvents();
}

// Notifikasi Setor untuk satu transaksi; key sama = memperbarui notif lama tanpa bunyi ulang
const notify = (t) => isNative && SetorNative.notify({ key: t.id, ...notifCopy(t, conns) }).catch(() => {});

// ---------- notifikasi masuk ----------
async function onNotification(n) {
  const tx = parseNotification(n, packages);
  if (!tx) {
    // Notif dari DANA yang menyebut uang tapi tidak terbaca: kemungkinan kalimat DANA berubah, jangan diam saja
    const text = `${n?.title ?? ""} ${n?.text ?? ""}`;
    if (packages.includes(n?.package) && /Rp\s?[\d.]+/.test(text) && /masuk|terima/i.test(text)) {
      addEvent({ id: `unk:${n.package}|${n.time}`, kind: "act", who: "Setor", title: "Notif uang masuk tidak terbaca", detail: `"${text.trim().slice(0, 140)}". Cek di aplikasi DANA dan laporkan ke kami supaya Setor diperbarui.` });
      renderInbox();
    }
    return;
  }
  const before = txs.length;
  txs = addTx(txs, tx);
  if (txs.length === before) return; // sudah tercatat (notif dikirim ulang dari cache)
  await saveTxs();
  render();
  toast(`${rupiah(tx.amount)} masuk tercatat`);
  // Notif lama dari cache (app sempat tertutup) sudah dinotifikasi native; jangan bunyi lagi
  if (Date.now() - tx.time < 2 * 60_000) notify(tx);
  syncNow();
}

// ---------- HTTP ----------
// Di APK pakai HTTP native (tanpa CORS); di pratinjau browser pakai fetch biasa
async function postJson(url, body, token) {
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (isNative) {
    const r = await CapacitorHttp.post({ url, headers, data: body });
    let data = r.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
    return { status: r.status, data };
  }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}

const sendTo = (c) => (payload) => postJson(`${c.url}/api/payments/qris/notification`, payload, c.token);

// Hasil kirim yang berubah dicatat ke kotak notifikasi
function recordResult(t) {
  const c = conns.find((x) => x.url === t.sync?.to);
  const who = c ? nameOf(c) : "Web usaha";
  const r = t.sync?.result ?? "";
  if (t.sync?.state === "failed") return addEvent({ id: t.id, kind: "act", who, title: `${rupiah(t.amount)} gagal dikirim`, detail: t.sync.error ?? "Ditolak web usaha", tx: t.id });
  if (t.sync?.state !== "sent") return;
  if (/^matched$/i.test(r)) return addEvent({ id: t.id, kind: "ok", who, title: `${t.sync.label ?? "Tagihan"} lunas`, detail: `${rupiah(t.amount)} cocok otomatis`, tx: t.id });
  if (r === "duplicate" || r === "ALREADY_PAID") return addEvent({ id: t.id, kind: "ok", who, title: `${rupiah(t.amount)} sudah tercatat`, detail: t.sync.label ?? "Dikirim ulang, tidak dobel", tx: t.id });
  addEvent({ id: t.id, kind: "act", who, title: `${rupiah(t.amount)} belum cocok`, detail: `Tidak ada tagihan dengan nominal ini. Cek di ${who}.`, tx: t.id });
}

async function removeConn(c, why) {
  conns = conns.filter((x) => keyOf(x) !== keyOf(c));
  delete reminders[c.url];
  await saveConns();
  if (why) addEvent({ id: `revoked:${c.url}:${Date.now()}`, kind: "act", who: nameOf(c), title: "Akses HP ini dicabut", detail: why });
}

async function syncNow() {
  if (syncing || !conns.some((c) => pendingTx(txs, c, conns).length)) return;
  syncing = true;
  try {
    for (const c of [...conns]) {
      if (!pendingTx(txs, c, conns).length) continue;
      const { list, revoked } = await syncAll(txs, c, sendTo(c), Date.now(), conns);
      const before = new Map(txs.map((t) => [t.id, t.sync]));
      txs = mergeSynced(txs, list);
      for (const t of txs) {
        if (!t.sync || t.sync === before.get(t.id)) continue;
        notify(t);
        recordResult(t);
      }
      if (revoked) {
        await removeConn(c, "Admin mencabut akses. Hubungkan ulang dari tab Usaha.");
        toast(`Akses ke ${nameOf(c)} dicabut. Hubungkan ulang dari tab Usaha.`);
      }
    }
    await saveTxs();
    render();
  } finally {
    syncing = false;
  }
}

// Protokol Setor §4: tagihan belum lunas per usaha (Kosinyuk). Web tanpa endpoint ini (Atmosphere lama) dilewati.
let lastReminderCount = -1;
async function refreshSummaries() {
  await syncBands();
  for (const c of conns.filter((x) => x.url)) {
    try {
      const res = await postJson(`${c.url}/api/devices/summary`, {}, c.token);
      if (res.status === 401) {
        await removeConn(c, "Admin mencabut akses. Hubungkan ulang dari tab Usaha.");
        continue;
      }
      if (!res.data?.success) continue;
      reminders[c.url] = res.data.data.items ?? [];
      if (res.data.data.dashboard && res.data.data.dashboard !== c.dashboard) {
        c.dashboard = res.data.data.dashboard;
        await saveConns();
      }
    } catch {} // offline: pakai ringkasan terakhir
  }
  const count = Object.values(reminders).reduce((s, l) => s + l.length, 0);
  // Satu notif ringkas saat jumlah yang belum bayar berubah, tanpa bunyi berulang
  if (isNative && count > 0 && count !== lastReminderCount && lastReminderCount !== -1) {
    SetorNative.notify({ key: "pengingat", title: `${count} tagihan belum lunas`, text: "Ketuk untuk kirim pengingat WA" }).catch(() => {});
  }
  lastReminderCount = count;
  render();
}

// ---------- bisnis: tambah/ubah + hubungkan ke web ----------
let editingBiz = null; // kunci bisnis yang diubah; null = bisnis baru

const sheetBand = () => ({ min: Number($("bandMin").value), max: Number($("bandMax").value) });
const pad3 = (n) => String(n).padStart(3, "0");

function bandHint() {
  const b = sheetBand();
  const hint = $("bandHint");
  if (!validBand(b)) return (hint.textContent = "Isi angka 001–999, minimal 10 angka (misalnya 200 sampai 349).");
  const clash = bandConflict(b, conns, editingBiz);
  if (clash) return (hint.textContent = `⚠️ Bertabrakan dengan ${nameOf(clash)} (${bandText(clash.band)}).`);
  const width = b.max - b.min + 1;
  hint.textContent = `Muat ±${width} pembayaran menunggu sekaligus. Kode unik bisa sampai Rp${1000 - width}.`;
}

function openPair(c, prefill) {
  editingBiz = c ? keyOf(c) : null;
  const band = c?.band ?? freeRange(conns) ?? { min: 1, max: 999 };
  $("pairTitle").textContent = c ? `Ubah ${nameOf(c)}` : "Tambah bisnis";
  $("bizName").value = c?.business ?? "";
  $("bandMin").value = pad3(band.min);
  $("bandMax").value = band.max;
  $("connFields").classList.toggle("hidden", !!c?.url);
  if (prefill) {
    $("connUrl").value = prefill.url;
    $("connCode").value = prefill.code;
  }
  bandHint();
  $("pairSheet").showModal();
}

/** Validasi isi lembar; null kalau belum benar (pesan sudah ditampilkan). */
function readSheet() {
  const band = sheetBand();
  if (!validBand(band)) return toast("Rentang tidak valid: 001–999, minimal 10 angka."), null;
  const clash = bandConflict(band, conns, editingBiz);
  if (clash) return toast(`Rentang bertabrakan dengan ${nameOf(clash)}.`), null;
  return { band, name: $("bizName").value.trim().slice(0, 40) };
}

async function saveBiz() {
  const f = readSheet();
  if (!f) return;
  const old = conns.find((c) => keyOf(c) === editingBiz);
  if (!old && !f.name) return toast("Isi nama bisnis.");
  const next = old ? { ...withBand(old, f.band), business: f.name || old.business } : { id: `biz-${Date.now()}`, business: f.name, band: f.band };
  conns = old ? conns.map((c) => (keyOf(c) === editingBiz ? next : c)) : [...conns, next];
  await saveConns();
  $("pairSheet").close();
  toast(old ? "Bisnis diperbarui" : `${f.name} ditambahkan`);
  render();
  syncBands();
}

async function scanQr() {
  if (!isNative) return toast("Scan QR hanya di aplikasi Android. Ketik alamat dan kode di bawah.");
  try {
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      return toast("Menyiapkan pemindai QR dari Google Play… coba lagi sebentar.");
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const found = barcodes.map((b) => parsePairQr(b.rawValue)).find(Boolean);
    if (!found) return barcodes.length && toast("Ini bukan QR pairing Setor. Buka Pengaturan → Hubungkan HP di web usaha.");
    $("connUrl").value = found.url;
    $("connCode").value = found.code;
    pair();
  } catch (err) {
    if (!/cancel/i.test(String(err?.message))) toast("Pemindai QR tidak bisa dibuka. Ketik alamat dan kode saja.");
  }
}

async function pair() {
  const f = readSheet();
  if (!f) return;
  let url;
  try {
    url = normalizeServerUrl($("connUrl").value);
  } catch {
    return toast("Alamat web tidak valid. Contoh: https://kosinyuk.id");
  }
  // Buang tanda hubung/spasi: Kosinyuk menampilkan "K7Q2-M9XA", Atmosphere menerima tepat 8 karakter
  const code = $("connCode").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 8) return toast("Isi kode pairing 8 karakter dari web usaha.");
  $("connPair").disabled = true;
  try {
    // Protokol Setor §1: rentang pilihan pemilik ikut dikirim; web baru memakainya, web lama membalas rentangnya sendiri
    const res = await postJson(`${url}/api/devices/pair`, { code, name: $("connName").value.trim() || "HP Setor", band: f.band });
    if (!res.data?.success) return toast(res.data?.error?.message || res.data?.message || "Gagal menghubungkan. Cek alamat web.");
    const d = res.data.data;
    const old = conns.find((c) => keyOf(c) === editingBiz) ?? {};
    const band = d.band ?? null;
    const c = {
      ...old,
      id: old.id ?? `biz-${Date.now()}`,
      url,
      token: d.token,
      deviceName: d.device.name,
      business: f.name || d.business?.name || null,
      band,
      webBand: band,
      bandSynced: true,
      dashboard: d.dashboard ?? null,
      pairedAt: Date.now(),
    };
    conns = [...conns.filter((x) => keyOf(x) !== keyOf(c) && x.url !== url), c];
    await saveConns();
    $("connCode").value = "";
    $("pairSheet").close();
    const fixed = band && (band.min !== f.band.min || band.max !== f.band.max);
    const clash = band && bandConflict(band, conns, keyOf(c));
    addEvent({
      id: `pair:${url}:${c.pairedAt}`,
      kind: clash ? "act" : "ok",
      who: nameOf(c),
      title: "Terhubung",
      detail: fixed ? `Web ini memakai jalur tetap ${bandText(band)}${clash ? `, bertabrakan dengan ${nameOf(clash)}: ubah rentang ${nameOf(clash)}` : ""}.` : `Jalur ${bandText(band)} dipakai ${nameOf(c)}.`,
    });
    toast(`Terhubung ke ${nameOf(c)}`);
    setTab("usaha");
    render();
    pullHistory(c);
    syncNow();
    refreshSummaries();
  } catch {
    toast("Web tidak bisa dihubungi. Cek internet dan alamat web.");
  } finally {
    $("connPair").disabled = false;
  }
}

/** Protokol Setor §5: kirim rentang yang diubah pemilik ke web. Web lama (404) tetap di jalurnya: Setor ikut. */
async function syncBands() {
  for (const c of conns.filter((x) => x.url && x.bandSynced === false)) {
    try {
      const res = await postJson(`${c.url}/api/devices/band`, { band: c.band }, c.token);
      if (res.status === 401) continue; // ditangani ringkasan/sinkron
      const ok = res.data?.success;
      const band = ok ? res.data.data.band : c.webBand;
      conns = conns.map((x) => (keyOf(x) === keyOf(c) ? { ...(band ? withBand(x, band) : x), bandSynced: true, webBand: band } : x));
      if (!ok && res.status === 404) addEvent({ id: `band:${keyOf(c)}:${Date.now()}`, kind: "act", who: nameOf(c), title: "Rentang tidak bisa diubah", detail: `Web ini memakai jalur tetap ${bandText(band)}.` });
      await saveConns();
    } catch {} // offline: dicoba lagi berikutnya
  }
  render();
}

/** Protokol Setor §6: setelah pasang ulang / HP baru, ambil lagi pembayaran yang dulu dikirim ke web ini. */
async function pullHistory(c) {
  try {
    const res = await postJson(`${c.url}/api/devices/history`, {}, c.token);
    if (!res.data?.success) return;
    const before = txs.length;
    txs = fromHistory(res.data.data.items ?? [], c.url).reduce(addTx, txs);
    if (txs.length === before) return;
    await saveTxs();
    render();
    toast(`${txs.length - before} transaksi lama diambil dari ${nameOf(c)}`);
  } catch {}
}

// ---------- status kirim ----------
const SYNC_CHIP = {
  MATCHED: ["Lunas", "ok"],
  ALREADY_PAID: ["Sudah lunas", "muted"],
  LATE_SLOT_TAKEN: ["Telat · refund", "warn"],
  NO_MATCH: ["Tak ada pesanan", "warn"],
  matched: ["Lunas", "ok"],
  unmatched: ["Tak ada tagihan", "warn"],
  duplicate: ["Sudah tercatat", "muted"],
};
function syncChip(t) {
  if (t.sync?.state === "sent") return SYNC_CHIP[t.sync.result] ?? ["Terkirim", "muted"];
  if (t.sync?.state === "failed") return ["Gagal kirim", "warn"];
  const c = targetConn(t, conns);
  if (c && pendingTx([t], c, conns).length) return ["Antri", "warn"];
  return null;
}

async function startListener() {
  if (!isNative) return;
  await NotificationsListener.removeAllListeners();
  await NotificationsListener.addListener("notificationReceivedEvent", onNotification);
  // Cache: notif yang datang saat aplikasi tertutup disimpan plugin, lalu dikirim ulang lewat restore
  await NotificationsListener.startListening({ cacheNotifications: true, packagesWhitelist: packages });
  await NotificationsListener.restoreCachedNotifications();
}

// ---------- kesehatan HP ----------
// Panduan per merek: HP yang paling sering mematikan aplikasi di latar belakang
const BRAND_TIPS = {
  xiaomi: "Xiaomi/Redmi/POCO: Setelan → Aplikasi → Setor → Mulai otomatis aktif, lalu Penghemat baterai → Tanpa batasan.",
  oppo: "Oppo/Realme/OnePlus: Setelan → Baterai → Setor → izinkan aktivitas latar belakang dan mulai otomatis.",
  vivo: "Vivo: Setelan → Baterai → Konsumsi daya latar belakang tinggi → aktifkan Setor.",
  samsung: "Samsung: Setelan → Baterai → Batas penggunaan latar belakang → pastikan Setor tidak masuk daftar aplikasi tidur.",
};
for (const [alias, key] of [["redmi", "xiaomi"], ["poco", "xiaomi"], ["realme", "oppo"], ["oneplus", "oppo"]]) BRAND_TIPS[alias] = BRAND_TIPS[key];

let health = { notify: true, battery: true, brand: "" };
const brandTip = () => Object.entries(BRAND_TIPS).find(([b]) => health.brand.includes(b))?.[1];

function healthRow(id, ok, text) {
  const row = $(id);
  row.querySelector(".dot").className = `dot ${ok ? "ok" : "warn"}`;
  row.querySelector(".dot").textContent = ok ? "✓" : "!";
  row.querySelector(".ht").textContent = text;
  row.querySelector("button")?.classList.toggle("hidden", ok);
}

async function renderHealth() {
  if (!isNative) {
    for (const id of ["hAccess", "hPost", "hBattery"]) healthRow(id, true, "Hanya diperiksa di aplikasi Android");
    return;
  }
  try { health = await SetorNative.health(); } catch {}
  healthRow("hAccess", listening, listening ? "Akses notifikasi aktif" : "Akses notifikasi belum aktif");
  healthRow("hPost", health.notify, health.notify ? "Setor boleh menampilkan notifikasi" : "Notifikasi Setor dimatikan");
  healthRow("hBattery", health.battery, health.battery ? "Baterai tidak dibatasi" : "Penghemat baterai masih membatasi Setor");
  const tip = brandTip();
  $("hBrand").textContent = tip ?? "";
  $("hBrand").classList.toggle("hidden", !tip);
}

async function refreshPermission() {
  if (!isNative) return;
  try {
    listening = (await NotificationsListener.isListening()).value;
  } catch {
    listening = false;
  }
  renderPermission();
  renderHealth();
}

// ---------- tampilan ----------
// Angka total "berjalan" dari nilai lama ke nilai baru (0 saat pertama dibuka); pembaca layar langsung dapat nilai akhir
function countTo(node, value) {
  const from = Number(node.dataset.v ?? 0);
  node.dataset.v = value;
  node.setAttribute("aria-label", rupiah(value));
  cancelAnimationFrame(node._raf);
  if (reduceMotion || from === value) {
    node.textContent = rupiah(value);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 700);
    node.textContent = rupiah(Math.round(from + (value - from) * (1 - (1 - p) ** 3)));
    if (p < 1) node._raf = requestAnimationFrame(step);
  };
  node._raf = requestAnimationFrame(step);
}

// Baris baru masuk dari atas & berpendar; saat pertama dibuka semua baris naik berurutan; chip status yang berubah "pop"
const seen = new Set();
const lastChip = new Map();
let firstPaint = true;

function txRow(t, i = 0) {
  const btn = el("button", "tx");
  btn.type = "button";
  btn.dataset.id = t.id;
  btn.innerHTML = `<span class="av"></span><span class="mid"><span class="label"></span><span class="when"></span></span><span class="right"><span class="amt"></span></span>`;
  btn.querySelector(".av").textContent = t.label ? t.label.split(/[\s·]+/)[0].slice(0, 3) : "Rp";
  btn.querySelector(".label").textContent = t.label || "Uang masuk";
  btn.querySelector(".when").textContent = `${fmtShort(t.time)} · DANA${t.note ? " · " + t.note : ""}`;
  btn.querySelector(".amt").textContent = rupiah(t.amount);
  const sc = syncChip(t);
  if (sc) {
    const chip = el("span", `chip ${sc[1]}`, sc[0]);
    if (!firstPaint && lastChip.has(t.id) && lastChip.get(t.id) !== sc[0]) chip.classList.add("pop");
    btn.querySelector(".right").append(chip);
  }
  if (firstPaint) {
    btn.classList.add("enter");
    btn.style.animationDelay = `${Math.min(i, 8) * 35}ms`;
  } else if (!seen.has(t.id)) btn.classList.add("fresh");
  btn.setAttribute("aria-label", `${rupiah(t.amount)}, ${fmtWhen(t.time)}${t.label ? ", " + t.label : ""}${t.note ? ", " + t.note : ""}`);
  btn.addEventListener("click", () => openDetail(t.id));
  return btn;
}

function fillList(node, list, emptyText) {
  node.replaceChildren(...(list.length ? list.map((t, i) => txRow(t, i)) : [el("div", "empty", emptyText)]));
}

// Tautan keluar (dashboard, WA): di APK dibuka Capacitor ke browser/aplikasi lain
function linkBtn(text, href, className = "btn") {
  const a = el("a", className, text);
  a.href = href;
  a.rel = "noopener";
  if (!isNative) a.target = "_blank";
  return a;
}

const currentFilter = () => ({ q: $("q").value, from: $("from").value, to: $("to").value });
const reminderItems = () => conns.flatMap((c) => (reminders[c.url] ?? []).map((it) => ({ ...it, who: nameOf(c) })));

function render() {
  const t = totals(txs);
  countTo($("todaySum"), t.today.sum);
  $("todayCount").textContent = `${t.today.count} transaksi`;
  countTo($("monthSum"), t.month.sum);
  $("monthLabel").textContent = `Uang masuk ${monthName()}`;
  $("monthCount").textContent = `${t.month.count} transaksi`;
  fillList($("recentList"), txs.slice(0, 5), "Belum ada pembayaran masuk tercatat.");

  const filtered = filterTx(txs, currentFilter());
  fillList($("txList"), filtered, txs.length ? "Tidak ada transaksi yang cocok." : "Belum ada pembayaran masuk tercatat.");
  $("filterCount").textContent = `${filtered.length} transaksi`;
  countTo($("filterSum"), filtered.reduce((s, x) => s + x.amount, 0));

  const groups = perBusiness(txs, conns, thisMonth);
  renderHomeUsaha(groups);
  renderReminder();
  renderUsaha(groups);
  renderSummary(groups);
  renderInbox();

  for (const x of txs) {
    seen.add(x.id);
    const sc = syncChip(x);
    if (sc) lastChip.set(x.id, sc[0]);
  }
  firstPaint = false;
}

function renderHomeUsaha(groups) {
  const rows = conns.map((c) => {
    const g = groups.find((x) => x.key === keyOf(c));
    const b = el("button", "glass");
    b.type = "button";
    b.innerHTML = `<span class="gi"></span><span class="gt"><b></b><span></span></span>`;
    b.querySelector(".gi").textContent = initials(nameOf(c));
    b.querySelector("b").textContent = nameOf(c);
    b.querySelector(".gt span").textContent = `Jalur ${bandText(c.band)} · ${g ? rupiah(g.sum) : "Rp 0"} bulan ini`;
    b.addEventListener("click", () => setTab("usaha"));
    return b;
  });
  if (!conns.length) {
    const b = el("button", "glass");
    b.type = "button";
    b.innerHTML = `<span class="gi">+</span><span class="gt"><b>Belum ada bisnis</b><span>Ketuk untuk menambah bisnis & rentang nominalnya</span></span>`;
    b.addEventListener("click", () => openPair());
    rows.push(b);
  }
  $("homeUsaha").replaceChildren(...rows);
}

function renderReminder() {
  const items = reminderItems();
  const actEvents = events.filter((e) => e.kind === "act" && !e.read).length;
  const badge = items.length + actEvents;
  $("inboxBadge").textContent = badge > 9 ? "9+" : String(badge);
  $("inboxBadge").classList.toggle("hidden", !badge);
  $("homeReminder").classList.toggle("hidden", !items.length);
  if (!items.length) return;
  $("homeReminder").innerHTML = `<span class="dot warn">!</span><span style="flex:1"><b></b><span></span></span><span aria-hidden="true">›</span>`;
  $("homeReminder").querySelector("b").textContent = `${items.length} tagihan belum lunas`;
  $("homeReminder").querySelector("span span").textContent = "Kirim pengingat lewat WA sekali ketuk";
}

function renderUsaha(groups) {
  const button = (text, cls, fn) => {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  };
  const cards = conns.map((c) => {
    const g = groups.find((x) => x.key === keyOf(c));
    const queued = pendingTx(txs, c, conns).length;
    const failed = txs.filter((t) => t.sync?.state === "failed" && targetConn(t, conns) === c).length;
    const card = el("div", "ucard");
    card.innerHTML = `<div class="uhead"><span class="ui"></span><span class="un"><b></b><span></span></span></div>
      <div class="ustats"><div><span>Bulan ini</span><b class="s1"></b></div><div><span>Transaksi</span><b class="s2"></b></div><div><span>${c.url ? "Antri" : "Web"}</span><b class="s3"></b></div></div>
      <div class="row"></div>`;
    card.querySelector(".ui").textContent = initials(nameOf(c));
    card.querySelector(".un b").textContent = nameOf(c);
    card.querySelector(".un span").textContent = c.url
      ? `${new URL(c.url).host} · jalur ${bandText(c.band)}${c.bandSynced === false ? " (menunggu dikirim)" : ""} · "${c.deviceName}"`
      : `Jalur ${bandText(c.band)} · dicatat di HP saja`;
    card.querySelector(".s1").textContent = rupiah(g?.sum ?? 0);
    card.querySelector(".s2").textContent = String(g?.count ?? 0);
    card.querySelector(".s3").textContent = c.url ? String(queued + failed) : "—";
    const row = card.querySelector(".row");
    if (c.url) row.append(linkBtn("Buka dashboard", c.dashboard || c.url, "btn primary"));
    else row.append(button("Hubungkan ke web", "btn primary", () => openPair(c)));
    row.append(button("Ubah rentang", "btn", () => openPair(c)));
    if (failed) {
      row.append(button(`Kirim ulang ${failed} yang gagal`, "btn", async () => {
        txs = txs.map((t) => (t.sync?.state === "failed" && targetConn(t, conns) === c ? { ...t, sync: undefined } : t));
        await syncNow();
      }));
    }
    row.append(button(c.url ? "Putuskan" : "Hapus", "btn danger", async () => {
      if (!confirm(c.url ? `Putuskan HP ini dari ${nameOf(c)}? Pembayaran tidak lagi dikirim ke sana.` : `Hapus ${nameOf(c)}? Transaksinya tetap tersimpan.`)) return;
      await removeConn(c);
      render();
    }));
    return card;
  });
  if (!conns.length) {
    const empty = el("div", "card");
    empty.innerHTML = `<h3>Belum ada bisnis</h3><p>Tambah bisnismu (nama bebas, misalnya "Toko Bunga") dan rentang 3 digit terakhirnya. Punya web seperti Kosinyuk? Sekalian scan QR-nya.</p>`;
    empty.append(button("Tambah bisnis", "btn primary", () => openPair()));
    cards.push(empty);
  }
  $("usahaList").replaceChildren(...cards);

  const jalur = [...conns].sort((a, b) => (a.band?.min ?? 1e9) - (b.band?.min ?? 1e9)).map((c) => {
    const r = el("div", "jrow");
    r.append(el("b", null, bandText(c.band)), el("span", null, nameOf(c)));
    return r;
  });
  const gap = freeRange(conns);
  const rest = el("div", "jrow");
  rest.append(el("b", null, gap ? "Sisanya" : "—"), el("span", null, gap ? `Disimpan di HP saja (mis. ${bandText(gap)})` : "Semua angka sudah punya bisnis"));
  $("jalurList").replaceChildren(...jalur, rest);
}

function renderSummary(groups) {
  $("sumTitle").textContent = `Ringkasan ${monthName()}`;
  const month = txs.filter((t) => thisMonth(t.time));
  countTo($("sumTotal"), month.reduce((s, t) => s + t.amount, 0));
  const res = (t) => (t.sync?.state === "sent" ? t.sync.result ?? "" : "");
  $("sumMatched").textContent = String(month.filter((t) => /^matched$/i.test(res(t))).length);
  $("sumUnmatched").textContent = String(month.filter((t) => /^(unmatched|NO_MATCH|LATE_SLOT_TAKEN)$/.test(res(t)) || t.sync?.state === "failed").length);
  $("sumLocal").textContent = String(month.filter((t) => !targetConn(t, conns)).length);

  // Gelembung: luas sebanding total uang masuk per usaha
  const max = Math.max(1, ...groups.map((g) => g.sum));
  const bubbles = groups.map((g) => {
    const size = Math.round(96 + 104 * Math.sqrt(g.sum / max));
    const b = el("div", `bubble${g.key === "local" ? " local" : ""}`);
    b.style.width = b.style.height = `${size}px`;
    b.append(el("b", null, rupiah(g.sum)), el("span", null, `${g.name} · ${g.count}`));
    b.setAttribute("aria-label", `${g.name}: ${rupiah(g.sum)}, ${g.count} transaksi`);
    return b;
  });
  $("bubbles").replaceChildren(...(bubbles.length ? bubbles : [el("p", "hero-label", "Belum ada uang masuk bulan ini.")]));
}

function renderInbox() {
  for (const b of document.querySelectorAll(".chipbtn")) b.setAttribute("aria-selected", String(b.dataset.f === inboxFilter));
  const rem = inboxFilter === "ok" ? [] : reminderItems().map((it) => {
    const ev = evCard({ kind: "act", who: it.who, title: it.title, detail: it.detail });
    if (it.action?.url && /^https:\/\//.test(it.action.url)) ev.querySelector(".eb").append(linkBtn(it.action.text === "WA" ? "Kirim pengingat WA" : it.action.text, it.action.url, "btn primary"));
    return ev;
  });
  const log = events.filter((e) => inboxFilter === "all" || e.kind === inboxFilter).map(evCard);
  const all = [...rem, ...log];
  $("inboxList").replaceChildren(...(all.length ? all : [el("div", "empty", "Belum ada notifikasi.")]));
}

function evCard(e) {
  const card = el("div", `ev${e.kind === "act" ? " act" : ""}`);
  card.innerHTML = `<span class="ei"></span><div class="eb"><div class="em"><span></span><span></span></div><div class="et"></div><div class="ed"></div></div>`;
  card.querySelector(".ei").textContent = e.kind === "ok" ? "✓" : initials(e.who ?? "!");
  const [who, when] = card.querySelectorAll(".em span");
  who.textContent = e.who ?? "Setor";
  when.textContent = e.at ? fmtShort(e.at) : "Belum lunas";
  card.querySelector(".et").textContent = e.title;
  card.querySelector(".ed").textContent = e.detail ?? "";
  if (e.tx && txs.some((t) => t.id === e.tx)) {
    const open = el("button", "btn", "Lihat transaksi");
    open.type = "button";
    open.addEventListener("click", () => openDetail(e.tx));
    card.querySelector(".eb").append(open);
  }
  return card;
}

function renderPermission() {
  const status = $("permStatus");
  const warn = $("permWarn");
  if (!isNative) {
    status.className = "notice warn";
    status.textContent = "Mode pratinjau browser: izin notifikasi hanya ada di aplikasi Android.";
    $("grant").disabled = true;
    return;
  }
  status.className = listening ? "notice ok" : "notice warn";
  status.textContent = listening ? "Aktif — notifikasi DANA sedang dipantau." : "Belum aktif — Setor belum bisa membaca notifikasi.";
  warn.classList.toggle("hidden", listening);
  if (!listening) {
    warn.innerHTML = "<b>Akses Notifikasi belum aktif</b>Pembayaran DANA belum bisa dicatat sampai izin diaktifkan.";
    const go = el("button", "btn primary", "Aktifkan sekarang");
    go.type = "button";
    go.addEventListener("click", requestPermission);
    warn.append(go);
  }
}

const VIEWS = ["home", "tx", "sum", "usaha", "settings", "inbox"];
function setTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const v of VIEWS) $(`view-${v}`).classList.toggle("hidden", v !== name);
  if (!reduceMotion) $(`view-${name}`).animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: EASE });
  if (name === "inbox") {
    events = events.map((e) => (e.kind === "act" ? { ...e, read: true } : e));
    saveEvents();
    renderReminder();
  } else {
    try { localStorage.setItem("setorpantau.tab", name); } catch {}
  }
}

// ---------- detail ----------
function closeSheet() {
  const d = $("detail");
  if (reduceMotion || !d.open) return d.close();
  d.animate([{ transform: "none" }, { transform: "translateY(100%)" }], { duration: 220, easing: "ease-in" }).finished.then(() => d.close());
}

function openDetail(id) {
  const t = txs.find((x) => x.id === id);
  if (!t) return;
  editingId = id;
  $("detailAmount").textContent = rupiah(t.amount);
  $("detailTime").textContent = fmtWhen(t.time);
  $("detailRaw").textContent = `${t.title ? t.title + " — " : ""}${t.text}`;
  const sc = syncChip(t);
  $("detailSync").classList.toggle("hidden", !sc);
  if (sc) $("detailSync").textContent = `Web: ${sc[0]}${t.sync?.label ? " · " + t.sync.label : ""}${t.sync?.error ? " · " + t.sync.error : ""}`;
  // Nominal di luar jalur tidak dikirim otomatis; pemilik bisa meneruskannya sendiri (mis. bayar bulat tanpa kode unik)
  const fwd = t.sync?.state !== "sent" && !targetConn(t, conns)?.url ? conns.filter((c) => c.url) : [];
  $("detailForward").replaceChildren(...fwd.map((c) => {
    const b = el("button", "btn primary", `Teruskan ke ${nameOf(c)}`);
    b.type = "button";
    b.addEventListener("click", () => forward(t.id, c));
    return b;
  }));
  $("detailForward").classList.toggle("hidden", !fwd.length);
  $("detailLabel").value = t.label;
  $("detailNote").value = t.note;
  $("detail").showModal();
}

async function forward(id, c) {
  const t = txs.find((x) => x.id === id);
  if (!t) return;
  const open = { ...c, band: null, pairedAt: 0 };
  const { list } = await syncAll([t], open, sendTo(c), Date.now(), [open]);
  txs = mergeSynced(txs, list);
  await saveTxs();
  const sent = txs.find((x) => x.id === id);
  notify(sent);
  recordResult(sent);
  closeSheet();
  render();
  toast(sent?.sync?.state === "sent" ? `Diteruskan ke ${nameOf(c)}` : "Belum terkirim, coba lagi saat online");
}

$("detailSave").addEventListener("click", async () => {
  txs = updateTx(txs, editingId, { label: $("detailLabel").value, note: $("detailNote").value });
  await saveTxs();
  closeSheet();
  render();
  toast("Catatan disimpan");
});

$("detailDelete").addEventListener("click", async () => {
  if (!confirm("Hapus catatan transaksi ini? Uang di DANA tidak terpengaruh.")) return;
  txs = deleteTx(txs, editingId);
  await saveTxs();
  closeSheet();
  render();
  toast("Transaksi dihapus dari catatan");
});

// ---------- ekspor ----------
async function exportCsv(list) {
  if (!list.length) return toast("Belum ada transaksi untuk diekspor.");
  const name = `Setor-${wibDate(Date.now())}.csv`;
  const csv = toCsv(list);
  try {
    await saveFile(name, csv, "text/csv");
  } catch (err) {
    if (!/cancel/i.test(String(err?.message))) toast("Gagal mengekspor CSV.");
  }
}

// ---------- cadangan (pasang ulang / pindah HP) ----------
async function saveFile(name, data, type) {
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: name, files: [uri] });
  } else {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([data], { type })), download: name });
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

// Cadangan otomatis harian di Documents/Setor (di luar data app, jadi selamat saat uninstall).
// Ditulis sekali per hari saat app dibuka = kondisi sampai kemarin; file yang sama ditimpa, jadi hanya satu yang tersimpan.
const BAK_DIR = "Setor";
const readBak = async () => JSON.parse((await Preferences.get({ key: KEY_BAK })).value ?? "null");

async function autoBackup() {
  if (!isNative || !txs.length) return;
  const day = wibDate(Date.now());
  const bak = await readBak();
  if (bak?.day === day) return;
  const write = (file) => Filesystem.writeFile({ path: `${BAK_DIR}/${file}`, data: toBackup(txs, packages), directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
  let file = bak?.file ?? "Setor-cadangan.json";
  try {
    await Filesystem.requestPermissions().catch(() => {}); // hanya diminta di Android 10 ke bawah
    await write(file);
  } catch {
    // File dari pemasangan sebelumnya bukan milik app ini lagi (Android 11+): tulis ke nama baru
    file = `Setor-cadangan-${Date.now().toString(36)}.json`;
    try { await write(file); } catch { return renderBackupInfo(null); }
  }
  const next = { day, file, at: Date.now(), count: txs.length };
  await Preferences.set({ key: KEY_BAK, value: JSON.stringify(next) });
  renderBackupInfo(next);
}

function renderBackupInfo(bak) {
  $("autoBakInfo").className = `notice ${bak ? "ok" : "warn"}`;
  $("autoBakInfo").textContent = bak
    ? `Cadangan otomatis terakhir: ${fmtWhen(bak.at)} · ${bak.count} transaksi · Documents/${BAK_DIR}/${bak.file}`
    : isNative ? "Cadangan otomatis belum ada (dibuat saat ada transaksi)." : "Cadangan otomatis hanya di aplikasi Android.";
}

async function restoreData(text) {
  let data;
  try {
    data = fromBackup(text);
  } catch (err) {
    return toast(err.message?.startsWith("Bukan") ? err.message : "File cadangan rusak.");
  }
  const before = txs.length;
  txs = data.txs.reduce(addTx, txs);
  if (data.packages.length) {
    packages = [...new Set([...packages, ...data.packages])];
    await Preferences.set({ key: KEY_PKGS, value: JSON.stringify(packages) });
    $("packages").value = packages.join(", ");
    if (isNative) await NotificationsListener.replacePackagesWhitelist({ packagesWhitelist: packages }).catch(() => {});
  }
  await saveTxs();
  render();
  toast(`${txs.length - before} transaksi dipulihkan`);
}

$("backupLast").addEventListener("click", async () => {
  const bak = await readBak();
  if (isNative && bak) {
    try {
      const r = await Filesystem.readFile({ path: `${BAK_DIR}/${bak.file}`, directory: Directory.Documents, encoding: Encoding.UTF8 });
      return restoreData(r.data);
    } catch {} // jatuh ke pemilih file
  }
  // Setelah pasang ulang, Android hanya mengizinkan membuka file lama lewat pemilih file
  toast(`Pilih file Setor-cadangan… di folder Documents/${BAK_DIR}`);
  $("backupFile").click();
});

$("backupSave").addEventListener("click", async () => {
  if (!txs.length) return toast("Belum ada transaksi untuk dicadangkan.");
  try {
    await saveFile(`Setor-cadangan-${wibDate(Date.now())}.json`, toBackup(txs, packages), "application/json");
  } catch (err) {
    if (!/cancel/i.test(String(err?.message))) toast("Gagal menyimpan cadangan.");
  }
});

$("backupFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) restoreData(await file.text());
});

// ---------- izin & sumber ----------
async function requestPermission() {
  if (!isNative) return toast("Izin hanya ada di aplikasi Android.");
  try {
    await NotificationsListener.requestPermission();
  } catch {
    toast("Tidak bisa membuka pengaturan izin.");
  }
}
const requestNotify = async () => {
  if (!isNative) return;
  try { await SetorNative.requestNotify(); } catch {}
  renderHealth();
};
const openBattery = () => (isNative ? SetorNative.openBatterySettings().catch(() => toast("Tidak bisa membuka pengaturan baterai.")) : toast("Hanya di aplikasi Android."));

$("savePackages").addEventListener("click", async () => {
  const next = [...new Set($("packages").value.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!next.length) return toast("Isi minimal satu paket aplikasi.");
  if (next.some((p) => !/^[a-zA-Z][\w]*(\.[\w]+)+$/.test(p))) return toast("Format paket tidak valid, contoh: id.dana");
  packages = next;
  await Preferences.set({ key: KEY_PKGS, value: JSON.stringify(packages) });
  if (isNative) await NotificationsListener.replacePackagesWhitelist({ packagesWhitelist: packages });
  $("packages").value = packages.join(", ");
  toast("Sumber notifikasi disimpan");
});

// ---------- panduan awal ----------
const obCard = (icon, title, text) => `<div class="ob-card"><span class="oi">${icon}</span><div><b>${title}</b>${text}</div></div>`;
const OB_STEPS = [
  {
    title: "Uang masuk, langsung tercatat",
    text: "Setor membaca notifikasi DANA \"Pembayaran Masuk\", mencatatnya, lalu mengirim ke web usahamu supaya tagihan otomatis lunas.",
    visual: () => obCard("DANA", "Pembayaran Masuk", "Rp800.512 diterima DANA Bisnis.") + obCard("S", "✅ K3 · Budi lunas", "Rp800.512 · Kos Melati") + obCard("WA", "Pengingat siap kirim", "Yang belum bayar, sekali ketuk"),
    primary: ["Mulai", null],
  },
  {
    title: "Izinkan Setor membaca notifikasi",
    text: "Cari Setor di daftar, lalu aktifkan. Setor hanya menyimpan notif \"Rp… diterima\"; notif lain diabaikan dan tidak disimpan.",
    visual: () => `<div class="ob-list"><b>Akses notifikasi</b><span>1. Ketuk tombol di bawah</span><span>2. Pilih <b>Setor</b></span><span>3. Aktifkan, lalu kembali ke sini</span></div>`,
    primary: ["Buka pengaturan izin", requestPermission],
  },
  {
    title: "Biar HP berbunyi saat uang masuk",
    text: "Setor memberi tahu \"✅ K3 · Budi lunas\" dengan bunyi khasnya, walau aplikasi tertutup.",
    visual: () => obCard("S", "Rp800.512 masuk", "DANA · mengirim ke Kos Melati…"),
    primary: ["Izinkan notifikasi", requestNotify],
  },
  {
    title: "Jangan biarkan Setor ditidurkan",
    text: "Penghemat baterai bisa mematikan Setor diam-diam. Pilih Tidak dibatasi untuk Setor.",
    visual: () => `<div class="ob-list"><b>Setelan → Aplikasi → Setor → Baterai → Tidak dibatasi</b><span id="obBrand"></span></div>`,
    primary: ["Atur baterai", openBattery],
  },
];
let obStep = 0;

function showOnboard(step = 0) {
  obStep = step;
  const s = OB_STEPS[step];
  $("onboard").classList.remove("hidden");
  $("obTitle").textContent = s.title;
  $("obText").textContent = s.text;
  $("obVisual").innerHTML = s.visual();
  if ($("obBrand")) $("obBrand").textContent = brandTip() ?? "";
  $("obPrimary").textContent = s.primary[0];
  $("obNext").textContent = step === OB_STEPS.length - 1 ? "Selesai" : "Lanjut";
  $("obNext").classList.toggle("hidden", step === 0);
  document.querySelectorAll(".ob-dots i").forEach((d, i) => d.classList.toggle("on", i <= step));
  $("obPrimary").focus();
}

async function finishOnboard() {
  $("onboard").classList.add("hidden");
  await Preferences.set({ key: KEY_OB, value: "1" });
  refreshPermission();
}

const nextOnboard = () => (obStep < OB_STEPS.length - 1 ? showOnboard(obStep + 1) : finishOnboard());
$("obPrimary").addEventListener("click", async () => {
  const action = OB_STEPS[obStep].primary[1];
  if (action) await action();
  // Izin baca notif membuka layar Android; langkah berikut ditampilkan saat kembali
  nextOnboard();
});
$("obNext").addEventListener("click", nextOnboard);
$("obSkip").addEventListener("click", finishOnboard);
$("reOnboard").addEventListener("click", () => showOnboard(0));

// ---------- umum ----------
let toastTimer;
function toast(msg) {
  const node = $("toast");
  node.textContent = msg;
  node.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 2400);
}

for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => setTab(tab.dataset.tab));
for (const id of ["q", "from", "to"]) $(id).addEventListener("input", render);
$("resetFilter").addEventListener("click", () => {
  $("q").value = $("from").value = $("to").value = "";
  render();
});
$("exportCsv").addEventListener("click", () => exportCsv(filterTx(txs, currentFilter())));
$("exportCsv2").addEventListener("click", () => exportCsv(txs));
$("exportCsv3").addEventListener("click", () => exportCsv(txs));
$("hPostBtn").addEventListener("click", requestNotify);
$("hBatteryBtn").addEventListener("click", openBattery);
$("hAccessBtn").addEventListener("click", requestPermission);
$("grant").addEventListener("click", requestPermission);
for (const id of ["goConnect", "addUsaha"]) $(id).addEventListener("click", () => openPair());
for (const id of ["bandMin", "bandMax"]) $(id).addEventListener("input", bandHint);
$("bizSave").addEventListener("click", saveBiz);
$("scanQr").addEventListener("click", scanQr);
$("connPair").addEventListener("click", pair);
$("openInbox").addEventListener("click", () => setTab("inbox"));
$("closeInbox").addEventListener("click", () => setTab("home"));
$("homeReminder").addEventListener("click", () => {
  inboxFilter = "act";
  setTab("inbox");
  renderInbox();
});
for (const b of document.querySelectorAll(".chipbtn")) b.addEventListener("click", () => {
  inboxFilter = b.dataset.f;
  renderInbox();
});

// Pratinjau browser: tiru notifikasi DANA supaya seluruh alur bisa dicoba tanpa HP
$("simulate").addEventListener("click", () =>
  onNotification({
    package: packages[0],
    title: "Pembayaran Masuk",
    text: `Rp${(Math.floor(Math.random() * 900_000) + 1000).toLocaleString("id-ID")} diterima DANA Bisnis.`,
    time: Date.now(),
  })
);

// Kembali dari layar izin / aplikasi dibuka lagi: cek izin, ambil notif yang tertahan di cache, segarkan pengingat
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (isNative) {
    await refreshPermission();
    if (listening) await NotificationsListener.restoreCachedNotifications().catch(() => {});
  }
  syncNow();
  refreshSummaries();
  autoBackup();
});

// Selama aplikasi terbuka: kirim ulang antrian tiap menit (mis. internet kembali), pengingat tiap 10 menit
setInterval(() => document.visibilityState === "visible" && syncNow(), 60_000);
setInterval(() => document.visibilityState === "visible" && refreshSummaries(), 10 * 60_000);

(async () => {
  let tab = "home";
  try { tab = localStorage.getItem("setorpantau.tab") || "home"; } catch {}
  setTab(VIEWS.includes(tab) ? tab : "home");
  await load();
  $("packages").value = packages.join(", ");
  $("previewNote").classList.toggle("hidden", isNative);
  render();
  renderPermission();
  renderHealth();
  const onboarded = (await Preferences.get({ key: KEY_OB })).value;
  if (!onboarded) showOnboard(0);
  else requestNotify(); // Android 13+: izin tampilkan notifikasi (kalau dulu dilewati)
  try {
    await startListener();
  } catch {
    toast("Pembaca notifikasi gagal dimulai.");
  }
  await refreshPermission();
  syncNow();
  refreshSummaries();
  renderBackupInfo(await readBak());
  autoBackup();
})();
