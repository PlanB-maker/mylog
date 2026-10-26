package io.github.planbmaker.mylog;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** Small helpers for the Timeline update flow: open location settings, pick the exported file. */
@CapacitorPlugin(name = "MyLogNative")
public class MyLogNativePlugin extends Plugin {
    private static final String IMPORT_FILE = "timeline-import.json";

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
}
