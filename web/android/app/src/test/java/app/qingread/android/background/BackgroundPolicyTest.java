package app.qingread.android.background;

import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class BackgroundPolicyTest {
    @Test public void pacesEvenImmediatelySuccessfulChapters() throws InterruptedException {
        long[] waited={0};
        assertTrue(BackgroundPolicy.awaitNextChapter(()->true,millis->waited[0]+=millis));
        assertEquals(1000L,waited[0]);
    }
    @Test public void stopsPacingPromptlyAfterPauseOrCancellation() throws InterruptedException {
        long[] waited={0};
        assertFalse(BackgroundPolicy.awaitNextChapter(()->waited[0]<300,millis->waited[0]+=millis));
        assertEquals(300L,waited[0]);
        assertFalse(BackgroundPolicy.awaitNextChapter(()->false,millis->fail("An inactive job must not wait")));
    }
    @Test public void preservesServiceShutdownInterruptions() {
        try {
            BackgroundPolicy.awaitNextChapter(()->true,millis->{throw new InterruptedException("shutdown");});
            fail("Service shutdown must interrupt pacing");
        } catch(InterruptedException expected) {
            assertEquals("shutdown",expected.getMessage());
        }
    }
    @Test public void rejectsCredentialAndLoopbackEndpointsBeforeNativeNetworkAccess() {
        for(String value:Arrays.asList("http://books.example/api","https://localhost/api","https://127.0.0.1/api","https://[::1]/api","https://user:password@books.example/api","https://books.example/api?token=secret")){
            try{BackgroundPolicy.apiBase(value);fail(value);}catch(IllegalArgumentException expected){/* invalid configuration is rejected */}
        }
        assertEquals("https://books.example/api",BackgroundPolicy.apiBase("https://books.example/api/"));
        assertEquals("https://books.example:8443/qingread/api",BackgroundPolicy.apiBase("https://books.example:8443/qingread/api"));
    }
    @Test public void firstUncachedCheckDoesNotNotifyTheEntireBook() {
        assertEquals(Collections.emptyList(),BackgroundPolicy.appended("","",Arrays.asList(new BackgroundPolicy.Chapter("a","第一章"),new BackgroundPolicy.Chapter("b","第二章"))));
    }
    @Test public void recognizesOnlyAnUnambiguousTailAndPreservesAppendOrder() {
        assertEquals(Arrays.asList("c","d"),BackgroundPolicy.appended("b","第２章 继续",Arrays.asList(new BackgroundPolicy.Chapter("a","第一章"),new BackgroundPolicy.Chapter("b","第二章"),new BackgroundPolicy.Chapter("c","第三章"),new BackgroundPolicy.Chapter("d","第四章"))));
        assertEquals(Arrays.asList("c"),BackgroundPolicy.appended("old-id","第２章　继续！",Arrays.asList(new BackgroundPolicy.Chapter("b","第2章 继续"),new BackgroundPolicy.Chapter("c","第三章"))));
        assertEquals(Collections.emptyList(),BackgroundPolicy.appended("missing","第二章",Arrays.asList(new BackgroundPolicy.Chapter("b","第二章"),new BackgroundPolicy.Chapter("c","第二章"),new BackgroundPolicy.Chapter("d","第三章"))));
        assertEquals(Collections.emptyList(),BackgroundPolicy.appended("missing","消失的末章",Arrays.asList(new BackgroundPolicy.Chapter("b","第二章"),new BackgroundPolicy.Chapter("c","第三章"))));
    }
}
