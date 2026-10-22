package app.qingread.android.background;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Deferred local update checks. It does not require an open WebView or a push provider. */
public final class QingReadUpdateWorker extends Worker {
    private final BackgroundHTTP request=new BackgroundHTTP();
    public QingReadUpdateWorker(@NonNull Context context,@NonNull WorkerParameters parameters){super(context,parameters);}
    @NonNull @Override public Result doWork(){
        BackgroundStore store=BackgroundStore.get(getApplicationContext());String profile=store.activeProfile();
        if(profile.isEmpty()||!store.notificationsEnabled(profile))return Result.success();
        long deadline=System.currentTimeMillis()+8*60*1000;
        try {
            JSONArray saved=store.watches(profile);List<JSONObject> watches=new ArrayList<>();for(int i=0;i<saved.length();i++)watches.add(saved.getJSONObject(i));
            watches.sort(Comparator.comparing(value->value.optJSONObject("baseline").optString("checkedAt")));
            for(JSONObject watch:watches){
                if(isStopped()||System.currentTimeMillis()>deadline||!store.notificationsEnabled(profile))break;
                JSONObject book=watch.getJSONObject("book"),baseline=watch.getJSONObject("baseline");String bookID=book.getString("id");
                long previousAttempt=baseline.optLong("nativeAttemptAt",0);if(System.currentTimeMillis()-previousAttempt<15*60*1000)continue;
                baseline.put("nativeAttemptAt",System.currentTimeMillis());store.saveUpdate(profile,bookID,book,baseline);
                try {
                    JSONArray chapters=(JSONArray)request.post(store.apiBase(profile),"/chapters",new JSONObject().put("book",book),new BackgroundSecrets(getApplicationContext()).load(profile));if(chapters.length()==0)throw new IllegalStateException("目录为空");
                    if(isStopped()||!profile.equals(store.activeProfile()))break;
                    JSONObject current=store.watch(profile,bookID);if(current==null||!current.getJSONObject("book").optString("sourceID").equals(book.optString("sourceID"))||!current.getJSONObject("book").optString("url").equals(book.optString("url")))continue;
                    List<BackgroundPolicy.Chapter> markers=new ArrayList<>();for(int i=0;i<chapters.length();i++){JSONObject chapter=chapters.getJSONObject(i);markers.add(new BackgroundPolicy.Chapter(chapter.getString("id"),chapter.getString("title")));}
                    List<String> appended=BackgroundPolicy.appended(baseline.optString("lastKnownChapterID"),baseline.optString("lastKnownChapterTitle"),markers);
                    Set<String> unread=BackgroundStore.strings(baseline.optJSONArray("unreadChapterIDs"));unread.addAll(appended);String read=current.optString("readChapterID");int readIndex=-1;for(int i=0;i<markers.size();i++)if(markers.get(i).id.equals(read))readIndex=i;
                    JSONArray remaining=new JSONArray();for(int i=Math.max(0,readIndex+1);i<markers.size();i++)if(unread.contains(markers.get(i).id))remaining.put(markers.get(i).id);
                    JSONObject end=chapters.getJSONObject(chapters.length()-1);JSONObject updated=new JSONObject().put("knownChapterCount",chapters.length()).put("lastKnownChapterID",end.getString("id")).put("lastKnownChapterTitle",end.getString("title")).put("unreadChapterIDs",remaining).put("checkedAt",BackgroundStore.now()).put("nativeAttemptAt",System.currentTimeMillis());
                    store.saveUpdate(profile,bookID,book,updated);
                    int newUnread=0;Set<String> appendedIDs=new java.util.HashSet<>(appended);for(int i=0;i<remaining.length();i++)if(appendedIDs.contains(remaining.optString(i)))newUnread++;
                    final int count=newUnread;if(count>0)store.notifyIfActive(profile,()->{if(store.notificationsEnabled(profile))BackgroundNotifications.updates(getApplicationContext(),bookID,book.optString("title"),count);});
                }catch(Exception error){if(isStopped()||!profile.equals(store.activeProfile()))break;baseline.put("error","本次检查未完成");store.saveUpdate(profile,bookID,book,baseline);if(error instanceof BackgroundHTTP.AuthenticationRequired||error instanceof BackgroundHTTP.RateLimited)break;}
            }
        }catch(Exception error){return isStopped()?Result.success():Result.retry();}
        return Result.success();
    }
    @Override public void onStopped(){request.cancel();super.onStopped();}
}
