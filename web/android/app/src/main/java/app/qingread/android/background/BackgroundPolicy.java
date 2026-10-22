package app.qingread.android.background;

import java.net.URI;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.BooleanSupplier;

/** Pure rules shared by the service/worker; no Android or network dependencies. */
public final class BackgroundPolicy {
    private BackgroundPolicy() {}
    @FunctionalInterface public interface Pauser { void pause(long millis) throws InterruptedException; }
    /** Pace successful cache hits too, and notice user pause/cancel within 100ms. */
    public static boolean awaitNextChapter(BooleanSupplier active, Pauser pauser) throws InterruptedException {
        for (int elapsed = 0; elapsed < 1000; elapsed += 100) {
            if (!active.getAsBoolean()) return false;
            pauser.pause(100);
        }
        return active.getAsBoolean();
    }
    public static String apiBase(String value) {
        URI uri = URI.create(value == null ? "" : value.trim());
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getUserInfo() != null
            || uri.getRawQuery() != null || uri.getRawFragment() != null
            || host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || host.equals("[::1]") || host.equals("::1")) {
            throw new IllegalArgumentException("需要有效的 HTTPS 服务器地址");
        }
        return uri.toString().replaceAll("/+$", "");
    }
    public static String title(String value) {
        return Normalizer.normalize(value == null ? "" : value, Normalizer.Form.NFKC)
            .toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]", "");
    }
    public static final class Chapter {
        public final String id, title;
        public Chapter(String id, String title) { this.id = id; this.title = title; }
    }
    /** Only an unambiguous old tail anchor establishes new appended chapters. */
    public static List<String> appended(String lastID, String lastTitle, List<Chapter> chapters) {
        int match = -1, count = 0;
        if (lastID != null && !lastID.isEmpty()) for (int i = 0; i < chapters.size(); i++) {
            if (lastID.equals(chapters.get(i).id)) { match = i; count++; }
        }
        if (count != 1) {
            match = -1; count = 0; String normalized = title(lastTitle);
            if (!normalized.isEmpty()) for (int i = 0; i < chapters.size(); i++) {
                if (normalized.equals(title(chapters.get(i).title))) { match = i; count++; }
            }
        }
        List<String> result = new ArrayList<>();
        if (count == 1) for (int i = match + 1; i < chapters.size(); i++) result.add(chapters.get(i).id);
        return result;
    }
}
