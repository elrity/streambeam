package app.streambeam.caster;

import java.io.IOException;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

/**
 * A live MPEG-TS feed served to any number of screens. Each connection starts at the next key frame
 * (one is requested as soon as it connects) and gets every frame after that. A screen that falls more
 * than a few seconds behind skips ahead to the next key frame instead of building up delay.
 */
class LiveStream implements LocalServer.Live {
    private static final byte[] END = new byte[0];

    private final class Client {
        final BlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(240); // ~1.5 s of picture, sound and filler
        boolean started;

        synchronized void offer(byte[] chunk, boolean key) {
            if (!started) {
                if (!key) return;
                started = true;
            }
            if (!queue.offer(chunk)) { // behind: drop the backlog, resume at a key frame
                queue.clear();
                started = false;
                if (onClient != null) onClient.run();
            }
        }
    }

    private final List<Client> clients = new CopyOnWriteArrayList<>();
    private final Runnable onClient;
    private volatile boolean closed;
    private final java.util.concurrent.atomic.AtomicLong sent = new java.util.concurrent.atomic.AtomicLong();
    private Thread padder;

    /** {@code onClient} asks the encoder for a key frame. */
    LiveStream(Runnable onClient) {
        this.onClient = onClient;
    }

    void publish(byte[] chunk, boolean key) {
        sent.addAndGet(chunk.length);
        for (Client c : clients) c.offer(chunk, key);
    }

    /*
     * Keeps the stream at a steady rate with MPEG-TS null packets (PID 0x1FFF), which every player discards.
     * A still screen such as a map makes only a trickle of data, and car players tuned for films keep
     * pausing to fill their buffer when data trickles in; each pause stays as delay. With filler the stream
     * looks like a busy video to them.
     */
    void padTo(int bitsPerSecond) {
        padder = new Thread(() -> {
            final int perPacket = 188;
            byte[] nul = new byte[perPacket];
            java.util.Arrays.fill(nul, (byte) 0xFF);
            nul[0] = 0x47;
            nul[1] = 0x1F;
            nul[2] = (byte) 0xFF;
            nul[3] = 0x10;
            long start = System.nanoTime(), base = sent.get();
            while (!closed) {
                try {
                    Thread.sleep(20);
                } catch (InterruptedException e) {
                    return;
                }
                long due = (System.nanoTime() - start) / 1000 * (bitsPerSecond / 8) / 1_000_000;
                long missing = due - (sent.get() - base);
                if (missing < perPacket) continue;
                int packets = (int) Math.min(missing / perPacket, 200); // at most ~37 KB at once
                byte[] fill = new byte[packets * perPacket];
                for (int i = 0; i < packets; i++) System.arraycopy(nul, 0, fill, i * perPacket, perPacket);
                publish(fill, false);
                if (missing > bitsPerSecond / 8) { // far behind (just started, or a pause): don't burst to catch up
                    start = System.nanoTime();
                    base = sent.get();
                }
            }
        }, "StreamBeam filler");
        padder.setDaemon(true);
        padder.start();
    }

    int clients() {
        return clients.size();
    }

    @Override
    public void stream(OutputStream out) throws IOException {
        Client c = new Client();
        clients.add(c);
        if (onClient != null) onClient.run();
        try {
            while (!closed) {
                byte[] chunk = c.queue.poll(2, TimeUnit.SECONDS);
                if (chunk == null) continue;
                if (chunk == END) break;
                out.write(chunk);
                out.flush();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            clients.remove(c);
        }
    }

    void close() {
        closed = true;
        if (padder != null) padder.interrupt();
        for (Client c : clients) {
            c.queue.clear();
            c.queue.offer(END);
        }
    }
}
