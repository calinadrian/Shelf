package com.hasyl.shelf;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name = "ShelfTextToSpeech")
public class TextToSpeechPlugin extends Plugin {
    private static final int SPEECH_CHUNK_CHARACTERS = 700;
    private static final long ENGINE_TIMEOUT_SECONDS = 15;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final CompletableFuture<TextToSpeech> engineReady = new CompletableFuture<>();
    private final AtomicInteger playbackGeneration = new AtomicInteger();
    private final Object stateLock = new Object();
    private volatile TextToSpeech engine;
    private volatile boolean paused;
    private List<String> activeChunks = Collections.emptyList();
    private int activeChunkIndex;
    private float activeRate = 1f;

    @Override
    public void load() {
        cleanupLegacyKokoro();
        engine = new TextToSpeech(getContext(), status -> {
            if (status != TextToSpeech.SUCCESS) {
                engineReady.completeExceptionally(new IllegalStateException("Android's speech service could not start"));
                return;
            }
            TextToSpeech ready = engine;
            int language = ready.setLanguage(Locale.getDefault());
            if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) ready.setLanguage(Locale.US);
            selectBestOfflineVoice(ready);
            ready.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    Utterance utterance = parseUtterance(utteranceId);
                    if (utterance == null || utterance.generation != playbackGeneration.get()) return;
                    synchronized (stateLock) { activeChunkIndex = utterance.index; }
                    emitState("speaking", null);
                }

                @Override
                public void onDone(String utteranceId) {
                    Utterance utterance = parseUtterance(utteranceId);
                    if (utterance == null || utterance.generation != playbackGeneration.get()) return;
                    synchronized (stateLock) { activeChunkIndex = Math.min(utterance.index + 1, activeChunks.size()); }
                    if (utterance.index == utterance.total - 1) emitState("ended", null);
                }

                @Override
                public void onError(String utteranceId) {
                    onError(utteranceId, TextToSpeech.ERROR);
                }

                @Override
                public void onError(String utteranceId, int errorCode) {
                    Utterance utterance = parseUtterance(utteranceId);
                    if (utterance == null || utterance.generation != playbackGeneration.get()) return;
                    emitState("error", "Android speech failed (" + errorCode + ")");
                }
            });
            engineReady.complete(ready);
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("installed", true);
        result.put("downloading", false);
        result.put("engine", "Android system narrator");
        result.put("ready", engineReady.isDone() && !engineReady.isCompletedExceptionally());
        call.resolve(result);
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        worker.execute(() -> {
            try {
                awaitEngine();
                call.resolve();
            } catch (Exception error) {
                call.reject(messageFor(error), error);
            }
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "").replaceAll("\\s+", " ").trim();
        if (text.isEmpty()) { call.reject("There is no text to read"); return; }
        List<String> chunks = splitText(text, Math.min(SPEECH_CHUNK_CHARACTERS, TextToSpeech.getMaxSpeechInputLength() - 100));
        float rate = Math.max(.6f, Math.min(1.8f, call.getFloat("rate", 1f)));
        int generation = playbackGeneration.incrementAndGet();
        paused = false;
        synchronized (stateLock) {
            activeChunks = chunks;
            activeChunkIndex = 0;
            activeRate = rate;
        }
        emitState("loading", null);
        worker.execute(() -> {
            try {
                TextToSpeech ready = awaitEngine();
                ready.stop();
                ready.setSpeechRate(rate);
                queueChunks(ready, chunks, 0, generation);
                call.resolve();
            } catch (Exception error) {
                if (generation == playbackGeneration.get()) emitState("error", messageFor(error));
                call.reject(messageFor(error), error);
            }
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        paused = true;
        TextToSpeech ready = engine;
        if (ready != null) ready.stop();
        emitState("paused", null);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        final List<String> chunks;
        final int index;
        final float rate;
        synchronized (stateLock) {
            chunks = activeChunks;
            index = Math.min(activeChunkIndex, Math.max(0, chunks.size() - 1));
            rate = activeRate;
        }
        if (chunks.isEmpty()) { call.resolve(); return; }
        int generation = playbackGeneration.incrementAndGet();
        paused = false;
        emitState("loading", null);
        worker.execute(() -> {
            try {
                TextToSpeech ready = awaitEngine();
                ready.stop();
                ready.setSpeechRate(rate);
                queueChunks(ready, chunks, index, generation);
                call.resolve();
            } catch (Exception error) {
                if (generation == playbackGeneration.get()) emitState("error", messageFor(error));
                call.reject(messageFor(error), error);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        playbackGeneration.incrementAndGet();
        paused = false;
        synchronized (stateLock) {
            activeChunks = Collections.emptyList();
            activeChunkIndex = 0;
        }
        TextToSpeech ready = engine;
        if (ready != null) ready.stop();
        emitState("stopped", null);
        call.resolve();
    }

    private TextToSpeech awaitEngine() throws Exception {
        return engineReady.get(ENGINE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    }

    private void selectBestOfflineVoice(TextToSpeech ready) {
        Voice current = ready.getVoice();
        Locale locale = current == null ? Locale.getDefault() : current.getLocale();
        Voice best = null;
        Set<Voice> voices = ready.getVoices();
        if (voices == null) return;
        for (Voice candidate : voices) {
            if (candidate.isNetworkConnectionRequired() || !candidate.getLocale().getLanguage().equals(locale.getLanguage())) continue;
            if (best == null || candidate.getQuality() > best.getQuality() ||
                (candidate.getQuality() == best.getQuality() && candidate.getLatency() < best.getLatency())) best = candidate;
        }
        if (best != null) ready.setVoice(best);
    }

    private void queueChunks(TextToSpeech ready, List<String> chunks, int start, int generation) {
        Bundle options = new Bundle();
        for (int index = start; index < chunks.size(); index++) {
            String id = "shelf:" + generation + ":" + index + ":" + chunks.size();
            int queueMode = index == start ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            int result = ready.speak(chunks.get(index), queueMode, options, id);
            if (result != TextToSpeech.SUCCESS) throw new IllegalStateException("Android rejected speech (" + result + ")");
        }
    }

    private List<String> splitText(String text, int limit) {
        List<String> result = new ArrayList<>();
        int start = 0;
        while (start < text.length()) {
            int end = Math.min(text.length(), start + limit);
            if (end < text.length()) {
                int boundary = Math.max(text.lastIndexOf(". ", end), Math.max(text.lastIndexOf("! ", end), text.lastIndexOf("? ", end)));
                if (boundary <= start + limit / 3) boundary = text.lastIndexOf(' ', end);
                if (boundary > start) end = boundary + 1;
            }
            String chunk = text.substring(start, end).trim();
            if (!chunk.isEmpty()) result.add(chunk);
            start = end;
        }
        return result;
    }

    private static final class Utterance {
        final int generation;
        final int index;
        final int total;
        Utterance(int generation, int index, int total) {
            this.generation = generation;
            this.index = index;
            this.total = total;
        }
    }

    private Utterance parseUtterance(String id) {
        try {
            String[] parts = id.split(":");
            if (parts.length != 4 || !"shelf".equals(parts[0])) return null;
            return new Utterance(Integer.parseInt(parts[1]), Integer.parseInt(parts[2]), Integer.parseInt(parts[3]));
        } catch (Exception ignored) {
            return null;
        }
    }

    private void emitState(String state, String message) {
        JSObject data = new JSObject();
        data.put("state", state);
        if (message != null) data.put("message", message);
        notifyListeners("stateChange", data);
    }

    private String messageFor(Exception error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        String message = cause.getMessage();
        return message == null || message.isBlank() ? cause.getClass().getSimpleName() : message;
    }

    private void cleanupLegacyKokoro() {
        worker.execute(() -> {
            deleteTree(new File(getContext().getFilesDir(), "kokoro-model"));
            deleteTree(new File(getContext().getFilesDir(), "kokoro-staging"));
            new File(getContext().getCacheDir(), "kokoro-model.tar.bz2").delete();
        });
    }

    private void deleteTree(File target) {
        if (!target.exists()) return;
        File[] children = target.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        target.delete();
    }

    @Override
    protected void handleOnDestroy() {
        playbackGeneration.incrementAndGet();
        TextToSpeech ready = engine;
        if (ready != null) {
            ready.stop();
            ready.shutdown();
        }
        worker.shutdownNow();
        super.handleOnDestroy();
    }
}
