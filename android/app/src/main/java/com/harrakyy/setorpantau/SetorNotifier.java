package com.harrakyy.setorpantau;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.NumberFormat;
import java.util.Locale;
import java.util.Scanner;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Notifikasi khusus Setor + kirim uang masuk ke web usaha saat app tidak terbuka (Protokol Setor). */
final class SetorNotifier {
    // Suara melekat ke channel sejak Android 8; ganti id channel kalau suaranya diganti
    static final String CHANNEL = "uang_masuk_v1";

    // Sama dengan AMOUNT_RE di core.js
    private static final Pattern AMOUNT = Pattern.compile("Rp\\s?([\\d.]+)(?:,\\d{1,2})?\\s+diterima", Pattern.CASE_INSENSITIVE);

    private SetorNotifier() {}

    // ---------- logika murni (dites di SetorNotifierTest) ----------

    /** Nominal dari teks notifikasi DANA, atau -1 kalau bukan uang masuk. */
    static long parseAmount(String text) {
        Matcher m = AMOUNT.matcher(text == null ? "" : text);
        if (!m.find()) return -1;
        try {
            long v = Long.parseLong(m.group(1).replace(".", ""));
            return v > 0 ? v : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** Id yang sama dengan core.js (`paket|waktu|teks`), supaya web mengenali kiriman ganda dari app. */
    static String notifId(String pkg, long time, String text) {
        return pkg + "|" + time + "|" + text;
    }

    static boolean inBand(long amount, int min, int max) {
        long last3 = amount % 1000;
        return last3 >= min && last3 <= max;
    }

    /**
     * Sama dengan targetConn di sync.js: jalur sekarang, lalu jalur lama yang masih berlaku (prevBands, sampai `until`),
     * lalu web lama tanpa jalur, atau null (tetap di HP). Bisnis tanpa url = hanya dicatat di HP.
     */
    static JSONObject target(JSONArray conns, long amount, long time) {
        JSONObject old = null, fallback = null;
        for (int i = 0; conns != null && i < conns.length(); i++) {
            JSONObject c = conns.optJSONObject(i);
            if (c == null) continue;
            JSONObject band = c.optJSONObject("band");
            if (band != null && inBand(amount, band.optInt("min"), band.optInt("max"))) return c;
            JSONArray prev = c.optJSONArray("prevBands");
            for (int j = 0; old == null && prev != null && j < prev.length(); j++) {
                JSONObject b = prev.optJSONObject(j);
                if (b != null && b.optLong("until") >= time && inBand(amount, b.optInt("min"), b.optInt("max"))) old = c;
            }
            if (band == null && c.has("url") && fallback == null) fallback = c;
        }
        return old != null ? old : fallback;
    }

    static String rupiah(long amount) {
        return "Rp" + NumberFormat.getIntegerInstance(new Locale("id", "ID")).format(amount);
    }

    // ---------- notifikasi ----------

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Uang masuk", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Pembayaran DANA yang tercatat dan status lunasnya");
        ch.setSound(Uri.parse("android.resource://" + ctx.getPackageName() + "/" + R.raw.setor_masuk),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[]{0, 40, 70, 40});
        ch.enableLights(true);
        ch.setLightColor(0xFF3D78F0);
        nm.createNotificationChannel(ch);
    }

    static boolean canNotify(Context ctx) {
        return Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /** Notifikasi dengan `key` sama memperbarui yang lama tanpa bunyi ulang (mis. "mengirim…" → "lunas"). */
    static void show(Context ctx, String key, String title, String text) {
        if (!canNotify(ctx)) return;
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_setor)
                .setColor(0xFF14389E)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(ctx).notify(key.hashCode(), b.build());
        } catch (SecurityException ignored) {
            // izin dicabut di antara cek dan notify
        }
    }

    // ---------- kirim ke web (dipanggil di thread latar) ----------

    /** Kirim satu uang masuk ke web yang terhubung lalu perbarui notifikasinya. Gagal = dicoba lagi oleh app saat dibuka. */
    static void deliver(Context ctx, JSONObject conn, String id, long amount, long time, String text) {
        // Jalur sudah dipilih target() (termasuk jalur lama yang masih berlaku)
        String business = conn.optString("business", "web usaha");
        show(ctx, id, rupiah(amount) + " masuk", "DANA · mengirim ke " + business + "…");
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(conn.getString("url") + "/api/payments/qris/notification").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + conn.getString("token"));
            JSONObject body = new JSONObject().put("notifId", id).put("amount", amount).put("time", time).put("text", text);
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = c.getResponseCode();
            if (status < 200 || status >= 300) {
                show(ctx, id, rupiah(amount) + " masuk", status == 401 ? "Akses ke web dicabut · buka Setor" : "Belum terkirim · buka Setor untuk kirim ulang");
                return;
            }
            String raw;
            try (Scanner s = new Scanner(c.getInputStream(), "UTF-8").useDelimiter("\\A")) {
                raw = s.hasNext() ? s.next() : "{}";
            }
            JSONObject data = new JSONObject(raw).optJSONObject("data");
            String result = data == null ? "" : data.optString("result");
            String label = data == null ? "" : data.optString("label", "");
            if (label.isEmpty() || "null".equals(label)) {
                String code = data == null ? "" : data.optString("reservationCode", "");
                label = code.isEmpty() || "null".equals(code) ? "" : "Booking " + code;
            }
            boolean already = "duplicate".equals(result) || "ALREADY_PAID".equals(result);
            if ("matched".equalsIgnoreCase(result) || (already && !label.isEmpty())) {
                show(ctx, id, "✅ " + (label.isEmpty() ? "Lunas" : label + " lunas"), rupiah(amount) + " · " + business);
            } else if (already) {
                show(ctx, id, rupiah(amount) + " masuk", "Sudah tercatat di " + business);
            } else {
                show(ctx, id, rupiah(amount) + " masuk", "Belum cocok dengan tagihan · cek di " + business);
            }
        } catch (Exception e) {
            show(ctx, id, rupiah(amount) + " masuk", "Offline · dikirim saat Setor dibuka");
        }
    }
}
