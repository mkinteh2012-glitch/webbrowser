// Libraries
const express = require('express');
const Docker = require('dockerode');
const path = require('path');
const http = require('http');

// Sets up Express and HTTP servers
const app = express();
const server = http.createServer(app);

// Cross-platform Docker socket connection
const docker = new Docker({
  socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'
});

// Middleware & static folder serving
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../src/frontend')));

// Store active container sessions and dynamic port tracker
const activeSessions = new Map();
let currentPort = 8080;

/**
 * Helper delay function to allow supervisord and websockify
 * time to bind inside the container before returning to frontend.
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        PortBindings: { '8080/tcp': [{ HostPort: String(assignedPort), HostIp: '127.0.0.1' }] },
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000, // 1 CPU limit
        AutoRemove: true  
      }
    });

    await container.start();

    // Store active session metadata
    activeSessions.set(sessionId, {
      containerId: container.id,
      port: assignedPort
    });

    // Wait 2.5 seconds for container services (Xvfb, websockify) to initialize
    await delay(2500);

    console.log(`[WebBrowser] Session ${sessionId} ready at port ${assignedPort}.`);

    res.json({
      success: true,
      sessionId,
      port: assignedPort,
      streamUrl: `http://localhost:${assignedPort}/vnc.html?autoconnect=true&resize=scale&reconnect=true`
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
 */
app.post('/api/session/stop', async (req, res) => {
  const { sessionId } = req.body;

  if (!activeSessions.has(sessionId)) {
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
    res.status(500).json({ success: false, error: 'Failed to stop session container.' });
  }
});

/**
 * Gracefully shuts down all active Docker containers on process exit
 */
async function cleanupAllSessions() {
  console.log('\n[WebBrowser] Cleaning up active containers before shutdown...');
  for (const [sessionId, session] of activeSessions.entries()) {
    try {
      const container = docker.getContainer(session.containerId);
      await container.stop();
      console.log(`[WebBrowser] Stopped container ${sessionId}`);
    } catch (err) {
      // Ignore if container is already stopped
    }
  }
  process.exit(0);
}

// Attach process exit signals
process.on('SIGINT', cleanupAllSessions);
process.on('SIGTERM', cleanupAllSessions);

// Start backend server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(` WebBrowser Backend Server Running on http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});