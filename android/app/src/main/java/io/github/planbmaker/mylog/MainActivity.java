package io.github.planbmaker.mylog;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MyLogNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
