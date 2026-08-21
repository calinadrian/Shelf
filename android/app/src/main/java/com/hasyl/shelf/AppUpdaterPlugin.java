package com.hasyl.shelf;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private long downloadId = -1;
    private String downloadedFileName;

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (completedId != downloadId || downloadedFileName == null) return;
            DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
                if (cursor.moveToFirst() && cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL) {
                    openInstaller(downloadedFileName);
                }
            }
        }
    };

    @Override
    public void load() {
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(downloadReceiver, filter);
        }
    }

    @Override
    protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(downloadReceiver); } catch (IllegalArgumentException ignored) {}
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getLatestRelease(PluginCall call) {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL latest = new URL("https://github.com/calinadrian/Shelf/releases/latest?_=" + System.currentTimeMillis());
                connection = (HttpURLConnection) latest.openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setRequestMethod("HEAD");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setUseCaches(false);
                connection.setRequestProperty("User-Agent", "Shelf-Android-Updater");
                int status = connection.getResponseCode();
                URL resolved = connection.getURL();
                String path = resolved.getPath();
                String prefix = "/calinadrian/Shelf/releases/tag/";
                if (status < 200 || status >= 400 || !"github.com".equalsIgnoreCase(resolved.getHost()) || !path.startsWith(prefix)) {
                    throw new IllegalStateException("GitHub did not return a release");
                }
                String tag = path.substring(prefix.length());
                if (!tag.matches("v[0-9]+(?:\\.[0-9]+){2}(?:[-._A-Za-z0-9]*)?")) {
                    throw new IllegalStateException("GitHub returned an invalid release tag");
                }
                JSObject result = new JSObject();
                result.put("tagName", tag);
                result.put("assetName", "Shelf-" + tag + ".apk");
                result.put("assetUrl", "https://github.com/calinadrian/Shelf/releases/download/" + tag + "/Shelf-" + tag + ".apk");
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not check GitHub for updates", error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "shelf-update-check").start();
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String requestedName = call.getString("fileName", "shelf-update.apk");
        if (url == null) { call.reject("Missing update URL"); return; }
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) || !"github.com".equalsIgnoreCase(uri.getHost())) {
            call.reject("Updates must come from github.com");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(settings);
            JSObject result = new JSObject();
            result.put("permissionRequired", true);
            call.resolve(result);
            return;
        }

        downloadedFileName = requestedName.replaceAll("[^A-Za-z0-9._-]", "_");
        File previousDownload = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), downloadedFileName);
        if (previousDownload.exists()) previousDownload.delete();
        DownloadManager.Request request = new DownloadManager.Request(uri)
            .setTitle("Shelf update")
            .setDescription("Downloading " + downloadedFileName)
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, downloadedFileName);
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        downloadId = manager.enqueue(request);
        JSObject result = new JSObject();
        result.put("permissionRequired", false);
        result.put("downloadId", downloadId);
        call.resolve(result);
    }

    private void openInstaller(String fileName) {
        File apk = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName);
        if (!apk.exists()) return;
        Uri contentUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent install = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(contentUri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(install);
    }
}
