package app.qingread.android.background;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import app.qingread.android.MainActivity;
import app.qingread.android.R;
import org.json.JSONObject;

final class BackgroundNotifications {
    static final int DOWNLOAD_ID=7101;
    private static final String DOWNLOADS="qingread-downloads-v1",UPDATES="qingread-updates-v1";
    private BackgroundNotifications() {}
    static void channels(Context context) {
        if(Build.VERSION.SDK_INT>=26){NotificationManager manager=context.getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel(DOWNLOADS,"章节下载",NotificationManager.IMPORTANCE_LOW));manager.createNotificationChannel(new NotificationChannel(UPDATES,"书籍更新",NotificationManager.IMPORTANCE_DEFAULT));}
    }
    static boolean allowed(Context context) { return (Build.VERSION.SDK_INT<33||ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)&&context.getSystemService(NotificationManager.class).areNotificationsEnabled(); }
    private static PendingIntent open(Context context,String bookID) {
        Intent intent=new Intent(context,MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);if(bookID!=null)intent.putExtra("qingreadBookID",bookID);
        return PendingIntent.getActivity(context,bookID==null?0:bookID.hashCode(),intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    }
    static Notification progress(Context context,String profile,JSONObject job) {
        String id=job==null?"":job.optString("id"),title=job==null?"章节下载":job.optString("bookTitle"),bookID=job==null?null:job.optString("bookID");int completed=job==null?0:job.optInt("completed"),total=job==null?0:job.optInt("total");
        NotificationCompat.Builder builder=new NotificationCompat.Builder(context,DOWNLOADS).setSmallIcon(R.drawable.ic_qingread_notification).setContentTitle(title).setContentText(total>0?completed+" / "+total+" 章":"正在准备下载")
            .setContentIntent(open(context,bookID)).setProgress(Math.max(1,total),completed,total==0).setOngoing(true).setOnlyAlertOnce(true).setPriority(NotificationCompat.PRIORITY_LOW).setCategory(NotificationCompat.CATEGORY_PROGRESS);
        if(!id.isEmpty()){Intent pause=new Intent(context,QingReadDownloadService.class).setAction(QingReadDownloadService.ACTION_PAUSE).putExtra("profile",profile).putExtra("id",id);PendingIntent action=PendingIntent.getService(context,id.hashCode(),pause,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);builder.addAction(0,"暂停",action);}
        return builder.build();
    }
    static void finished(Context context,String title,int completed,int total) { if(!allowed(context))return;context.getSystemService(NotificationManager.class).notify(7102,new NotificationCompat.Builder(context,DOWNLOADS).setSmallIcon(R.drawable.ic_qingread_notification).setContentTitle(title).setContentText(completed==total?"章节已下载":"已下载 "+completed+" / "+total+" 章").setContentIntent(open(context,null)).setAutoCancel(true).build()); }
    static void updates(Context context,String bookID,String title,int count) { if(!allowed(context)||count<1)return;context.getSystemService(NotificationManager.class).notify(7200+(bookID.hashCode()&0x3fffffff),new NotificationCompat.Builder(context,UPDATES).setSmallIcon(R.drawable.ic_qingread_notification).setContentTitle(title).setContentText("更新 "+count+" 章").setContentIntent(open(context,bookID)).setAutoCancel(true).build()); }
}
