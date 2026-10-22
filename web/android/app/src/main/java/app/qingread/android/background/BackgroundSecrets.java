package app.qingread.android.background;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class BackgroundSecrets {
    private static final String ALIAS = "qingread-background-v1";
    private final SharedPreferences preferences;
    BackgroundSecrets(Context context) { preferences = context.getSharedPreferences("qingread-background-secrets", Context.MODE_PRIVATE); }
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
    synchronized void save(String profile, String accessToken, String authToken) throws Exception {
        if (accessToken.length()>16384||authToken.length()>16384||accessToken.matches("(?s).*[\\x00-\\x1f\\x7f].*")||authToken.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new IllegalArgumentException("凭据格式无效");
        JSONObject data = new JSONObject().put("profile", profile).put("accessToken", accessToken).put("authToken", authToken);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        if (!preferences.edit().clear().putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("value", Base64.encodeToString(cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP)).commit()) throw new IllegalStateException("凭据未能保存");
    }
    synchronized JSONObject load(String profile) throws Exception {
        String iv = preferences.getString("iv", null), value = preferences.getString("value", null);
        if (iv == null || value == null) return new JSONObject();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        JSONObject data = new JSONObject(new String(cipher.doFinal(Base64.decode(value, Base64.NO_WRAP)), StandardCharsets.UTF_8));
        if (!profile.equals(data.optString("profile"))) throw new IllegalStateException("账号已切换");
        return data;
    }
    synchronized void clear() { preferences.edit().clear().commit(); }
}
