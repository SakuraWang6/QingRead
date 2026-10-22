package app.qingread.android.background;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name="QingReadBackground",permissions={@Permission(alias="notifications",strings={Manifest.permission.POST_NOTIFICATIONS})})
public final class QingReadBackgroundPlugin extends Plugin {
    private static final String UPDATE_WORK="qingread-book-updates-v1";
    private interface Task { JSObject run() throws Exception; }
    private BackgroundStore store(){return BackgroundStore.get(getContext());}
    @Override public void load(){BackgroundNotifications.channels(getContext());}
    private void run(PluginCall call,Task task){execute(()->{try{call.resolve(task.run());}catch(Exception error){String message=error.getMessage();call.reject(message!=null&&message.length()<300?message:"后台操作未完成，请重试");}});}
    private String profile(PluginCall call){String profile=call.getString("profile");store().requireProfile(profile);return profile;}
    private void startDownloads(String profile,String id){
        try{ContextCompat.startForegroundService(getContext(),new Intent(getContext(),QingReadDownloadService.class).setAction(QingReadDownloadService.ACTION_RUN).putExtra("profile",profile));}
        catch(RuntimeException error){store().status(profile,id,"paused","系统暂不允许后台下载，请在应用内点击继续");throw new IllegalStateException("请在应用内点击继续下载");}
    }
    @PluginMethod public void setProfile(PluginCall call){run(call,()->{
        String next=call.getString("profile");boolean different=next==null?!store().activeProfile().isEmpty():!next.equals(store().activeProfile());
        store().activate(next,call.getString("apiBase"));
        if(different){QingReadDownloadService.interruptRequest();getContext().stopService(new Intent(getContext(),QingReadDownloadService.class));getContext().getSystemService(NotificationManager.class).cancelAll();new BackgroundSecrets(getContext()).clear();WorkManager.getInstance(getContext()).cancelUniqueWork(UPDATE_WORK);}
        if(next!=null&&!next.isEmpty()){new BackgroundSecrets(getContext()).save(next,call.getString("accessToken",""),call.getString("authToken",""));if(store().notificationsEnabled(next))scheduleUpdates();}
        return new JSObject();
    });}
    @PluginMethod public void enqueue(PluginCall call){run(call,()->{String profile=profile(call);JSONObject job=store().enqueue(profile,call.getObject("job"));startDownloads(profile,job.getString("id"));return new JSObject().put("job",job);});}
    @PluginMethod public void list(PluginCall call){run(call,()->new JSObject().put("jobs",store().list(profile(call))));}
    @PluginMethod public void pause(PluginCall call){run(call,()->{String profile=profile(call),id=call.getString("id");JSONObject job=store().job(profile,id);if(job!=null&&(job.optString("status").equals("running")||job.optString("status").equals("queued"))){store().status(profile,id,"paused",null);if(job.optString("status").equals("running"))QingReadDownloadService.interruptRequest();}return new JSObject();});}
    @PluginMethod public void resume(PluginCall call){run(call,()->{String profile=profile(call),id=call.getString("id");store().resume(profile,id);startDownloads(profile,id);return new JSObject();});}
    @PluginMethod public void cancel(PluginCall call){run(call,()->{String profile=profile(call),id=call.getString("id");JSONObject job=store().job(profile,id);if(job!=null){store().status(profile,id,"cancelled",null);if(job.optString("status").equals("running"))QingReadDownloadService.interruptRequest();}return new JSObject();});}
    @PluginMethod public void removeBook(PluginCall call){run(call,()->{String profile=profile(call);String bookID=call.getString("bookID");if(bookID==null||bookID.isEmpty())throw new IllegalArgumentException("书籍标识无效");store().clear(profile,bookID);QingReadDownloadService.interruptRequest();return new JSObject();});}
    @PluginMethod public void clearCache(PluginCall call){run(call,()->{store().clear(profile(call),null);QingReadDownloadService.interruptRequest();return new JSObject();});}
    @PluginMethod public void readCompleted(PluginCall call){run(call,()->new JSObject().put("items",store().readCompleted(profile(call),call.getInt("limit",20))));}
    @PluginMethod public void acknowledge(PluginCall call){run(call,()->{JSONArray ids=call.getArray("ids");if(ids==null||ids.length()>500)throw new IllegalArgumentException("暂存记录范围无效");store().acknowledge(profile(call),ids);return new JSObject();});}
    @PluginMethod public void replaceWatchedBooks(PluginCall call){run(call,()->{String profile=profile(call);JSONArray books=call.getArray("books");if(books==null)throw new IllegalArgumentException("书架无效");boolean enabled=Boolean.TRUE.equals(call.getBoolean("enabled",false));store().replaceWatches(profile,enabled,books);if(enabled)scheduleUpdates();else WorkManager.getInstance(getContext()).cancelUniqueWork(UPDATE_WORK);return new JSObject();});}
    @PluginMethod public void updates(PluginCall call){run(call,()->new JSObject().put("updates",store().updates(profile(call))));}
    private void scheduleUpdates(){
        Constraints constraints=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).build();
        PeriodicWorkRequest request=new PeriodicWorkRequest.Builder(QingReadUpdateWorker.class,1,TimeUnit.HOURS).setConstraints(constraints).build();
        WorkManager.getInstance(getContext()).enqueueUniquePeriodicWork(UPDATE_WORK,ExistingPeriodicWorkPolicy.KEEP,request);
    }
    private void notificationResult(PluginCall call){
        String permission;
        if(BackgroundNotifications.allowed(getContext()))permission="granted";
        else if(Build.VERSION.SDK_INT>=33&&(getPermissionState("notifications")==PermissionState.PROMPT||getPermissionState("notifications")==PermissionState.PROMPT_WITH_RATIONALE))permission="prompt";
        else permission="denied";
        call.resolve(new JSObject().put("notifications",permission));
    }
    @PluginMethod public void checkNotificationPermission(PluginCall call){notificationResult(call);}
    @PluginMethod public void requestNotificationPermission(PluginCall call){if(Build.VERSION.SDK_INT<33||BackgroundNotifications.allowed(getContext()))notificationResult(call);else requestPermissionForAlias("notifications",call,"notificationsResult");}
    @PermissionCallback private void notificationsResult(PluginCall call){notificationResult(call);}
}
