package app.qingread.android.background;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Private durable staging. The Web library acknowledges chapters only after IndexedDB saves them. */
final class BackgroundStore extends SQLiteOpenHelper {
    private static BackgroundStore instance;
    private final SharedPreferences preferences;
    static synchronized BackgroundStore get(Context context) {
        if (instance == null) instance = new BackgroundStore(context.getApplicationContext());
        return instance;
    }
    private BackgroundStore(Context context) {
        super(context, new java.io.File(context.getNoBackupFilesDir(), "qingread-background-v1.db").getAbsolutePath(), null, 1);
        preferences = context.getSharedPreferences("qingread-background", Context.MODE_PRIVATE);
        setWriteAheadLoggingEnabled(true);
        getWritableDatabase().execSQL("UPDATE jobs SET status='paused' WHERE status IN ('queued','running')");
    }
    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE profiles(profile TEXT PRIMARY KEY, api_base TEXT NOT NULL, notifications INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE jobs(profile TEXT NOT NULL,id TEXT NOT NULL,book_id TEXT NOT NULL,book TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(profile,id))");
        db.execSQL("CREATE TABLE tasks(profile TEXT NOT NULL,job_id TEXT NOT NULL,chapter_id TEXT NOT NULL,ordinal INTEGER NOT NULL,chapter TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(profile,job_id,chapter_id),FOREIGN KEY(profile,job_id) REFERENCES jobs(profile,id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE contents(id INTEGER PRIMARY KEY AUTOINCREMENT,profile TEXT NOT NULL,book_id TEXT NOT NULL,source_id TEXT NOT NULL,source_url TEXT NOT NULL,chapter_id TEXT NOT NULL,book TEXT NOT NULL,content TEXT NOT NULL,bytes INTEGER NOT NULL,UNIQUE(profile,book_id,source_id,source_url,chapter_id))");
        db.execSQL("CREATE INDEX contents_profile ON contents(profile,id)");
        db.execSQL("CREATE TABLE watches(profile TEXT NOT NULL,book_id TEXT NOT NULL,book TEXT NOT NULL,baseline TEXT NOT NULL,read_chapter TEXT,PRIMARY KEY(profile,book_id))");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { throw new IllegalStateException("Unsupported background database upgrade"); }
    static JSONObject json(String value) { try { return new JSONObject(value); } catch (JSONException error) { throw new IllegalStateException("后台记录无效", error); } }
    static String now() { return timestamp(System.currentTimeMillis()); }
    static String timestamp(long millis) { java.text.SimpleDateFormat format=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.ROOT);format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));return format.format(new java.util.Date(millis)); }
    synchronized void notifyIfActive(String profile, Runnable send) { if(profile.equals(activeProfile()))send.run(); }
    synchronized String activeProfile() { return preferences.getString("active", ""); }
    synchronized void requireProfile(String profile) {
        if (profile == null || profile.isEmpty() || !profile.equals(activeProfile())) throw new IllegalStateException("账号已切换");
    }
    synchronized String apiBase(String profile) {
        requireProfile(profile);
        try (Cursor c = getReadableDatabase().rawQuery("SELECT api_base FROM profiles WHERE profile=?", new String[]{profile})) {
            if (!c.moveToFirst()) throw new IllegalStateException("请先设置服务器");
            return c.getString(0);
        }
    }
    synchronized boolean activate(String profile, String apiBase) {
        String next = profile == null ? "" : profile;
        boolean changed = !next.equals(activeProfile());
        if (changed) pauseAll(null, "账号已切换");
        if (!next.isEmpty()) {
            if (next.length() > 8192) throw new IllegalArgumentException("账号标识过长");
            String base = BackgroundPolicy.apiBase(apiBase);
            ContentValues values = new ContentValues(); values.put("profile", next); values.put("api_base", base);
            getWritableDatabase().insertWithOnConflict("profiles", null, values, SQLiteDatabase.CONFLICT_IGNORE);
            getWritableDatabase().execSQL("UPDATE profiles SET api_base=? WHERE profile=?", new Object[]{base, next});
        }
        if (!preferences.edit().putString("active", next).commit()) throw new IllegalStateException("账号未能保存");
        return changed;
    }
    synchronized void recoverRunning(String profile) {
        getWritableDatabase().execSQL("UPDATE jobs SET status='paused',error='任务已中断，请继续下载' WHERE profile=? AND status='running'", new Object[]{profile});
    }
    static void validateBook(JSONObject book) {
        if (book == null || book.optString("id").isEmpty() || book.optString("sourceID").isEmpty() || book.optString("title").isEmpty()
            || book.optString("id").length() > 8192 || !book.optString("url").matches("https?://.+")
            || !book.optString("publicationFormat").isEmpty() || !book.optString("fileDownloadURL").isEmpty()
            || book.optString("sourceID").startsWith("local")) throw new IllegalArgumentException("此书无法下载章节");
    }
    synchronized JSONObject enqueue(String profile, JSONObject request) throws JSONException {
        requireProfile(profile); JSONObject book = request.getJSONObject("book"); validateBook(book);
        String id = request.getString("id"); JSONArray chapters = request.getJSONArray("chapters"), done = request.optJSONArray("completedChapterIDs");
        if (id.isEmpty() || id.length() > 256 || chapters.length() == 0 || chapters.length() > 50000) throw new IllegalArgumentException("下载范围无效");
        JSONObject existing = job(profile, id); if (existing != null) return snapshot(profile, id);
        Set<String> completed = strings(done), seen = new HashSet<>();
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            long stamp = System.currentTimeMillis();
            db.execSQL("INSERT INTO jobs(profile,id,book_id,book,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", new Object[]{profile,id,book.getString("id"),book.toString(),"queued",stamp,stamp});
            for (int i = 0; i < chapters.length(); i++) {
                JSONObject chapter = chapters.getJSONObject(i); String chapterID = chapter.getString("id");
                if (chapterID.isEmpty() || chapterID.length() > 8192 || !seen.add(chapterID)) throw new IllegalArgumentException("章节标识无效或重复");
                db.execSQL("INSERT INTO tasks(profile,job_id,chapter_id,ordinal,chapter,status) VALUES(?,?,?,?,?,?)", new Object[]{profile,id,chapterID,i,chapter.toString(),completed.contains(chapterID)?"completed":"pending"});
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        pruneHistory(profile); return snapshot(profile, id);
    }
    static Set<String> strings(JSONArray values) {
        Set<String> result = new HashSet<>(); if (values != null) for (int i = 0; i < values.length(); i++) result.add(values.optString(i)); return result;
    }
    synchronized JSONObject job(String profile, String id) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT book,status,error FROM jobs WHERE profile=? AND id=?", new String[]{profile,id})) {
            if (!c.moveToFirst()) return null;
            return json("{}").put("book",json(c.getString(0))).put("status",c.getString(1)).put("error",c.getString(2));
        } catch (JSONException error) { throw new IllegalStateException(error); }
    }
    synchronized JSONObject snapshot(String profile, String id) throws JSONException {
        JSONObject result;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT book,status,error,created_at,updated_at FROM jobs WHERE profile=? AND id=?", new String[]{profile,id})) {
            if (!c.moveToFirst()) throw new IllegalStateException("下载任务不存在");
            JSONObject book = json(c.getString(0));
            result = new JSONObject().put("id",id).put("bookID",book.getString("id")).put("bookTitle",book.getString("title"))
                .put("sourceID",book.getString("sourceID")).put("sourceURL",book.getString("url")).put("status",c.getString(1))
                .put("createdAt",timestamp(c.getLong(3))).put("updatedAt",timestamp(c.getLong(4)));
            if (!c.isNull(2)) result.put("error",c.getString(2));
        }
        JSONArray ids = new JSONArray(), completed = new JSONArray(), failed = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT chapter_id,status FROM tasks WHERE profile=? AND job_id=? ORDER BY ordinal", new String[]{profile,id})) {
            while (c.moveToNext()) { ids.put(c.getString(0)); if (c.getString(1).equals("completed")) completed.put(c.getString(0)); if (c.getString(1).equals("failed")) failed.put(c.getString(0)); }
        }
        return result.put("chapterIDs",ids).put("completedChapterIDs",completed).put("failedChapterIDs",failed).put("total",ids.length()).put("completed",completed.length());
    }
    synchronized JSONArray list(String profile) throws JSONException {
        requireProfile(profile); JSONArray jobs = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id FROM jobs WHERE profile=? ORDER BY created_at DESC",new String[]{profile})) { while (c.moveToNext()) jobs.put(snapshot(profile,c.getString(0))); }
        return jobs;
    }
    synchronized String nextQueued(String profile) {
        if (!profile.equals(activeProfile())) return null;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id FROM jobs WHERE profile=? AND status='queued' ORDER BY created_at LIMIT 1",new String[]{profile})) { return c.moveToFirst()?c.getString(0):null; }
    }
    synchronized boolean running(String profile, String id) { JSONObject job = job(profile,id); return profile.equals(activeProfile()) && job != null && job.optString("status").equals("running"); }
    synchronized void status(String profile, String id, String status, String error) {
        ContentValues values = new ContentValues(); values.put("status",status); values.put("updated_at",System.currentTimeMillis()); if (error == null) values.putNull("error"); else values.put("error",error);
        getWritableDatabase().update("jobs",values,"profile=? AND id=?",new String[]{profile,id}); pruneHistory(profile);
    }
    synchronized void resume(String profile, String id) {
        requireProfile(profile); JSONObject job = job(profile,id); if (job == null || !(job.optString("status").equals("paused")||job.optString("status").equals("failed"))) throw new IllegalStateException("任务无法继续");
        getWritableDatabase().execSQL("UPDATE tasks SET status='pending',attempts=0,error=NULL WHERE profile=? AND job_id=? AND status='failed'",new Object[]{profile,id}); status(profile,id,"queued",null);
    }
    synchronized JSONObject nextTask(String profile, String jobID) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT chapter,attempts FROM tasks WHERE profile=? AND job_id=? AND status='pending' ORDER BY ordinal LIMIT 1",new String[]{profile,jobID})) {
            return c.moveToFirst()?json("{}").put("chapter",json(c.getString(0))).put("attempts",c.getInt(1)):null;
        } catch (JSONException error) { throw new IllegalStateException(error); }
    }
    synchronized void failure(String profile, String jobID, String chapterID, int attempts, String error) {
        if (!running(profile,jobID)) return;
        getWritableDatabase().execSQL("UPDATE tasks SET attempts=?,status=?,error=? WHERE profile=? AND job_id=? AND chapter_id=?",new Object[]{attempts,attempts>=3?"failed":"pending",error,profile,jobID,chapterID});
    }
    synchronized boolean complete(String profile, String jobID, JSONObject book, JSONObject chapter, JSONObject content) throws JSONException {
        if (!running(profile,jobID)) return false;
        long used = 0; try (Cursor c = getReadableDatabase().rawQuery("SELECT COALESCE(SUM(bytes),0) FROM contents",null)) { if (c.moveToFirst()) used = c.getLong(0); }
        String data = content.toString(); int bytes = data.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if (used + bytes > 256L*1024*1024) { status(profile,jobID,"paused","后台暂存空间已满，请打开应用保存章节后继续"); return false; }
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            ContentValues row = new ContentValues(); row.put("profile",profile); row.put("book_id",book.getString("id")); row.put("source_id",book.getString("sourceID")); row.put("source_url",book.getString("url")); row.put("chapter_id",chapter.getString("id")); row.put("book",book.toString()); row.put("content",data); row.put("bytes",bytes);
            db.insertWithOnConflict("contents",null,row,SQLiteDatabase.CONFLICT_REPLACE);
            db.execSQL("UPDATE tasks SET status='completed',error=NULL WHERE profile=? AND job_id=? AND chapter_id=?",new Object[]{profile,jobID,chapter.getString("id")});
            db.execSQL("UPDATE jobs SET updated_at=? WHERE profile=? AND id=?",new Object[]{System.currentTimeMillis(),profile,jobID}); db.setTransactionSuccessful(); return true;
        } finally { db.endTransaction(); }
    }
    synchronized boolean hasFailures(String profile, String jobID) { try (Cursor c = getReadableDatabase().rawQuery("SELECT 1 FROM tasks WHERE profile=? AND job_id=? AND status='failed' LIMIT 1",new String[]{profile,jobID})) { return c.moveToFirst(); } }
    synchronized void pauseAll(String profile, String error) {
        ContentValues values = new ContentValues(); values.put("status","paused"); values.put("error",error); values.put("updated_at",System.currentTimeMillis());
        getWritableDatabase().update("jobs",values,"status IN ('running','queued')"+(profile==null?"":" AND profile=?"),profile==null?null:new String[]{profile});
    }
    synchronized JSONArray readCompleted(String profile, int limit) throws JSONException {
        requireProfile(profile); JSONArray result = new JSONArray();int bytes=0;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,book,content,bytes FROM contents WHERE profile=? ORDER BY id LIMIT ?",new String[]{profile,String.valueOf(Math.max(1,Math.min(limit,50)))})) {
            while (c.moveToNext()) {if(result.length()>0&&bytes+c.getInt(3)>2*1024*1024)break;bytes+=c.getInt(3);result.put(new JSONObject().put("id",String.valueOf(c.getLong(0))).put("book",json(c.getString(1))).put("content",json(c.getString(2))));}
        }
        return result;
    }
    synchronized void acknowledge(String profile, JSONArray ids) { requireProfile(profile); for (int i=0;i<ids.length();i++) getWritableDatabase().delete("contents","profile=? AND id=?",new String[]{profile,ids.optString(i)}); }
    synchronized void clear(String profile, String bookID) {
        requireProfile(profile); SQLiteDatabase db=getWritableDatabase(); db.beginTransaction();
        try {
            if (bookID == null) { db.execSQL("UPDATE jobs SET status='cancelled',error=NULL WHERE profile=? AND status NOT IN ('completed','cancelled')",new Object[]{profile}); db.delete("contents","profile=?",new String[]{profile}); }
            else { db.execSQL("UPDATE jobs SET status='cancelled',error=NULL WHERE profile=? AND book_id=? AND status NOT IN ('completed','cancelled')",new Object[]{profile,bookID}); db.delete("contents","profile=? AND book_id=?",new String[]{profile,bookID}); db.delete("watches","profile=? AND book_id=?",new String[]{profile,bookID}); }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        pruneHistory(profile);
    }
    private void pruneHistory(String profile) { getWritableDatabase().execSQL("DELETE FROM jobs WHERE profile=? AND status IN ('completed','cancelled','failed') AND id NOT IN (SELECT id FROM jobs WHERE profile=? AND status IN ('completed','cancelled','failed') ORDER BY updated_at DESC LIMIT 20)",new Object[]{profile,profile}); }
    synchronized boolean notificationsEnabled(String profile) {
        try (Cursor c=getReadableDatabase().rawQuery("SELECT notifications FROM profiles WHERE profile=?",new String[]{profile})) { return c.moveToFirst() && c.getInt(0)==1 && profile.equals(activeProfile()); }
    }
    synchronized void replaceWatches(String profile, boolean enabled, JSONArray books) throws JSONException {
        requireProfile(profile); if (books.length()>5000) throw new IllegalArgumentException("书架过大");
        SQLiteDatabase db=getWritableDatabase(); db.beginTransaction();
        try {
            db.execSQL("UPDATE profiles SET notifications=? WHERE profile=?",new Object[]{enabled?1:0,profile}); Set<String> keep=new HashSet<>();
            for (int i=0;i<books.length();i++) {
                JSONObject value=books.getJSONObject(i),book=value.getJSONObject("book"); validateBook(book); String bookID=book.getString("id");keep.add(bookID);
                JSONObject baseline=value.optJSONObject("baseline"),existing=watch(profile,bookID);
                if (baseline==null) baseline=new JSONObject().put("knownChapterCount",0).put("unreadChapterIDs",new JSONArray());
                if (existing!=null) { JSONObject oldBook=existing.getJSONObject("book");if (oldBook.optString("sourceID").equals(book.optString("sourceID"))&&oldBook.optString("url").equals(book.optString("url"))) { JSONObject previous=existing.getJSONObject("baseline");String previousDate=previous.optString("checkedAt"),incomingDate=baseline.optString("checkedAt"); if (previousDate.compareTo(incomingDate)>0) baseline=previous; } }
                String readID=value.optString("readChapterID");JSONArray unread=baseline.optJSONArray("unreadChapterIDs");if(unread!=null&&!readID.isEmpty()){int readIndex=-1;for(int j=0;j<unread.length();j++)if(readID.equals(unread.optString(j)))readIndex=j;if(readIndex>=0){JSONArray remaining=new JSONArray();for(int j=readIndex+1;j<unread.length();j++)remaining.put(unread.optString(j));baseline.put("unreadChapterIDs",remaining);}}
                ContentValues row=new ContentValues();row.put("profile",profile);row.put("book_id",bookID);row.put("book",book.toString());row.put("baseline",baseline.toString());row.put("read_chapter",readID);db.insertWithOnConflict("watches",null,row,SQLiteDatabase.CONFLICT_REPLACE);
            }
            try (Cursor c=db.rawQuery("SELECT book_id FROM watches WHERE profile=?",new String[]{profile})) { while(c.moveToNext())if(!keep.contains(c.getString(0)))db.delete("watches","profile=? AND book_id=?",new String[]{profile,c.getString(0)}); }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    synchronized JSONObject watch(String profile,String bookID) throws JSONException {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT book,baseline,read_chapter FROM watches WHERE profile=? AND book_id=?",new String[]{profile,bookID})) {return c.moveToFirst()?new JSONObject().put("book",json(c.getString(0))).put("baseline",json(c.getString(1))).put("readChapterID",c.getString(2)):null;}
    }
    synchronized JSONArray watches(String profile) throws JSONException { JSONArray result=new JSONArray();try(Cursor c=getReadableDatabase().rawQuery("SELECT book_id FROM watches WHERE profile=?",new String[]{profile})){while(c.moveToNext())result.put(watch(profile,c.getString(0)));}return result; }
    synchronized void saveUpdate(String profile,String bookID,JSONObject book,JSONObject baseline) throws JSONException {
        if(!notificationsEnabled(profile))return;JSONObject current=watch(profile,bookID);if(current==null)return;JSONObject currentBook=current.getJSONObject("book");if(!currentBook.optString("sourceID").equals(book.optString("sourceID"))||!currentBook.optString("url").equals(book.optString("url")))return;
        ContentValues values=new ContentValues();values.put("baseline",baseline.toString());getWritableDatabase().update("watches",values,"profile=? AND book_id=?",new String[]{profile,bookID});
    }
    synchronized JSONObject updates(String profile) throws JSONException { requireProfile(profile);JSONObject result=new JSONObject();JSONArray values=watches(profile);for(int i=0;i<values.length();i++){JSONObject value=values.getJSONObject(i);result.put(value.getJSONObject("book").getString("id"),value.getJSONObject("baseline"));}return result; }
}
