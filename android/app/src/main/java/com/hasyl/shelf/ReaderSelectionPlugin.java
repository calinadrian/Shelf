package com.hasyl.shelf;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ReaderSelection")
public class ReaderSelectionPlugin extends Plugin {
    @PluginMethod
    public void setSuppressed(PluginCall call) {
        final boolean shouldSuppress = Boolean.TRUE.equals(call.getBoolean("suppressed", false));
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).setReaderSelectionMenuSuppressed(shouldSuppress);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).setReaderSelectionMenuSuppressed(false);
        }
        super.handleOnDestroy();
    }
}
