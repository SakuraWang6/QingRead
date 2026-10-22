package app.qingread.android.background;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** One native source request at a time across downloads and update checks. Redirects never carry credentials. */
final class BackgroundHTTP {
    static final class AuthenticationRequired extends IOException { AuthenticationRequired(){super("登录已失效，请打开应用重新登录");} }
    static final class RateLimited extends IOException { RateLimited(){super("请求较多，请稍后继续");} }
    private static final Semaphore REQUESTS = new Semaphore(1,true);
    private volatile HttpURLConnection connection;
    private volatile boolean cancelled;
    void cancel() { cancelled=true;HttpURLConnection current=connection;if(current!=null)current.disconnect(); }
    Object post(String apiBase,String path,JSONObject body,JSONObject credentials) throws Exception {
        if(cancelled||!REQUESTS.tryAcquire(30,TimeUnit.SECONDS))throw new IOException("网络繁忙，请稍后继续");
        try {
            if(cancelled||Thread.currentThread().isInterrupted())throw new InterruptedException();
            HttpURLConnection request=(HttpURLConnection)new URL(BackgroundPolicy.apiBase(apiBase)+path).openConnection();connection=request;
            request.setInstanceFollowRedirects(false);request.setConnectTimeout(15000);request.setReadTimeout(45000);request.setRequestMethod("POST");request.setDoOutput(true);request.setRequestProperty("Content-Type","application/json");request.setRequestProperty("Accept","application/json");
            String access=credentials.optString("accessToken"),auth=credentials.optString("authToken");
            if(!access.isEmpty())request.setRequestProperty("X-QingRead-Token",access);if(!auth.isEmpty())request.setRequestProperty("Authorization","Bearer "+auth);
            byte[] payload=body.toString().getBytes(StandardCharsets.UTF_8);request.setFixedLengthStreamingMode(payload.length);
            try(java.io.OutputStream output=request.getOutputStream()){output.write(payload);}
            int status=request.getResponseCode();if(status==401||status==403)throw new AuthenticationRequired();if(status==429)throw new RateLimited();if(status!=200)throw new IOException("书源请求未完成（"+status+"）");
            ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int max=path.equals("/chapters")?8*1024*1024:1024*1024;
            try(InputStream input=request.getInputStream()){int count;while((count=input.read(buffer))!=-1){if(cancelled||Thread.currentThread().isInterrupted())throw new InterruptedException();if(output.size()+count>max)throw new IOException("响应内容过大");output.write(buffer,0,count);}}
            String json=output.toString("UTF-8");return path.equals("/chapters")?new org.json.JSONArray(json):new JSONObject(json);
        }finally{HttpURLConnection current=connection;connection=null;if(current!=null)current.disconnect();REQUESTS.release();}
    }
}
