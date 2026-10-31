package app.qingread.android.updates;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import app.qingread.android.MainActivity;
import app.qingread.android.R;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** User-started, bounded download; it never starts an installer from background. */
public final class QingReadAppUpdateService extends Service {
    public static final String ACTION_RUN = "app.qingread.android.APP_UPDATE_RUN";
    public static final String ACTION_CANCEL = "app.qingread.android.APP_UPDATE_CANCEL";
    private static final String CHANNEL = "qingread-app-updates-v1";
    private static final int NOTIFICATION = 7301;
    private static volatile HttpsURLConnection activeConnection;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    public static void interruptRequest() { HttpsURLConnection connection = activeConnection; if (connection != null) connection.disconnect(); }
    @Override public void onCreate() {
        super.onCreate();
        try { if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "清读版本更新", NotificationManager.IMPORTANCE_LOW)); }
        catch (RuntimeException ignored) { /* A failed foreground start is handled below. */ }
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        try { return startRequest(intent, startId); }
        catch (RuntimeException error) {
            try { AppUpdateStore store = AppUpdateStore.get(this); store.fail(store.request().optString("generation"), "系统暂不允许更新下载，请回到清读重试"); } catch (Exception ignored) { }
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId); return START_NOT_STICKY;
        }
    }
    private int startRequest(Intent intent, int startId) {
        AppUpdateStore store = AppUpdateStore.get(this);
        if (intent != null && ACTION_CANCEL.equals(intent.getAction())) {
            try { store.cancel(); } catch (Exception ignored) { }
            interruptRequest(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY;
        }
        if (intent == null || !ACTION_RUN.equals(intent.getAction())) { stopSelf(startId); return START_NOT_STICKY; }
        startForeground(NOTIFICATION, notification(store.snapshot(), true));
        try {
            JSONObject request = store.request();
            executor.execute(() -> {
                try { download(store, request); }
                finally { if (stopSelfResult(startId)) stopForeground(STOP_FOREGROUND_REMOVE); }
            });
        } catch (Exception error) {
            try { store.fail(store.request().optString("generation"), "无法启动更新下载，请重试"); } catch (Exception ignored) { }
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId);
        }
        return START_NOT_STICKY;
    }
    private void download(AppUpdateStore store, JSONObject request) {
        String generation = request.optString("generation");
        if (!store.active(generation)) return;
        File part = null, apk = null; HttpsURLConnection connection = null; PowerManager.WakeLock wake = null;
        ScheduledFuture<?> deadline = null;
        long started = SystemClock.elapsedRealtime();
        try {
            part = store.part(request); apk = store.apk(request); final String expectedGeneration = generation;
            wake = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "qingread:app-update");
            wake.acquire(AppUpdatePolicy.MAX_DURATION_MS);
            connection = (HttpsURLConnection) new URL(request.getString("url")).openConnection();
            connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
            connection.setConnectTimeout(15_000); connection.setReadTimeout(20_000);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Cookie", ""); connection.setRequestProperty("Authorization", "");
            activeConnection = connection;
            if (!store.active(generation)) throw new InterruptedException();
            final HttpsURLConnection boundedConnection = connection;
            deadline = watchdog.schedule(() -> { if (store.active(expectedGeneration)) boundedConnection.disconnect(); }, AppUpdatePolicy.MAX_DURATION_MS, TimeUnit.MILLISECONDS);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IllegalArgumentException("无法下载更新，请稍后重试");
            long expected = request.getLong("totalBytes"), declared = connection.getContentLengthLong();
            if (declared != expected) throw new IllegalArgumentException("安装包长度不匹配，请重新检查更新");
            String encoding = connection.getContentEncoding();
            if (encoding != null && !"identity".equalsIgnoreCase(encoding)) throw new IllegalArgumentException("安装包响应格式无效");
            long received = 0, notifiedAt = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(part, false)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (!store.active(generation)) throw new InterruptedException();
                    if (SystemClock.elapsedRealtime() - started > AppUpdatePolicy.MAX_DURATION_MS) throw new IllegalArgumentException("更新下载超时，请重试");
                    received += count;
                    if (received > expected || received > AppUpdatePolicy.MAX_BYTES) throw new IllegalArgumentException("安装包超出预期大小");
                    output.write(buffer, 0, count); store.progress(generation, received);
                    if (SystemClock.elapsedRealtime() - notifiedAt > 1000) {
                        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(store.snapshot(), true)); notifiedAt = SystemClock.elapsedRealtime();
                    }
                }
                if (received != expected) throw new IllegalArgumentException("下载不完整，请重试");
                output.flush(); output.getFD().sync();
            }
            if (!store.active(generation)) throw new InterruptedException();
            store.verify(part, request);
            if (!store.active(generation)) throw new InterruptedException();
            if (!part.renameTo(apk)) throw new IllegalStateException("无法保存更新安装包");
            if (!store.ready(generation)) throw new InterruptedException();
            if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                getSystemService(NotificationManager.class).notify(NOTIFICATION + 1, notification(store.snapshot(), false));
        } catch (Exception error) {
            String message = error instanceof IllegalArgumentException || error instanceof IllegalStateException ? error.getMessage() : "下载已中断，请重试";
            if (SystemClock.elapsedRealtime() - started >= AppUpdatePolicy.MAX_DURATION_MS) message = "更新下载超时，请重试";
            store.fail(generation, message == null || message.length() > 100 || !message.matches("^[一-龥].*") ? "更新下载失败，请重试" : message);
            if (apk != null) apk.delete();
        } finally {
            if (deadline != null) deadline.cancel(false);
            if (part != null) part.delete();
            if (connection != null) { connection.disconnect(); if (activeConnection == connection) activeConnection = null; }
            if (wake != null && wake.isHeld()) wake.release();
        }
    }
    private Notification notification(com.getcapacitor.JSObject state, boolean downloading) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("qingreadOpenAppUpdate", true);
        PendingIntent pending = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long total = state.optLong("totalBytes"), received = state.optLong("receivedBytes");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_qingread_notification)
            .setContentTitle(downloading ? "正在下载清读更新" : "清读更新已下载")
            .setContentText(downloading ? Math.min(100, total > 0 ? received * 100 / total : 0) + "%" : "打开清读继续安装")
            .setContentIntent(pending).setOnlyAlertOnce(true).setOngoing(downloading).setAutoCancel(!downloading).setPriority(NotificationCompat.PRIORITY_LOW);
        if (downloading) {
            builder.setProgress(100, (int) Math.min(100, total > 0 ? received * 100 / total : 0), total <= 0);
            PendingIntent cancel = PendingIntent.getService(this, NOTIFICATION, new Intent(this, QingReadAppUpdateService.class).setAction(ACTION_CANCEL), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(0, "取消", cancel);
        }
        return builder.build();
    }
    @Override public void onTimeout(int startId, int fgsType) {
        try { JSONObject request = AppUpdateStore.get(this).request(); AppUpdateStore.get(this).fail(request.optString("generation"), "系统已暂停下载，请重试"); } catch (Exception ignored) { }
        interruptRequest(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    @Override public void onDestroy() { interruptRequest(); executor.shutdownNow(); watchdog.shutdownNow(); super.onDestroy(); }
}
