package app.qingread.android.updates;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.security.SecureRandom;
import org.json.JSONObject;

@CapacitorPlugin(name = "QingReadAppUpdates")
public final class QingReadAppUpdatesPlugin extends Plugin {
    private volatile String nonce = "";
    private final WebViewListener listener = new WebViewListener() {
        @Override public void onPageStarted(WebView view) { nonce = ""; }
        @Override public void onPageCommitVisible(WebView view, String url) { inject(view); }
        @Override public void onPageLoaded(WebView view) { inject(view); }
    };
    @Override public void load() {
        getBridge().addWebViewListener(listener);
        getActivity().runOnUiThread(() -> inject(getBridge().getWebView()));
    }
    private void inject(WebView view) {
        if (!AppUpdatePolicy.trustedPage(view.getUrl())) { nonce = ""; return; }
        if (nonce.isEmpty()) { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); nonce = AppUpdateStore.hex(bytes); }
        // evaluateJavascript executes only in the top frame. Cross-origin frames
        // cannot read this document-scoped token or obtain it through the plugin.
        view.evaluateJavascript("Object.defineProperty(window,'__qingreadAppUpdateNonce',{value:'" + nonce + "',configurable:true});", null);
    }
    private void trusted(PluginCall call, Runnable action) {
        getActivity().runOnUiThread(() -> {
            if (nonce.isEmpty() || !nonce.equals(call.getString("nonce")) || !AppUpdatePolicy.trustedPage(getBridge().getWebView().getUrl())) { call.reject("当前页面不能执行应用更新"); return; }
            action.run();
        });
    }
    private static long integer(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof Integer || raw instanceof Long)) throw new IllegalArgumentException("更新信息无效");
        return ((Number) raw).longValue();
    }
    private void reject(PluginCall call, Exception error) {
        String message = error.getMessage(); call.reject(message == null || message.length() > 150 || !message.matches("^[一-龥].*") ? "应用更新未完成，请重试" : message);
    }
    @PluginMethod public void getState(PluginCall call) { trusted(call, () -> execute(() -> {
        try { call.resolve(AppUpdateStore.get(getContext()).snapshot()); } catch (Exception error) { reject(call, error); }
    })); }
    @PluginMethod public void download(PluginCall call) { trusted(call, () -> execute(() -> {
        AppUpdateStore store = null; JSONObject request = null;
        try {
            store = AppUpdateStore.get(getContext());
            JSObject artifact = call.getObject("artifact");
            if (artifact == null) throw new IllegalArgumentException("更新信息无效");
            long build = integer(call.getData(), "build"), size = integer(artifact, "size");
            request = store.begin(call.getString("apiBase"), artifact.getString("url"), artifact.getString("sha256"), size, call.getString("version"), build);
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), QingReadAppUpdateService.class).setAction(QingReadAppUpdateService.ACTION_RUN));
            call.resolve(store.snapshot());
        } catch (Exception error) {
            if (store != null && request != null) store.fail(request.optString("generation"), "请回到清读后重新下载更新");
            reject(call, error);
        }
    })); }
    @PluginMethod public void cancel(PluginCall call) { trusted(call, () -> execute(() -> {
        try { AppUpdateStore store = AppUpdateStore.get(getContext()); store.cancel(); QingReadAppUpdateService.interruptRequest(); call.resolve(store.snapshot()); }
        catch (Exception error) { reject(call, error); }
    })); }
    @PluginMethod public void install(PluginCall call) { trusted(call, () -> {
        if (!getActivity().hasWindowFocus()) { call.reject("回到清读后继续安装更新"); return; }
        execute(() -> {
            try {
                File file = AppUpdateStore.get(getContext()).checkedInstallation();
                getActivity().runOnUiThread(() -> {
                    try {
                        if (nonce.isEmpty() || !nonce.equals(call.getString("nonce")) || !AppUpdatePolicy.trustedPage(getBridge().getWebView().getUrl()) || !getActivity().hasWindowFocus()) throw new IllegalStateException("回到清读后继续安装更新");
                        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
                            call.resolve(new JSObject().put("action", "permission")); return;
                        }
                        Uri content = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".updates", file);
                        Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(content, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(install); call.resolve(new JSObject().put("action", "installer"));
                    } catch (Exception error) { reject(call, error); }
                });
            } catch (Exception error) { reject(call, error); }
        });
    }); }
    @Override protected void handleOnDestroy() { getBridge().removeWebViewListener(listener); nonce = ""; super.handleOnDestroy(); }
}
