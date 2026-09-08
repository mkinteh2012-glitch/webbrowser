// Libraries
const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');

// Sets up Express and HTTP servers
const app = express();
const server = http.createServer(app);

// Allow cross-origin requests (needed since frontend is now on a
// different domain - Firebase - than the backend - Codespaces)
app.use(cors());

// Middleware & static folder serving
app.use(express.json());
app.use(express.text({ type: 'text/plain' })); // needed for navigator.sendBeacon payloads
app.use(express.static(path.join(__dirname, '../../src/frontend')));

// Cross-platform Docker socket connection
const docker = new Docker({
  socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'
});

// Store active container sessions
const activeSessions = new Map();

// Port pool — avoids reusing a port before Docker has actually released it
const PORT_RANGE_START = 8080;
const PORT_RANGE_END = 8100;
const usedPorts = new Set();

function getAvailablePort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!usedPorts.has(port)) return port;
  }
  throw new Error('No available ports in range.');
}

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
 * Retries a few times since Codespaces needs a moment to register
 * a freshly-opened port as a tunnel before its visibility can be