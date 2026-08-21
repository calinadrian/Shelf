package com.hasyl.shelf;

import android.os.Bundle;
import android.view.ActionMode;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean readerSelectionMenuSuppressed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(ReaderSelectionPlugin.class);
        registerPlugin(TextToSpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }

    public void setReaderSelectionMenuSuppressed(boolean suppressed) {
        readerSelectionMenuSuppressed = suppressed;
    }

    @SuppressWarnings("deprecation")
    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback) {
        if (readerSelectionMenuSuppressed) return null;
        return super.onWindowStartingActionMode(callback);
    }

    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type) {
        // Clearing WebView's menu after ActionMode is created is too late: the
        // floating toolbar can already be visible and WebView may repopulate it.
        // Refuse the native mode while Shelf's reader toolbar owns selection.
        if (readerSelectionMenuSuppressed) return null;
        return super.onWindowStartingActionMode(callback, type);
    }
}
