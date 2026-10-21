package app.qingread.android;

import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "QingReadDevice")
public class QingReadDevicePlugin extends Plugin {
    @PluginMethod
    public void getBattery(PluginCall call) {
        Intent status = getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int level = status == null ? -1 : status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = status == null ? -1 : status.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        JSObject result = new JSObject();
        result.put("level", level >= 0 && scale > 0 ? Math.round(level * 100f / scale) : -1);
        call.resolve(result);
    }
}
