package app.qingread.android.updates;

/** Separate component so update grants never use the general sharing paths. */
public final class AppUpdateFileProvider extends androidx.core.content.FileProvider { }
