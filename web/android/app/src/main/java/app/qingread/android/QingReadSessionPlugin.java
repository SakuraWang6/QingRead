package app.qingread.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "QingReadSession")
public class QingReadSessionPlugin extends Plugin {
    private static final String ALIAS = "qingread-cloud-session-v1";
    private SharedPreferences preferences() { return getContext().getSharedPreferences("qingread-cloud-session", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    @PluginMethod public void save(PluginCall call) {
        try {
            String value = call.getString("value"); if (value == null || value.length() > 16384) { call.reject("Invalid session"); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String encrypted = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            if (!preferences().edit().putString("iv", iv).putString("value", encrypted).commit()) { call.reject("Session save failed"); return; }
            call.resolve();
        } catch (Exception error) { call.reject("Session save failed"); }
    }
    @PluginMethod public void load(PluginCall call) {
        JSObject result = new JSObject();
        try {
            String iv = preferences().getString("iv", null), encrypted = preferences().getString("value", null);
            if (iv == null || encrypted == null) { result.put("value", JSObject.NULL); call.resolve(result); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            result.put("value", new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8)); call.resolve(result);
        } catch (Exception error) { preferences().edit().clear().apply(); result.put("value", JSObject.NULL); call.resolve(result); }
    }
    @PluginMethod public void clear(PluginCall call) {
        if (preferences().edit().clear().commit()) call.resolve(); else call.reject("Session clear failed");
    }
}
