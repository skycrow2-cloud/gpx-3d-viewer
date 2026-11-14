package io.github.skycrow2cloud.gpx3d;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Widget « dernière trace » de GPX 3D (écran d'accueil, écran externe des pliables type Motorola razr).
 * La page envoie un résumé de la trace sélectionnée par le pont JavaScript
 * (window.GpxSuiteAndroid.updateWidget(json)) : {name, km, gain, loss, durS, ele:[…]}.
 * Le widget affiche nom, distance, D+ / D−, durée et un mini-profil d'altitude ; un appui ouvre l'application.
 * Mise en page adaptée à la taille : profil masqué si le widget est trop bas, statistiques réduites s'il est étroit.
 */
public class TrackWidget extends AppWidgetProvider {
    static final String PREFS = "widget";
    static final String KEY = "track";

    /** Appelé par le pont JavaScript : mémorise la trace et rafraîchit tous les widgets. */
    static void save(Context c, String json) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply();
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, TrackWidget.class));
        for (int id : ids) render(c, m, id);
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) render(c, m, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle opts) {
        render(c, m, id);
    }

    static void render(Context c, AppWidgetManager m, int id) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_track);

        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        v.setOnClickPendingIntent(R.id.w_root, PendingIntent.getActivity(c, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        // taille réelle du widget (dp) : la plus grande largeur / hauteur selon l'orientation
        Bundle o = m.getAppWidgetOptions(id);
        int wDp = Math.max(o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180),
                o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 180));
        int hDp = Math.max(o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110),
                o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110));

        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject t = null;
        try { String s = p.getString(KEY, null); if (s != null) t = new JSONObject(s); } catch (Exception ignored) { }

        if (t == null) {
            v.setTextViewText(R.id.w_name, c.getString(R.string.widget_empty));
            v.setViewVisibility(R.id.w_stats, View.GONE);
            v.setViewVisibility(R.id.w_profile, View.GONE);
            m.updateAppWidget(id, v);
            return;
        }

        String name = t.optString("name", "");
        v.setTextViewText(R.id.w_name, name.isEmpty() ? c.getString(R.string.widget_track) : name);
        v.setViewVisibility(R.id.w_stats, View.VISIBLE);
        v.setTextViewText(R.id.w_dist, String.format(java.util.Locale.ROOT, "%.1f km", t.optDouble("km", 0)));

        boolean hasEle = !t.isNull("gain");
        v.setTextViewText(R.id.w_gain, hasEle ? "↗ " + Math.round(t.optDouble("gain", 0)) + " m" : "");
        v.setTextViewText(R.id.w_loss, hasEle ? "↘ " + Math.round(t.optDouble("loss", 0)) + " m" : "");
        // étroit (écran externe en petit format) : on garde distance + D+ seulement
        v.setViewVisibility(R.id.w_gain, hasEle ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.w_loss, hasEle && wDp >= 200 ? View.VISIBLE : View.GONE);

        long durS = t.isNull("durS") ? -1 : t.optLong("durS", -1);
        boolean showDur = durS > 0 && wDp >= 250;
        v.setViewVisibility(R.id.w_dur, showDur ? View.VISIBLE : View.GONE);
        if (showDur) v.setTextViewText(R.id.w_dur, "⏱ " + (durS / 3600) + " h " + String.format(java.util.Locale.ROOT, "%02d", (durS % 3600) / 60));

        JSONArray ele = t.optJSONArray("ele");
        boolean showProfile = ele != null && ele.length() > 1 && hDp >= 100;
        v.setViewVisibility(R.id.w_profile, showProfile ? View.VISIBLE : View.GONE);
        if (showProfile) {
            float dens = c.getResources().getDisplayMetrics().density;
            int bw = Math.max(80, Math.round((wDp - 24) * dens));
            int bh = Math.max(30, Math.round((hDp - 72) * dens));
            // limite mémoire des RemoteViews : bitmap raisonnable
            float scale = Math.min(1f, 900f / Math.max(bw, bh));
            v.setImageViewBitmap(R.id.w_profile, profile(ele, Math.round(bw * scale), Math.round(bh * scale), dens * scale));
        }
        m.updateAppWidget(id, v);
    }

    /** Mini-profil d'altitude : aire remplie en dégradé orange + ligne. */
    static Bitmap profile(JSONArray ele, int w, int h, float dens) {
        int n = ele.length();
        double min = Double.MAX_VALUE, max = -Double.MAX_VALUE;
        for (int i = 0; i < n; i++) {
            if (ele.isNull(i)) continue;
            double e = ele.optDouble(i);
            if (e < min) min = e;
            if (e > max) max = e;
        }
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        if (min > max) return b;
        double span = Math.max(max - min, 20); // trace plate : pas d'exagération des petites variations
        float pad = 2 * dens;
        Path line = new Path();
        boolean started = false;
        float lastX = 0, firstX = 0;
        for (int i = 0; i < n; i++) {
            if (ele.isNull(i)) continue;
            float x = (float) i / (n - 1) * w;
            float y = pad + (float) ((max - ele.optDouble(i)) / span) * (h - 2 * pad);
            if (!started) { line.moveTo(x, y); firstX = x; started = true; } else line.lineTo(x, y);
            lastX = x;
        }
        Path area = new Path(line);
        area.lineTo(lastX, h);
        area.lineTo(firstX, h);
        area.close();

        Canvas cv = new Canvas(b);
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setShader(new LinearGradient(0, 0, 0, h, Color.argb(150, 232, 163, 61), Color.argb(20, 232, 163, 61), Shader.TileMode.CLAMP));
        cv.drawPath(area, fill);
        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(2f * dens);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        stroke.setColor(Color.rgb(232, 163, 61));
        cv.drawPath(line, stroke);
        return b;
    }
}
