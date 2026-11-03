package com.harrakyy.setorpantau;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.junit.Test;

public class SetorNotifierTest {
    @Test
    public void parseAmount_samaDenganCoreJs() {
        assertEquals(1000, SetorNotifier.parseAmount("Rp1.000 diterima DANA Bisnis."));
        assertEquals(799873, SetorNotifier.parseAmount("Rp 799.873 diterima DANA Bisnis."));
        assertEquals(15000, SetorNotifier.parseAmount("Rp15.000,00 diterima"));
        assertEquals(-1, SetorNotifier.parseAmount("Cashback Rp10.000 untukmu"));
        assertEquals(-1, SetorNotifier.parseAmount(null));
    }

    @Test
    public void notifId_formatSamaDenganCoreJs() {
        assertEquals("id.dana|1700|Rp1.000 diterima", SetorNotifier.notifId("id.dana", 1700, "Rp1.000 diterima"));
    }

    @Test
    public void inBand_tigaDigitTerakhir() {
        assertTrue(SetorNotifier.inBand(799873, 500, 999));
        assertFalse(SetorNotifier.inBand(120350, 500, 999));
        assertFalse(SetorNotifier.inBand(50000, 500, 999));
        assertTrue(SetorNotifier.inBand(35017, 1, 99));
    }

    @Test
    public void rupiah_titikRibuan() {
        assertEquals("Rp799.873", SetorNotifier.rupiah(799873));
    }

    @Test
    public void target_samaDenganSyncJs() throws Exception {
        JSONArray conns = new JSONArray("[{\"url\":\"https://atm\"},{\"url\":\"https://kos\",\"band\":{\"min\":500,\"max\":999}}]");
        assertEquals("https://kos", SetorNotifier.target(conns, 800512, 0).optString("url"));
        assertEquals("https://atm", SetorNotifier.target(conns, 35017, 0).optString("url"));
        JSONArray kosOnly = new JSONArray("[{\"url\":\"https://kos\",\"band\":{\"min\":500,\"max\":999}}]");
        assertEquals(null, SetorNotifier.target(kosOnly, 35017, 0));
    }

    @Test
    public void target_jalurLamaDanBisnisTanpaWeb() throws Exception {
        JSONArray conns = new JSONArray("[{\"id\":\"b\",\"business\":\"Toko Bunga\",\"band\":{\"min\":200,\"max\":349}},"
                + "{\"url\":\"https://kos\",\"band\":{\"min\":600,\"max\":999},\"prevBands\":[{\"min\":500,\"max\":999,\"until\":100}]}]");
        assertEquals("Toko Bunga", SetorNotifier.target(conns, 75250, 0).optString("business"));
        assertEquals("https://kos", SetorNotifier.target(conns, 799512, 50).optString("url"));
        assertEquals(null, SetorNotifier.target(conns, 799512, 200)); // jalur lama sudah kedaluwarsa
    }
}
