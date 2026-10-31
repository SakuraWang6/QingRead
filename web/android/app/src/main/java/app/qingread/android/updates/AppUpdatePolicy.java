package app.qingread.android.updates;

import java.net.URI;
import java.net.InetAddress;
import java.util.Arrays;
import java.util.Locale;

/** Installation metadata policy; independent of Android for deterministic tests. */
public final class AppUpdatePolicy {
    public static final long MAX_BYTES = 100L * 1024 * 1024;
    public static final long MAX_DURATION_MS = 15L * 60 * 1000;
    private AppUpdatePolicy() {}

    public static String downloadURL(String apiBase, String value, String version, long size, String hash, long build, String installedVersion, long installedBuild) {
        try {
            if (apiBase == null || value == null || apiBase.length() > 4096 || value.length() > 4096 || version == null || !version.matches("(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})") || size < 1 || size > MAX_BYTES
                || hash == null || !hash.matches("[a-fA-F0-9]{64}") || !newerVersion(version, build, installedVersion, installedBuild) || build > Integer.MAX_VALUE) throw new IllegalArgumentException();
            URI base = new URI(apiBase), url = new URI(value);
            if (!https(base) || !https(url) || !base.getHost().equalsIgnoreCase(url.getHost()) || port(base) != port(url)
                || base.getRawQuery() != null || base.getRawFragment() != null
                || !url.getRawPath().equals("/downloads/QingRead-Android-" + version + ".apk")
                || url.getRawQuery() != null || url.getRawFragment() != null) throw new IllegalArgumentException();
            return url.toASCIIString();
        } catch (Exception error) { throw new IllegalArgumentException("更新安装包信息无效，请重新检查更新"); }
    }
    public static boolean newerVersion(String target, long build, String installed, long installedBuild) {
        if (build <= installedBuild || installed == null || !installed.matches("(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})")) return false;
        String[] left = target.split("\\."), right = installed.split("\\.");
        if (left.length != 3) return false;
        for (int i = 0; i < 3; i++) {
            long a = Long.parseLong(left[i]), b = Long.parseLong(right[i]);
            if (a != b) return a > b;
        }
        return true;
    }
    private static boolean https(URI value) {
        String host = value.getHost();
        return "https".equalsIgnoreCase(value.getScheme()) && host != null && value.getRawUserInfo() == null
            && !localHost(host)
            && (value.getPort() == -1 || value.getPort() > 0 && value.getPort() <= 65535);
    }
    private static boolean localHost(String host) {
        String value = host.toLowerCase(Locale.ROOT);
        if (value.equals("localhost") || value.endsWith(".localhost") || value.startsWith("127.") || value.equals("0.0.0.0") || value.matches("[0-9]+")) return true;
        if (value.indexOf(':') >= 0) {
            // The colon identifies an IPv6 literal; this parses it locally,
            // without making a DNS query for an arbitrary hostname.
            try { InetAddress address = InetAddress.getByName(value); return address.isLoopbackAddress() || address.isAnyLocalAddress(); }
            catch (Exception error) { return true; }
        }
        return false;
    }
    private static int port(URI value) { return value.getPort() < 0 ? 443 : value.getPort(); }
    public static boolean trustedPage(String value) {
        try {
            URI uri = new URI(value);
            return "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && port(uri) == 443
                && uri.getRawUserInfo() == null && ("/".equals(uri.getRawPath()) || "/index.html".equals(uri.getRawPath()));
        } catch (Exception error) { return false; }
    }
    public static boolean sameSigners(String[] installed, String[] archive) {
        if (installed == null || archive == null || installed.length == 0 || installed.length != archive.length) return false;
        String[] left = installed.clone(), right = archive.clone(); Arrays.sort(left); Arrays.sort(right);
        return Arrays.equals(left, right);
    }
}
