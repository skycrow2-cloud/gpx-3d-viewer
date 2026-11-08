package io.github.skycrow2cloud.gpx3d;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Passage direct GPX 3D ⇄ The-GPX-Box entre les deux applications Android.
 * La trace (JSON {gpx, name, from, t}, comme le passage entre sites) est écrite dans le cache,
 * exposée par HandoffProvider et transmise par une intention explicite à l'autre application.
 * Renvoie false si l'autre application est absente (ou trop ancienne) : la page bascule alors sur le site.
 */
final class Handoff {
    static final String ACTION = "io.github.skycrow2cloud.gpxsuite.HANDOFF";
    static final String OTHER_PKG = "io.github.skycrow2cloud.gpxbox";
    static final String AUTHORITY = "io.github.skycrow2cloud.gpx3d.handoff";
    static final String FILE = "handoff.json";

    static boolean send(Activity a, String payload) {
        Intent launch = a.getPackageManager().getLaunchIntentForPackage(OTHER_PKG);
        if (launch == null) return false;
        try {
            if (payload == null || payload.isEmpty()) {
                a.startActivity(launch);
                return true;
            }
            File f = new File(a.getCacheDir(), FILE);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(payload.getBytes(StandardCharsets.UTF_8));
            }
            Uri u = Uri.parse("content://" + AUTHORITY + "/" + FILE);
            Intent i = new Intent(ACTION);
            i.setPackage(OTHER_PKG);
            i.setClipData(ClipData.newRawUri("gpx", u));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            a.startActivity(i);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;          // autre application installée mais sans le passage direct
        } catch (Exception e) {
            return false;
        }
    }

    /** Contenu reçu d'une intention HANDOFF, ou null. */
    static String read(Context c, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction()) || intent.getClipData() == null
                || intent.getClipData().getItemCount() == 0) return null;
        Uri u = intent.getClipData().getItemAt(0).getUri();
        if (u == null) return null;
        try (InputStream in = c.getContentResolver().openInputStream(u)) {
            if (in == null) return null;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    private Handoff() { }
}
