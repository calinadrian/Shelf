package com.hasyl.shelf;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;
import org.json.JSONObject;

@CapacitorPlugin(name = "ShelfTextToSpeech")
public class TextToSpeechPlugin extends Plugin {
    private static final String MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2";
    private static final String MODEL_SHA256 = "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd";
    private static final long MODEL_DOWNLOAD_BYTES = 103248205L;
    private static final int SYNTHESIS_CHUNK_CHARACTERS = 160;
    private static final int PLAYBACK_WRITE_SAMPLES = 4096;
    private static final long PLAYBACK_STALL_TIMEOUT_MS = 10_000L;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicInteger playbackGeneration = new AtomicInteger();
    private volatile boolean downloading;
    private volatile boolean paused;
    private volatile AudioTrack audioTrack;
    private OfflineTts engine;

    private static final class SpeechPart {
        final String text;
        final int speaker;
        SpeechPart(String text, int speaker) { this.text = text; this.speaker = speaker; }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("installed", findModelDirectory() != null);
        result.put("downloading", downloading);
        result.put("downloadBytes", MODEL_DOWNLOAD_BYTES);
        result.put("engine", "Kokoro");
        call.resolve(result);
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        File model = findModelDirectory();
        if (model == null) { call.reject("Kokoro voice model is not installed"); return; }
        worker.execute(() -> {
            try {
                ensureEngine(model);
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void downloadModel(PluginCall call) {
        if (findModelDirectory() != null) { call.resolve(); return; }
        if (downloading) { call.reject("The Kokoro model is already downloading"); return; }
        if (getContext().getFilesDir().getUsableSpace() < 280_000_000L) {
            call.reject("At least 280 MB of free storage is required during installation");
            return;
        }
        downloading = true;
        worker.execute(() -> {
            File archive = new File(getContext().getCacheDir(), "kokoro-model.tar.bz2");
            File staging = new File(getContext().getFilesDir(), "kokoro-staging");
            try {
                deleteTree(staging);
                if (!staging.mkdirs() && !staging.isDirectory()) throw new Exception("Could not prepare model storage");
                downloadArchive(archive);
                extractArchive(archive, staging);
                File extracted = findModelDirectory(staging);
                if (extracted == null) throw new Exception("The downloaded model is incomplete");
                File destination = modelRoot();
                releaseEngine();
                deleteTree(destination);
                if (!extracted.renameTo(destination)) throw new Exception("Could not install the Kokoro model");
                deleteTree(staging);
                archive.delete();
                emitModelState("installed", 100, null);
                call.resolve();
            } catch (Exception error) {
                deleteTree(staging);
                archive.delete();
                emitModelState("error", 0, error.getMessage());
                call.reject(error.getMessage(), error);
            } finally {
                downloading = false;
            }
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        File model = findModelDirectory();
        if (model == null) { call.reject("Kokoro voice model is not installed"); return; }
        List<SpeechPart> parts = readParts(call);
        if (parts.isEmpty()) { call.reject("There is no text to read"); return; }
        float speed = Math.max(.6f, Math.min(1.8f, call.getFloat("rate", 1f)));
        int generation = playbackGeneration.incrementAndGet();
        paused = false;
        stopAudioTrack();
        worker.execute(() -> {
            boolean resolved = false;
            try {
                emitState("loading");
                ensureEngine(model);
                call.resolve();
                resolved = true;
                for (SpeechPart part : parts) {
                    // Short chunks make the first spoken audio available much sooner on
                    // mid-range phones, while sentence boundaries keep speech natural.
                    for (String chunk : splitText(part.text, SYNTHESIS_CHUNK_CHARACTERS)) {
                        if (generation != playbackGeneration.get()) return;
                        GeneratedAudio audio = engine.generate(chunk, Math.max(0, Math.min(10, part.speaker)), speed);
                        if (generation != playbackGeneration.get()) return;
                        while (paused && generation == playbackGeneration.get()) Thread.sleep(35);
                        if (generation != playbackGeneration.get()) return;
                        emitState("speaking");
                        playAudio(audio, generation);
                    }
                }
                if (generation == playbackGeneration.get()) emitState("ended");
            } catch (Exception error) {
                if (generation == playbackGeneration.get()) emitState("error");
                if (!resolved) call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        paused = true;
        AudioTrack track = audioTrack;
        if (track != null) track.pause();
        emitState("paused");
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        paused = false;
        AudioTrack track = audioTrack;
        if (track != null) track.play();
        emitState("speaking");
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopSpeaking();
        emitState("stopped");
        call.resolve();
    }

    private List<SpeechPart> readParts(PluginCall call) {
        List<SpeechPart> result = new ArrayList<>();
        JSArray segments = call.getArray("segments");
        if (segments != null) {
            for (int index = 0; index < segments.length(); index++) {
                try {
                    JSONObject item = segments.getJSONObject(index);
                    String text = item.optString("text", "").trim();
                    if (!text.isEmpty()) result.add(new SpeechPart(text, item.optInt("speaker", 7)));
                } catch (Exception ignored) { }
            }
        }
        if (result.isEmpty()) {
            String text = call.getString("text", "").trim();
            if (!text.isEmpty()) result.add(new SpeechPart(text, call.getInt("speaker", 7)));
        }
        return result;
    }

    private void ensureEngine(File directory) {
        if (engine != null) return;
        File model = findFile(directory, ".onnx");
        File voices = findFile(directory, "voices.bin");
        File tokens = findFile(directory, "tokens.txt");
        File espeak = findDirectory(directory, "espeak-ng-data");
        if (model == null || voices == null || tokens == null || espeak == null) throw new IllegalStateException("Kokoro model files are incomplete");
        OfflineTtsKokoroModelConfig kokoro = new OfflineTtsKokoroModelConfig();
        kokoro.setModel(model.getAbsolutePath());
        kokoro.setVoices(voices.getAbsolutePath());
        kokoro.setTokens(tokens.getAbsolutePath());
        kokoro.setDataDir(espeak.getAbsolutePath());
        OfflineTtsModelConfig modelConfig = new OfflineTtsModelConfig();
        modelConfig.setKokoro(kokoro);
        modelConfig.setNumThreads(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1)));
        modelConfig.setDebug(false);
        OfflineTtsConfig config = new OfflineTtsConfig();
        config.setModel(modelConfig);
        config.setMaxNumSentences(1);
        engine = new OfflineTts(null, config);
    }

    private void playAudio(GeneratedAudio generated, int generation) throws InterruptedException {
        float[] samples = generated.getSamples();
        if (samples.length == 0) return;
        int sampleRate = generated.getSampleRate();
        int minimumBuffer = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_FLOAT
        );
        if (minimumBuffer <= 0) throw new IllegalStateException("This phone could not create a speech audio buffer");
        int bufferBytes = Math.max(minimumBuffer, Math.min(samples.length, sampleRate / 2) * Float.BYTES);
        AudioTrack track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(bufferBytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build();
        audioTrack = track;
        try {
            track.play();
            int offset = 0;
            while (offset < samples.length && generation == playbackGeneration.get()) {
                while (paused && generation == playbackGeneration.get()) Thread.sleep(35);
                if (generation != playbackGeneration.get()) return;
                int count = Math.min(PLAYBACK_WRITE_SAMPLES, samples.length - offset);
                int written = track.write(samples, offset, count, AudioTrack.WRITE_BLOCKING);
                if (written < 0) throw new IllegalStateException("Speech playback failed (" + written + ")");
                if (written == 0) Thread.sleep(10);
                else offset += written;
            }

            // A streaming write completes when samples enter AudioTrack's buffer, not
            // when the speaker has played them. Wait for every frame so the end of a
            // sentence cannot be cut off when the track is released.
            long lastHead = -1;
            long stalledSince = System.currentTimeMillis();
            while (generation == playbackGeneration.get()) {
                while (paused && generation == playbackGeneration.get()) {
                    stalledSince = System.currentTimeMillis();
                    Thread.sleep(35);
                }
                long head = Integer.toUnsignedLong(track.getPlaybackHeadPosition());
                if (head >= samples.length) break;
                if (head != lastHead) {
                    lastHead = head;
                    stalledSince = System.currentTimeMillis();
                } else if (System.currentTimeMillis() - stalledSince > PLAYBACK_STALL_TIMEOUT_MS) {
                    throw new IllegalStateException("Speech playback stopped responding");
                }
                Thread.sleep(20);
            }
        } finally {
            if (audioTrack == track) audioTrack = null;
            try { track.stop(); } catch (Exception ignored) { }
            track.release();
        }
    }

    private void downloadArchive(File destination) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(MODEL_URL).openConnection();
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("User-Agent", "Shelf-Android");
        if (connection.getResponseCode() / 100 != 2) throw new Exception("Model download failed (HTTP " + connection.getResponseCode() + ")");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long received = 0;
        int lastProgress = -1;
        try (InputStream input = new DigestInputStream(new BufferedInputStream(connection.getInputStream()), digest);
             BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
                received += count;
                int progress = (int) Math.min(99, received * 100 / MODEL_DOWNLOAD_BYTES);
                if (progress != lastProgress) { emitModelState("downloading", progress, null); lastProgress = progress; }
            }
        } finally { connection.disconnect(); }
        StringBuilder actual = new StringBuilder();
        for (byte value : digest.digest()) actual.append(String.format("%02x", value));
        if (!MODEL_SHA256.equals(actual.toString())) throw new Exception("The downloaded model failed verification");
    }

    private void extractArchive(File archive, File destination) throws Exception {
        String root = destination.getCanonicalPath() + File.separator;
        try (TarArchiveInputStream input = new TarArchiveInputStream(new BZip2CompressorInputStream(new BufferedInputStream(new FileInputStream(archive))))) {
            TarArchiveEntry entry;
            byte[] buffer = new byte[64 * 1024];
            while ((entry = input.getNextTarEntry()) != null) {
                if (entry.isSymbolicLink() || entry.isLink()) continue;
                File output = new File(destination, entry.getName());
                if (!output.getCanonicalPath().startsWith(root)) throw new Exception("Unsafe path in model archive");
                if (entry.isDirectory()) { output.mkdirs(); continue; }
                File parent = output.getParentFile();
                if (parent != null) parent.mkdirs();
                try (BufferedOutputStream stream = new BufferedOutputStream(new FileOutputStream(output))) {
                    int count;
                    while ((count = input.read(buffer)) != -1) stream.write(buffer, 0, count);
                }
            }
        }
    }

    private File modelRoot() { return new File(getContext().getFilesDir(), "kokoro-model"); }
    private File findModelDirectory() { return findModelDirectory(modelRoot()); }
    private File findModelDirectory(File root) {
        if (!root.exists()) return null;
        if (findFile(root, ".onnx") != null && findFile(root, "voices.bin") != null && findFile(root, "tokens.txt") != null && findDirectory(root, "espeak-ng-data") != null) return root;
        File[] children = root.listFiles(File::isDirectory);
        if (children != null) for (File child : children) { File found = findModelDirectory(child); if (found != null) return found; }
        return null;
    }

    private File findFile(File root, String nameOrSuffix) {
        File[] children = root.listFiles();
        if (children == null) return null;
        for (File child : children) {
            if (child.isFile() && (child.getName().equals(nameOrSuffix) || child.getName().endsWith(nameOrSuffix))) return child;
            if (child.isDirectory()) { File found = findFile(child, nameOrSuffix); if (found != null) return found; }
        }
        return null;
    }

    private File findDirectory(File root, String name) {
        if (root.isDirectory() && root.getName().equals(name)) return root;
        File[] children = root.listFiles(File::isDirectory);
        if (children != null) for (File child : children) { File found = findDirectory(child, name); if (found != null) return found; }
        return null;
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

    private void stopSpeaking() {
        playbackGeneration.incrementAndGet();
        paused = false;
        stopAudioTrack();
    }

    private void stopAudioTrack() {
        AudioTrack track = audioTrack;
        audioTrack = null;
        if (track != null) try { track.stop(); } catch (Exception ignored) { }
    }

    private void releaseEngine() {
        if (engine != null) { engine.release(); engine = null; }
    }

    private void emitState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners("stateChange", data);
    }

    private void emitModelState(String state, int progress, String message) {
        JSObject data = new JSObject();
        data.put("state", state);
        data.put("progress", progress);
        if (message != null) data.put("message", message);
        notifyListeners("modelState", data);
    }

    private void deleteTree(File target) {
        if (!target.exists()) return;
        File[] children = target.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        target.delete();
    }

    @Override
    protected void handleOnDestroy() {
        stopSpeaking();
        worker.execute(this::releaseEngine);
        worker.shutdown();
        super.handleOnDestroy();
    }
}
