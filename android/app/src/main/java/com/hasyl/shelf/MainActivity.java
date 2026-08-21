package com.hasyl.shelf;

import android.os.Bundle;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean readerSelectionMenuSuppressed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(ReaderSelectionPlugin.class);
        super.onCreate(savedInstanceState);
    }

    public void setReaderSelectionMenuSuppressed(boolean suppressed) {
        readerSelectionMenuSuppressed = suppressed;
    }

    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type) {
        if (!readerSelectionMenuSuppressed) return super.onWindowStartingActionMode(callback, type);
        return super.onWindowStartingActionMode(new ActionMode.Callback() {
            @Override
            public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                boolean created = callback.onCreateActionMode(mode, menu);
                menu.clear();
                return created;
            }

            @Override
            public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                callback.onPrepareActionMode(mode, menu);
                menu.clear();
                return true;
            }

            @Override
            public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                return false;
            }

            @Override
            public void onDestroyActionMode(ActionMode mode) {
                callback.onDestroyActionMode(mode);
            }
        }, type);
    }
}
