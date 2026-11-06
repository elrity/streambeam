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
        final BlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(90); // ~3 s at 30 fps
        boolean started;

        void offer(byte[] chunk, boolean key) {
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

    /** {@code onClient} asks the encoder for a key frame. */
    LiveStream(Runnable onClient) {
        this.onClient = onClient;
    }

    void publish(byte[] chunk, boolean key) {
        for (Client c : clients) c.offer(chunk, key);
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
        for (Client c : clients) {
            c.queue.clear();
            c.queue.offer(END);
        }
    }
}
