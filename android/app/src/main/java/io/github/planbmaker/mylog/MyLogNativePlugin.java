package io.github.planbmaker.mylog;

import android.Manifest;
import android.app.Activity;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Small helpers: Timeline update flow (location settings, pick exported file) and bank-slip gallery reads. */
@CapacitorPlugin(
    name = "MyLogNative",
    permissions = {
        @Permission(alias = "mediaImages", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MyLogNativePlugin extends Plugin {
    private static final String IMPORT_FILE = "timeline-import.json";

    /** WebView visibility events are unreliable when returning from another app, so tell JS directly. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("appResumed", new JSObject());
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
            call.resolve();
        } catch (Exception e) {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_SETTINGS));
                call.resolve();
            } catch (Exception e2) {
                call.reject("cannot_open");
            }
        }
    }

    @PluginMethod
    public void pickJsonFile(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/json", "application/octet-stream", "text/plain" });
        startActivityForResult(call, i, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        final Uri uri = data.getData();
        new Thread(() -> {
            File out = new File(getContext().getCacheDir(), IMPORT_FILE);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 OutputStream os = new FileOutputStream(out)) {
                if (in == null) throw new Exception("no stream");
                byte[] buf = new byte[65536];
                long total = 0;
                int n;
                while ((n = in.read(buf)) > 0) { os.write(buf, 0, n); total += n; }
                JSObject r = new JSObject();
                r.put("path", out.getAbsolutePath());
                r.put("size", total);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("read_failed");
            }
        }).start();
    }

    @PluginMethod
    public void clearImportCache(PluginCall call) {
        new File(getContext().getCacheDir(), IMPORT_FILE).delete();
        call.resolve();
    }

    /* ---------- Bank slips: read-only access to the photo gallery ----------
       The app only reads images (MediaStore query + copy into its own cache for OCR).
       It never changes, moves or deletes anything in the gallery. */

    private static final String SLIP_DIR = "slips";

    private String photoAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "mediaImages" : "storage";
    }

    private boolean hasPhotoAccess() {
        return getPermissionState(photoAlias()) == PermissionState.GRANTED;
    }

    @PluginMethod
    public void slipAccess(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", hasPhotoAccess());
        call.resolve(r);
    }

    @PluginMethod
    public void requestSlipAccess(PluginCall call) {
        if (hasPhotoAccess()) { slipAccess(call); return; }
        requestPermissionForAlias(photoAlias(), call, "slipAccessResult");
    }

    @PermissionCallback
    private void slipAccessResult(PluginCall call) {
        slipAccess(call);
    }

    /** Albums with image counts, so the user can pick where K PLUS / MAKE save their slips. */
    @PluginMethod
    public void listImageBuckets(PluginCall call) {
        if (!hasPhotoAccess()) { call.reject("no_permission"); return; }
        new Thread(() -> {
            Map<String, Integer> counts = new TreeMap<>();
            String[] proj = { MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME };
            try (Cursor c = getContext().getContentResolver().query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, null, null, null)) {
                if (c != null) {
                    int col = c.getColumnIndexOrThrow(MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME);
                    while (c.moveToNext()) {
                        String b = c.getString(col);
                        if (b == null) b = "";
                        Integer n = counts.get(b);
                        counts.put(b, n == null ? 1 : n + 1);
                    }
                }
                JSArray arr = new JSArray();
                for (Map.Entry<String, Integer> e : counts.entrySet()) {
                    JSObject o = new JSObject();
                    o.put("name", e.getKey());
                    o.put("count", e.getValue());
                    arr.put(o);
                }
                JSObject r = new JSObject();
                r.put("buckets", arr);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("query_failed");
            }
        }).start();
    }

    /**
     * Images in the chosen albums added after `since` (unix seconds, as a string), oldest first, at most `limit`.
     * Each one is copied into the app cache (cache/slips/) so the WebView can read it.
     * Returns { images:[{ id, path, name, bucket, added }], more }.
     */
    @PluginMethod
    public void listNewSlipImages(PluginCall call) {
        if (!hasPhotoAccess()) { call.reject("no_permission"); return; }
        // passed as a string: Capacitor's number getters do not accept Long values
        long sinceVal = 0;
        try { sinceVal = Long.parseLong(call.getString("since", "0")); } catch (Exception ignored) { }
        final long since = sinceVal;
        final int limit = Math.max(1, Math.min(50, call.getInt("limit", 20)));
        final JSArray bucketsArg = call.getArray("buckets", new JSArray());
        new Thread(() -> {
            try {
                List<String> buckets = new ArrayList<>();
                for (int i = 0; i < bucketsArg.length(); i++) buckets.add(bucketsArg.getString(i));
                if (buckets.isEmpty()) {
                    JSObject r = new JSObject();
                    r.put("images", new JSArray());
                    r.put("more", false);
                    call.resolve(r);
                    return;
                }
                StringBuilder sel = new StringBuilder(MediaStore.MediaColumns.DATE_ADDED + " > ? AND "
                        + MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME + " IN (");
                List<String> args = new ArrayList<>();
                args.add(String.valueOf(since));
                for (int i = 0; i < buckets.size(); i++) {
                    sel.append(i == 0 ? "?" : ",?");
                    args.add(buckets.get(i));
                }
                sel.append(")");
                String[] proj = {
                    MediaStore.MediaColumns._ID,
                    MediaStore.MediaColumns.DISPLAY_NAME,
                    MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME,
                    MediaStore.MediaColumns.DATE_ADDED
                };
                File dir = new File(getContext().getCacheDir(), SLIP_DIR);
                if (!dir.exists()) dir.mkdirs();
                JSArray out = new JSArray();
                boolean more = false;
                try (Cursor c = getContext().getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        proj, sel.toString(), args.toArray(new String[0]), MediaStore.MediaColumns.DATE_ADDED + " ASC")) {
                    if (c != null) {
                        int cId = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
                        int cName = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
                        int cBucket = c.getColumnIndexOrThrow(MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME);
                        int cAdded = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED);
                        while (c.moveToNext()) {
                            if (out.length() >= limit) { more = true; break; }
                            long id = c.getLong(cId);
                            Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                            File f = new File(dir, id + ".img");
                            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                                 OutputStream os = new FileOutputStream(f)) {
                                if (in == null) continue;
                                byte[] buf = new byte[65536];
                                int n;
                                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                            } catch (Exception e) {
                                continue;   // unreadable image: skip it
                            }
                            JSObject o = new JSObject();
                            o.put("id", String.valueOf(id));
                            o.put("path", f.getAbsolutePath());
                            o.put("name", c.getString(cName));
                            o.put("bucket", c.getString(cBucket));
                            o.put("added", c.getLong(cAdded));
                            out.put(o);
                        }
                    }
                }
                JSObject r = new JSObject();
                r.put("images", out);
                r.put("more", more);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("query_failed");
            }
        }).start();
    }

    /** Delete the app's own cached copies (cache/slips/). Never touches the gallery. */
    @PluginMethod
    public void clearSlipCache(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), SLIP_DIR);
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        call.resolve();
    }
}
