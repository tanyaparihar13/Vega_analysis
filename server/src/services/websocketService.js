const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { hasMarketAccess } = require('../middleware/auth');
require('dotenv').config();

const WS_PATH = '/ws/market';
const HEARTBEAT_INTERVAL_MS = 30000;

let wss = null;
let heartbeatTimer = null;

/**
 * FIX C6: the previous version accepted every connection and immediately
 * pushed the full market snapshot. The option chain is gated behind
 * requirePremium on the REST side, then handed to anyone who opened a raw
 * WebSocket. Auth now happens during the HTTP upgrade, before the socket
 * exists.
 *
 * Browsers cannot set headers on a WebSocket, so the JWT travels as a query
 * param. Note that URLs are more likely to end up in access logs than headers
 * are — if that matters to you, issue a short-lived single-use ticket from a
 * REST endpoint and pass that instead.
 */
function authenticateUpgrade(request) {
  let token = null;
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    token = url.searchParams.get('token');
  } catch {
    return null;
  }
  if (!token) return null;

  try {
    return jwt.verify(token, process.env.JWT_SECRET); // { id, email, role }
  } catch {
    return null;
  }
}

function initWebSocketServer(httpServer, getSnapshot) {
  if (wss) return wss;

  // noServer + explicit upgrade handling, so we can reject before the
  // handshake completes rather than closing an already-open socket.
  wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== WS_PATH) return; // let other upgrade handlers have it

    const user = authenticateUpgrade(request);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Same rule as the REST gate — shared helper so the two can never drift.
    // Access follows admin APPROVAL, not the legacy free/premium tier.
    if (!hasMarketAccess(user)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      client.user = user;
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (client) => {
    client.isAlive = true;
    // Per-client subscription set. Empty means "index feed only" — the option
    // chain will populate this from the client's {symbol, expiry} message so
    // we stop broadcasting every instrument to every browser.
    client.subscribedTokens = new Set();

    client.on('pong', () => { client.isAlive = true; });

    console.log(`[WS] Client connected (user ${client.user.id}) —`, wss.clients.size, 'total');

    sendToClient(client, {
      type: 'snapshot',
      data: getSnapshot(),
      timestamp: new Date().toISOString(),
    });

    // The server previously had no message handler at all, so the
    // {symbol, expiry} protocol in your brief had nothing listening.
    client.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return sendToClient(client, { type: 'error', message: 'Malformed JSON' });
      }
      handleClientMessage(client, msg);
    });

    client.on('close', () => {
      console.log('[WS] Client disconnected —', wss.clients.size, 'total');
    });

    client.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });

  heartbeatTimer = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.isAlive === false) return client.terminate();
      client.isAlive = false;
      client.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeatTimer));

  return wss;
}

/**
 * Hook for the option chain subscription protocol. The chain builder is not
 * written yet — when it is, resolve {symbol, expiry} to CE/PE instrument
 * tokens via the instrument cache, set client.subscribedTokens, and call
 * kiteTickerService.updateSubscription() with the union across all clients.
 */
let messageHandler = null;
function setMessageHandler(fn) { messageHandler = fn; }
function handleClientMessage(client, msg) {
  if (typeof messageHandler === 'function') return messageHandler(client, msg);
  sendToClient(client, { type: 'error', message: `Unsupported message type: ${msg.type}` });
}

function sendToClient(client, payload) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(payload));
  }
}

/** Broadcast to every client (indices, status changes). */
function broadcast(payload) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

/**
 * Broadcast ticks, filtered per client. Once the chain ships this is what
 * keeps a browser watching NIFTY 30-Jul from receiving BANKNIFTY 06-Aug ticks.
 */
function broadcastTicks(ticks) {
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;

    const relevant = client.subscribedTokens?.size
      ? ticks.filter((t) => client.subscribedTokens.has(t.instrumentToken))
      : ticks;

    if (!relevant.length) return;
    client.send(JSON.stringify({
      type: 'ticks',
      data: relevant,
      timestamp: new Date().toISOString(),
    }));
  });
}

function getWss() { return wss; }

module.exports = {
  initWebSocketServer,
  broadcast,
  broadcastTicks,
  sendToClient,
  setMessageHandler,
  getWss,
  WS_PATH,
};