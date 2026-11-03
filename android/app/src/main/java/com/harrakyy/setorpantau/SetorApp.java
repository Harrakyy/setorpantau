package com.harrakyy.setorpantau;

import android.app.Application;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Saat app tertutup, Android tetap menjalankan service pembaca notifikasi (plugin) di proses ini,
 * dan plugin menyimpan notif DANA ke cache SharedPreferences. Di sini kita ikut mendengar cache itu
 * supaya notifikasi Setor muncul dan pembayaran langsung terkirim ke web, tanpa menunggu app dibuka.
 * Saat app terbuka, notif dikirim ke WebView (tidak lewat cache) dan JS yang menanganinya.
 */
public class SetorApp extends Application {
    // Nama grup & kunci milik capacitor-notifications-listener (SimpleStorage default) dan Capacitor Preferences
    private static final String PREFS = "CapacitorStorage";
    private static final String CACHE_KEY = "notificationsCache";
    private static final String CONNS_KEY = "setorpantau.conns"; // ditulis app.js
    private static final String CONN_KEY_OLD = "setorpantau.conn"; // versi satu usaha, sebelum app dibuka & dimigrasi
    private static final String HANDLED = "setor.native.handled";
    private static final int HANDLED_MAX = 200;

    // SharedPreferences hanya menyimpan referensi lemah ke listener, jadi simpan sebagai field
    private SharedPreferences.OnSharedPreferenceChangeListener listener;

    @Override
    public void onCreate() {
        super.onCreate();
        SetorNotifier.ensureChannel(this);
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        listener = (p, key) -> {
            if (CACHE_KEY.equals(key)) handleCache(p);
        };
        prefs.registerOnSharedPreferenceChangeListener(listener);
    }

    private void handleCache(SharedPreferences prefs) {
        String raw = prefs.getString(CACHE_KEY, null);
        if (raw == null) return; // cache dikosongkan setelah app memulihkannya
        JSONArray cached;
        try {
            cached = new JSONArray(raw);
        } catch (Exception e) {
            return;
        }
        SharedPreferences own = getSharedPreferences(HANDLED, MODE_PRIVATE);
        Set<String> handled = new HashSet<>(own.getStringSet("ids", new HashSet<>()));
        JSONArray conns = new JSONArray();
        try {
            String c = prefs.getString(CONNS_KEY, null);
            String old = prefs.getString(CONN_KEY_OLD, null);
            if (c != null) conns = new JSONArray(c);
            else if (old != null) conns.put(new JSONObject(old));
        } catch (Exception ignored) {
        }
        for (int i = 0; i < cached.length(); i++) {
            JSONObject n = cached.optJSONObject(i);
            if (n == null) continue;
            String text = joinText(n);
            long amount = SetorNotifier.parseAmount(text);
            if (amount <= 0) continue; // promo, uang keluar, dll.
            long time = n.optLong("time", System.currentTimeMillis());
            String id = SetorNotifier.notifId(n.optString("package"), time, text);
            if (!handled.add(id)) continue;
            JSONObject conn = SetorNotifier.target(conns, amount, time);
            if (conn == null) {
                SetorNotifier.show(this, id, SetorNotifier.rupiah(amount) + " masuk",
                        conns.length() == 0 ? "DANA · tercatat di HP" : "DANA · di luar jalur usaha, disimpan di HP saja");
            } else if (conn.optString("url", "").isEmpty()) {
                SetorNotifier.show(this, id, SetorNotifier.rupiah(amount) + " masuk", conn.optString("business", "Bisnis") + " · tercatat di HP");
            } else {
                new Thread(() -> SetorNotifier.deliver(this, conn, id, amount, time, text)).start();
            }
        }
        // shortcut: simpan id terakhir secukupnya (set tak berurutan), cukup karena cache plugin dikosongkan saat app dibuka
        if (handled.size() > HANDLED_MAX) handled.clear();
        own.edit().putStringSet("ids", handled).apply();
    }

    /** Sama dengan parseNotification di core.js: teks + baris tambahan, dipisah spasi. */
    private static String joinText(JSONObject n) {
        StringBuilder sb = new StringBuilder(n.optString("text", ""));
        JSONArray lines = n.optJSONArray("textlines");
        if (lines != null) {
            for (int i = 0; i < lines.length(); i++) {
                String l = lines.optString(i, "");
                if (!l.isEmpty()) sb.append(sb.length() > 0 ? " " : "").append(l);
            }
        }
        return sb.toString().trim();
    }
}
