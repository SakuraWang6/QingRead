package app.qingread.android;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(QingReadSessionPlugin.class);
        registerPlugin(QingReadDevicePlugin.class);
        registerPlugin(app.qingread.android.background.QingReadBackgroundPlugin.class);
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
    }
}
