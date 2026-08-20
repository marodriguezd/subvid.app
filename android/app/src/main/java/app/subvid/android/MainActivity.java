package app.subvid.android;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        if (this.bridge != null && this.bridge.getWebView() != null) {
            WebView webView = this.bridge.getWebView();
            WebSettings settings = webView.getSettings();
            
            // Enable storage and DOM features for Transformers.js and Whisper models
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            
            // Enable file and content access for video/audio loading
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
            
            // Enable media playback without requiring direct user gesture per frame
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
    }
}
