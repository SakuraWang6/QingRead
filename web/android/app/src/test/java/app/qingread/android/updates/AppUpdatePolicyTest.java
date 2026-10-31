package app.qingread.android.updates;

import static org.junit.Assert.*;
import org.junit.Test;

public class AppUpdatePolicyTest {
    private final String hash = new String(new char[64]).replace('\0', 'a');
    private String check(String base, String url, String version, long size, String digest, long build, long installed) {
        return AppUpdatePolicy.downloadURL(base, url, version, size, digest, build, "0.12.1", installed);
    }
    @Test public void acceptsOnlyFixedVersionSameOriginUpdate() {
        String url = "https://read.example/downloads/QingRead-Android-0.12.2.apk";
        assertEquals(url, check("https://read.example/api", url, "0.12.2", 7000000, hash, 14, 13));
        assertEquals(url, check("https://read.example:443/api", url, "0.12.2", 7000000, hash, 14, 13));
    }
    @Test public void rejectsUntrustedAndMutableDownloadLocations() {
        String base = "https://read.example/api";
        for (String url : new String[]{"http://read.example/downloads/QingRead-Android-0.12.2.apk", "https://elsewhere.example/downloads/QingRead-Android-0.12.2.apk",
            "https://read.example:8443/downloads/QingRead-Android-0.12.2.apk", "https://user:pass@read.example/downloads/QingRead-Android-0.12.2.apk",
            "https://read.example/downloads/QingRead-Android-latest.apk", "https://read.example/downloads/QingRead-Android-0.12.1.apk",
            "https://read.example/downloads/../downloads/QingRead-Android-0.12.2.apk", "https://read.example/downloads/%51ingRead-Android-0.12.2.apk",
            "https://read.example/downloads/QingRead-Android-0.12.2.apk?token=secret", "https://read.example/downloads/QingRead-Android-0.12.2.apk#frag"}) {
            try { check(base, url, "0.12.2", 7000000, hash, 14, 13); fail(url); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void rejectsInvalidMetadataAndDowngrades() {
        String base = "https://read.example/api", url = "https://read.example/downloads/QingRead-Android-0.12.2.apk";
        for (long size : new long[]{0, -1, AppUpdatePolicy.MAX_BYTES + 1}) {
            try { check(base, url, "0.12.2", size, hash, 14, 13); fail(); } catch (IllegalArgumentException expected) { }
        }
        for (long build : new long[]{0, 12, 13, (long) Integer.MAX_VALUE + 1}) {
            try { check(base, url, "0.12.2", 7000000, hash, build, 13); fail(); } catch (IllegalArgumentException expected) { }
        }
        for (String value : new String[]{"", "abc", hash + "a"}) {
            try { check(base, url, "0.12.2", 7000000, value, 14, 13); fail(); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void rejectsCredentialAndLocalServerBases() {
        for (String base : new String[]{"http://read.example/api", "https://localhost/api", "https://127.0.0.1/api", "https://[::1]/api", "https://user:pass@read.example/api", "https://read.example/api?secret=x"}) {
            try { check(base, "https://read.example/downloads/QingRead-Android-0.12.2.apk", "0.12.2", 7000000, hash, 14, 13); fail(base); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void forbidsSemanticDowngradeEvenWithAHigherBuild() {
        assertFalse(AppUpdatePolicy.newerVersion("0.12.0", 50, "0.12.1", 13));
        assertTrue(AppUpdatePolicy.newerVersion("0.12.1", 14, "0.12.1", 13));
        assertFalse(AppUpdatePolicy.newerVersion("0.13.0", 12, "0.12.1", 13));
    }
    @Test public void rejectsLoopbackRepresentationsWithMatchingOrigins() {
        for (String host : new String[]{"localhost", "127.0.0.2", "[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "2130706433", "[::]"}) {
            try { check("https://" + host + "/api", "https://" + host + "/downloads/QingRead-Android-0.12.2.apk", "0.12.2", 7000000, hash, 14, 13); fail(host); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void preservesExactCurrentSignerSet() {
        assertTrue(AppUpdatePolicy.sameSigners(new String[]{"b", "a"}, new String[]{"a", "b"}));
        assertFalse(AppUpdatePolicy.sameSigners(new String[]{"a"}, new String[]{"b"}));
        assertFalse(AppUpdatePolicy.sameSigners(new String[]{"a"}, new String[]{"a", "b"}));
        assertFalse(AppUpdatePolicy.sameSigners(new String[0], new String[0]));
        assertFalse(AppUpdatePolicy.sameSigners(null, new String[]{"a"}));
    }
    @Test public void limitsBridgeToBundledTopLevelPage() {
        assertTrue(AppUpdatePolicy.trustedPage("https://localhost/"));
        assertTrue(AppUpdatePolicy.trustedPage("https://localhost/index.html#settings"));
        for (String value : new String[]{"http://localhost/", "https://localhost:8443/", "https://localhost.evil/", "https://localhost/book.html", "https://evil/", "https://x@localhost/"}) assertFalse(value, AppUpdatePolicy.trustedPage(value));
    }
}
