package app.qingread.android.background;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.ServiceCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** User-started data transfer; no sticky restart, boot receiver, or hidden keepalive. */
public final class QingReadDownloadService extends Service {
    public static final String ACTION_RUN="app.qingread.DOWNLOAD",ACTION_PAUSE="app.qingread.DOWNLOAD_PAUSE";
    private static volatile QingReadDownloadService current;
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private volatile BackgroundHTTP request;
    private volatile boolean stopped,running;
    private boolean finishedNormally;
    private BackgroundStore store;
    private PowerManager.WakeLock wakeLock;
    private String profile="";
    private int lastStartID;
    static void interruptRequest() { QingReadDownloadService service=current;if(service!=null){BackgroundHTTP active=service.request;if(active!=null)active.cancel();} }
    @Override public void onCreate() {
        super.onCreate();store=BackgroundStore.get(this);current=this;BackgroundNotifications.channels(this);
        PowerManager power=(PowerManager)getSystemService(Context.POWER_SERVICE);wakeLock=power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"QingRead:chapter-download");wakeLock.setReferenceCounted(false);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startID) {
        lastStartID=startID;
        if(intent==null){stopSelf(startID);return START_NOT_STICKY;}
        String requested=intent.getStringExtra("profile");
        if(requested==null||!requested.equals(store.activeProfile())){stopSelf(startID);return START_NOT_STICKY;}
        profile=requested;
        if(ACTION_PAUSE.equals(intent.getAction())){String id=intent.getStringExtra("id");if(id!=null)store.status(profile,id,"paused",null);interruptRequest();if(!running){stopSelf(startID);}return START_NOT_STICKY;}
        try {
            ServiceCompat.startForeground(this,BackgroundNotifications.DOWNLOAD_ID,BackgroundNotifications.progress(this,profile,null),Build.VERSION.SDK_INT>=29?ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC:0);
        }catch(RuntimeException denied){store.pauseAll(profile,"系统暂不允许后台下载，请打开应用重试");stopSelf(startID);return START_NOT_STICKY;}
        startRunner();return START_NOT_STICKY;
    }
    private void startRunner() {
        if(running||stopped)return;running=true;finishedNormally=false;
        executor.execute(()->{
            try {
                while(!stopped&&!Thread.currentThread().isInterrupted()&&profile.equals(store.activeProfile())){
                    String id=store.nextQueued(profile);if(id==null)break;
                    JSONObject job=store.job(profile,id);if(job==null)continue;
                    JSONObject book=job.getJSONObject("book");store.status(profile,id,"running",null);request=new BackgroundHTTP();int consecutiveFailures=0;
                    while(!stopped&&store.running(profile,id)){
                        JSONObject task=store.nextTask(profile,id);if(task==null)break;
                        if(!wakeLock.isHeld())wakeLock.acquire(10*60*1000L);
                        JSONObject chapter=task.getJSONObject("chapter");int attempts=task.optInt("attempts")+1;
                        try {
                            JSONObject body=new JSONObject().put("book",book).put("chapter",chapter);
                            JSONObject content=(JSONObject)request.post(store.apiBase(profile),"/content",body,new BackgroundSecrets(this).load(profile));
                            if(content.optJSONArray("paragraphs")==null||content.getJSONArray("paragraphs").length()==0)throw new IllegalStateException("章节正文为空");
                            // The requested chapter is authoritative; foreign chapter IDs cannot poison the cache.
                            content.put("chapter",chapter);if(!store.complete(profile,id,book,chapter,content))break;consecutiveFailures=0;
                            if(!BackgroundPolicy.awaitNextChapter(()->!stopped&&!Thread.currentThread().isInterrupted()&&store.running(profile,id),Thread::sleep))break;
                        }catch(InterruptedException interrupted){Thread.currentThread().interrupt();break;
                        }catch(Exception error){
                            if(stopped||!store.running(profile,id))break;
                            String message=error.getMessage();if(message==null||message.length()>200)message="下载未完成，请稍后重试";
                            if(error instanceof BackgroundHTTP.AuthenticationRequired||error instanceof BackgroundHTTP.RateLimited){store.pauseAll(profile,message);break;}
                            store.failure(profile,id,chapter.getString("id"),attempts,message);if(attempts>=3&&++consecutiveFailures>=2){store.status(profile,id,"paused","书源暂时不可用，请稍后继续");break;}
                            if(attempts<3)try{Thread.sleep(1000L*attempts);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();break;}
                        }
                        JSONObject progress=store.snapshot(profile,id);
                        ServiceCompat.startForeground(this,BackgroundNotifications.DOWNLOAD_ID,BackgroundNotifications.progress(this,profile,progress),Build.VERSION.SDK_INT>=29?ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC:0);
                    }
                    synchronized(store){
                        if(store.running(profile,id)&&!stopped&&!Thread.currentThread().isInterrupted()&&store.nextTask(profile,id)==null){
                            boolean failed=store.hasFailures(profile,id);store.status(profile,id,failed?"failed":"completed",failed?"部分章节未能下载，可重试":null);
                            JSONObject progress=store.snapshot(profile,id);store.notifyIfActive(profile,()->BackgroundNotifications.finished(this,book.optString("title"),progress.optInt("completed"),progress.optInt("total")));
                        }else if(store.running(profile,id)){
                            // Service destruction can race its worker before onDestroy pauses the store.
                            store.status(profile,id,"paused","后台下载已中断，请继续下载");
                        }
                    }
                    request=null;
                }
            }catch(Exception error){if(!stopped)store.pauseAll(profile,"后台下载已暂停，请打开应用继续");}
            finally {
                if(wakeLock.isHeld())wakeLock.release();
                main.post(()->{running=false;if(stopped)return;if(profile.equals(store.activeProfile())&&store.nextQueued(profile)!=null)startRunner();else{finishedNormally=true;stopForeground(STOP_FOREGROUND_REMOVE);stopSelf(lastStartID);}});
            }
        });
    }
    /** Android 15+ requires stopping promptly when the dataSync budget expires. */
    @Override public void onTimeout(int startID,int foregroundServiceType) {
        store.pauseAll(profile,"系统后台下载时限已到，请打开应用继续");stopped=true;interruptRequest();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf(startID);
    }
    @Override public void onDestroy() {
        stopped=true;interruptRequest();executor.shutdownNow();if(!finishedNormally)store.pauseAll(profile,"后台下载已中断，请继续下载");if(wakeLock!=null&&wakeLock.isHeld())wakeLock.release();if(current==this)current=null;super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
