package app.qingread.android.updates;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import org.json.JSONObject;

/** One account-independent update, entirely inside application-private storage. */
public final class AppUpdateStore {
    private static AppUpdateStore instance;
    private final Context context;
    private final File root, shared;
    private final AtomicFile stateFile;
    private JSONObject state = new JSONObject();
    public static synchronized AppUpdateStore get(Context context) {
        if (instance == null) instance = new AppUpdateStore(context.getApplicationContext());
        return instance;
    }
    private AppUpdateStore(Context context) {
        this.context = context; root = new File(context.getFilesDir(), "app-updates"); shared = new File(root, "shared");
        if (!shared.isDirectory() && !shared.mkdirs()) throw new IllegalStateException("无法创建更新目录");
        stateFile = new AtomicFile(new File(root, "state.json"));
        try (FileInputStream in = stateFile.openRead()) {
            byte[] bytes = new byte[16385]; int length = 0, count;
            while (length < bytes.length && (count = in.read(bytes, length, bytes.length - length)) > 0) length += count;
            if (length > 16384) throw new IllegalStateException();
            state = new JSONObject(new String(bytes, 0, length, StandardCharsets.UTF_8));
            if (!validStoredState()) throw new IllegalStateException();
            if ("downloading".equals(state.optString("status"))) { state.put("status", "failed"); state.put("error", "下载已中断，请重试"); save(); }
            if (state.optLong("build") <= installedBuild()) { state = new JSONObject(); clearFiles(); save(); }
            else if ("ready".equals(state.optString("status")) && (!apk(state).isFile() || apk(state).length() != state.optLong("totalBytes"))) { state.put("status", "failed").put("error", "更新安装包已失效，请重新下载"); clearFiles(); save(); }
        } catch (Exception error) { state = new JSONObject(); clearFiles(); }
    }
    private boolean validStoredState() {
        try {
            if (!state.optString("generation").matches("[a-f0-9-]{36}") || !state.optString("sha256").matches("[a-f0-9]{64}")) return false;
            PackageInfo current = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            AppUpdatePolicy.downloadURL(state.getString("apiBase"), state.getString("url"), state.getString("version"),
                state.getLong("totalBytes"), state.getString("sha256"), state.getLong("build"), current.versionName, code(current));
            return true;
        } catch (Exception error) { return false; }
    }
    public long installedBuild() throws PackageManager.NameNotFoundException { return code(context.getPackageManager().getPackageInfo(context.getPackageName(), 0)); }
    static long code(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    public synchronized JSONObject begin(String apiBase, String url, String hash, long size, String version, long build) throws Exception {
        String checkedURL = AppUpdatePolicy.downloadURL(apiBase, url, version, size, hash, build, context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName, installedBuild());
        if ("downloading".equals(state.optString("status"))) throw new IllegalStateException("更新正在下载");
        clearFiles();
        state = new JSONObject().put("status", "downloading").put("generation", UUID.randomUUID().toString())
            .put("apiBase", apiBase).put("url", checkedURL).put("sha256", hash.toLowerCase(java.util.Locale.ROOT)).put("totalBytes", size)
            .put("receivedBytes", 0).put("version", version).put("build", build);
        save(); return request();
    }
    public synchronized JSONObject request() throws Exception { return new JSONObject(state.toString()); }
    public synchronized boolean active(String generation) { return generation.equals(state.optString("generation")) && "downloading".equals(state.optString("status")); }
    public synchronized void progress(String generation, long received) throws Exception {
        if (!active(generation)) return; state.put("receivedBytes", received);
        // Progress is informational; only start/completion/failure require durable writes.
    }
    public synchronized boolean ready(String generation) throws Exception {
        if (!active(generation)) return false; state.put("receivedBytes", state.getLong("totalBytes")).put("status", "ready"); state.remove("error"); save(); return true;
    }
    public synchronized void fail(String generation, String message) {
        if (!active(generation)) return;
        try { state.put("status", "failed").put("error", message); save(); } catch (Exception ignored) { state = new JSONObject(); }
    }
    public synchronized void cancel() throws Exception {
        state.put("status", "cancelled").put("receivedBytes", 0); state.remove("error"); clearFiles(); save();
    }
    public synchronized JSObject snapshot() {
        JSObject value = new JSObject().put("status", state.optString("status", "idle"))
            .put("receivedBytes", state.optLong("receivedBytes", 0)).put("totalBytes", state.optLong("totalBytes", 0));
        if (state.has("apiBase")) value.put("apiBase", state.optString("apiBase"));
        if (state.has("version")) value.put("version", state.optString("version"));
        if (state.has("build")) value.put("build", state.optLong("build"));
        if (state.has("error")) value.put("error", state.optString("error"));
        value.put("needsPermission", Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls());
        return value;
    }
    public File part(JSONObject request) throws Exception { return artifact(request, ".part"); }
    public File apk(JSONObject request) throws Exception { return artifact(request, ".apk"); }
    private File artifact(JSONObject request, String suffix) throws Exception {
        String generation = request.getString("generation"); if (!generation.matches("[a-f0-9-]{36}")) throw new IllegalStateException("更新状态无效");
        File target = new File(shared, generation + suffix);
        if (!target.getCanonicalFile().getParentFile().equals(shared.getCanonicalFile())) throw new IllegalStateException("更新路径无效");
        return target;
    }
    public File checkedInstallation() throws Exception {
        JSONObject request;
        synchronized (this) {
            if (!"ready".equals(state.optString("status"))) throw new IllegalStateException("请先下载更新");
            request = request();
        }
        File file = apk(request); verify(file, request);
        synchronized (this) {
            if (!"ready".equals(state.optString("status")) || !request.getString("generation").equals(state.optString("generation"))) throw new IllegalStateException("更新状态已改变，请重试");
        }
        return file;
    }
    public void verify(File file, JSONObject request) throws Exception {
        if (!file.isFile() || file.length() != request.getLong("totalBytes")) throw new IllegalArgumentException("安装包不完整，请重新下载");
        MessageDigest hash = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[65536];
        try (FileInputStream input = new FileInputStream(file)) { int read; while ((read = input.read(buffer)) != -1) hash.update(buffer, 0, read); }
        if (!hex(hash.digest()).equals(request.getString("sha256"))) throw new IllegalArgumentException("安装包校验失败，请重新下载");
        PackageManager pm = context.getPackageManager(); int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(file.getAbsolutePath(), flags), installed = pm.getPackageInfo(context.getPackageName(), flags);
        if (archive == null || !context.getPackageName().equals(archive.packageName) || code(archive) != request.getLong("build")
            || !request.getString("version").equals(archive.versionName) || !AppUpdatePolicy.newerVersion(archive.versionName, code(archive), installed.versionName, code(installed))
            || archive.splitNames != null && archive.splitNames.length > 0) throw new IllegalArgumentException("安装包版本或应用不匹配");
        if (!AppUpdatePolicy.sameSigners(signers(installed), signers(archive))) throw new IllegalArgumentException("安装包签名不匹配，请勿卸载当前清读");
        if (archive.applicationInfo == null || archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT) throw new IllegalArgumentException("此版本需要更高版本的 Android 系统");
    }
    private static String[] signers(PackageInfo info) throws Exception {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28 ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        if (signatures == null) return null;
        String[] values = new String[signatures.length];
        for (int i = 0; i < signatures.length; i++) values[i] = hex(MessageDigest.getInstance("SHA-256").digest(signatures[i].toByteArray()));
        return values;
    }
    public static String hex(byte[] bytes) { StringBuilder text = new StringBuilder(); for (byte value : bytes) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return text.toString(); }
    private void clearFiles() { File[] files = shared.listFiles(); if (files != null) for (File file : files) if (file.isFile() && file.getName().matches("[a-f0-9-]{36}\\.(?:apk|part)")) file.delete(); }
    private void save() throws Exception {
        FileOutputStream out = null;
        try { out = stateFile.startWrite(); out.write(state.toString().getBytes(StandardCharsets.UTF_8)); stateFile.finishWrite(out); }
        catch (Exception error) { if (out != null) stateFile.failWrite(out); throw new IllegalStateException("更新状态保存失败"); }
    }
}
