// Libraries
const express = require('express');
const Docker = require('dockerode');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');

// Sets up Express and HTTP servers
const app = express();
const server = http.createServer(app);

// Cross-platform Docker socket connection
const docker = new Docker({
  socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'
});

// Middleware & static folder serving
app.use(express.json());
app.use(express.text({ type: 'text/plain' })); // needed for navigator.sendBeacon payloads
app.use(express.static(path.join(__dirname, '../../src/frontend')));

// Store active container sessions and dynamic port tracker
const activeSessions = new Map();
let currentPort = 8080;

// Reaper config
const HEARTBEAT_TIMEOUT_MS = 15000;             // kill if no heartbeat in 15s
const MAX_SESSION_AGE_MS = 72 * 60 * 60 * 1000; // absolute failsafe cap: 72 hours

/**
 * Helper delay function to allow supervisord and websockify
 * time to bind inside the container before returning to frontend.
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the correct public stream URL depending on environment.
 * Inside GitHub Codespaces, localhost is not reachable externally,
 * so we build the forwarded *.app.github.dev URL instead.
 */
function buildStreamUrl(port) {
  const codespaceName = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';

  if (codespaceName) {
    return `https://${codespaceName}-${port}.${domain}/vnc.html?autoconnect=true&resize=scale&reconnect=true`;
  }
  return `http://localhost:${port}/vnc.html?autoconnect=true&resize=scale&reconnect=true`;
}

/**
 * Forces a forwarded port to Public visibility inside a Codespace.
 * No-op outside Codespaces (e.g. running locally on your own machine).
 */
function makePortPublic(port) {
  if (!process.env.CODESPACE_NAME) return;

  exec(`gh codespace ports visibility ${port}:public -c ${process.env.CODESPACE_NAME}`, (err, stdout, stderr) => {
    if (err) {
      console.error(`[WebBrowser] Failed to make port ${port} public:`, stderr || err.message);
    } else {
      console.log(`[WebBrowser] Port ${port} set to public.`);
    }
  });
}

/**
 * POST /api/session/start
 * Dynamically spawns a new Chromium container on an incremental port.
 */
app.post('/api/session/start', async (req, res) => {
  try {
    const sessionId = `webbrowser-${Date.now()}`;
    const assignedPort = currentPort++;

    console.log(`[WebBrowser] Creating container ${sessionId} on port ${assignedPort}...`);

    const container = await docker.createContainer({
      Image: 'webbrowser-image',
      name: sessionId,
      ExposedPorts: { '8080/tcp': {} },
      HostConfig: {
        PortBindings: {
          '8080/tcp': [{ HostPort: String(assignedPort) }]
        },
        Memory: 512 * 1024 * 1024, // 512MB cap per container
        NanoCpus: 1_000_000_000,   // 1 CPU cap per container
        AutoRemove: true
      }
    });

    await container.start();

    // Make the new port publicly reachable if running in a Codespace
    makePortPublic(assignedPort);

    // Store active session metadata
    activeSessions.set(sessionId, {
      containerId: container.id,
      port: assignedPort,
      lastSeen: Date.now(),
      startedAt: Date.now()
    });

    // Wait for container services (Xvfb, websockify) to initialize
    await delay(3500);

    console.log(`[WebBrowser] Session ${sessionId} ready at port ${assignedPort}.`);

    res.json({
      success: true,
      sessionId,
      port: assignedPort,
      streamUrl: buildStreamUrl(assignedPort)
    });

  } catch (error) {
    console.error('[WebBrowser] Error launching container:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to launch virtual browser container.'
    });
  }
});

/**
 * POST /api/session/stop
 * Stops and automatically removes an active session container.
 * Accepts both JSON (fetch) and text/plain (navigator.sendBeacon) bodies.
 */
app.post('/api/session/stop', async (req, res) => {
  let body = req.body;

  // sendBeacon delivers a raw string body; parse it if needed
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const { sessionId } = body || {};

  if (!sessionId || !activeSessions.has(sessionId)) {
    return res.status(404).json({ success: false, error: 'Session not found.' });
  }

  try {
    const session = activeSessions.get(sessionId);
    const container = docker.getContainer(session.containerId);

    console.log(`[WebBrowser] Stopping container for session ${sessionId}...`);
    await container.stop();

    activeSessions.delete(sessionId);
    res.json({ success: true, message: 'Session closed.' });

  } catch (error) {
    console.error('[WebBrowser] Error stopping container:', error);
    activeSessions.delete(sessionId); // don't leave it tracked if stop failed on a dead container
    res.status(500).json({ success: false, error: 'Failed to stop session container.' });
  }
});

/**
 * POST /api/session/heartbeat
 * Frontend pings this periodically to prove the session is still open.
 */
app.post('/api/session/heartbeat', (req, res) => {
  const { sessionId } = req.body || {};
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found.' });
  }

  session.lastSeen = Date.now();
  res.json({ success: true });
});

/**
 * GET /api/session/list
 * Quick visibility into everything currently running.
 */
app.get('/api/session/list', (req, res) => {
  const sessions = Array.from(activeSessions.entries()).map(([sessionId, s]) => ({
    sessionId,
    port: s.port,
    streamUrl: buildStreamUrl(s.port),
    ageSeconds: Math.round((Date.now() - s.startedAt) / 1000),
    lastSeenSecondsAgo: Math.round((Date.now() - s.lastSeen) / 1000)
  }));

  res.json({ success: true, count: sessions.length, sessions });
});

/**
 * Reaper: runs every 5s.
 * Stops any container that's gone quiet (no heartbeat) OR
 * exceeded the absolute 72h age cap, whichever comes first.
 */
async function reapStaleSessions() {
  const now = Date.now();

  for (const [sessionId, session] of activeSessions.entries()) {
    const noHeartbeat = now - session.lastSeen > HEARTBEAT_TIMEOUT_MS;
    const tooOld = now - session.startedAt > MAX_SESSION_AGE_MS;

    if (noHeartbeat || tooOld) {
      const reason = tooOld ? 'exceeded 72h max age' : 'no heartbeat';
      console.log(`[WebBrowser] Reaping session ${sessionId} (${reason}).`);

      try {
        const container = docker.getContainer(session.containerId);
        await container.stop();
      } catch (err) {
        console.error(`[WebBrowser] Reaper failed to stop ${sessionId}:`, err.message);
      }
      activeSessions.delete(sessionId);
    }
  }
}

setInterval(reapStaleSessions, 5000);

// Start backend server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(` WebBrowser Backend Server Running on http://localhost:${PORT}`);
  if (process.env.CODESPACE_NAME) {
    console.log(` Public URL: https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`);
  }
  console.log(`==================================================\n`);
});