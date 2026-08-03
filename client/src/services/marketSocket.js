/**
 * marketSocket — one WebSocket connection for the whole app.
 *
 * Changes from the original:
 *  - sends the JWT, since /ws/market now authenticates on upgrade (FIX C6)
 *  - stops retrying on 401/403 instead of hammering the server forever
 *  - exposes send() so the option chain can push {symbol, expiry}
 */

export const CONNECTION_STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  UNAUTHORIZED: 'unauthorized',
};

const MAX_RECONNECT_DELAY_MS = 15000;
const BASE_RECONNECT_DELAY_MS = 1000;

function buildSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const token = localStorage.getItem('vega_token') || '';
  return `${protocol}://${window.location.host}/ws/market?token=${encodeURIComponent(token)}`;
}

class MarketSocket {
  constructor() {
    this.socket = null;
    this.status = CONNECTION_STATUS.IDLE;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.manuallyClosed = false;
    this.openedSuccessfully = false;

    this.latestSnapshot = [];
    this.messageListeners = new Set();
    this.statusListeners = new Set();
    this.pendingSends = [];
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (!localStorage.getItem('vega_token')) {
      this._setStatus(CONNECTION_STATUS.UNAUTHORIZED);
      return;
    }

    this.manuallyClosed = false;
    this.openedSuccessfully = false;
    this._setStatus(this.reconnectAttempts > 0 ? CONNECTION_STATUS.RECONNECTING : CONNECTION_STATUS.CONNECTING);

    const socket = new WebSocket(buildSocketUrl());
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.openedSuccessfully = true;
      this._setStatus(CONNECTION_STATUS.CONNECTED);
      this.pendingSends.splice(0).forEach((payload) => this.send(payload));
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        console.warn('[marketSocket] Failed to parse message', err);
        return;
      }
      if (message.type === 'snapshot') this.latestSnapshot = message.data;
      this.messageListeners.forEach((listener) => listener(message));
    };

    socket.onclose = (event) => {
      // If the server rejected the upgrade (401/403), the socket closes without
      // ever having opened. Reconnecting with the same bad token is pointless —
      // the same mistake the KiteTicker was making on the server side.
      if (!this.openedSuccessfully) {
        this._setStatus(CONNECTION_STATUS.UNAUTHORIZED);
        return;
      }
      this._setStatus(CONNECTION_STATUS.DISCONNECTED);
      if (!this.manuallyClosed && event.code !== 1008) this._scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  /** Queues until the socket is open. Used for {type:'subscribe', symbol, expiry}. */
  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    } else {
      this.pendingSends.push(payload);
    }
  }

  disconnect() {
    this.manuallyClosed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempts = 0;
    this.socket?.close();
    this._setStatus(CONNECTION_STATUS.IDLE);
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatusChange(listener) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus() { return this.status; }
  getLatestSnapshot() { return this.latestSnapshot; }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempts += 1;
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    this._setStatus(CONNECTION_STATUS.RECONNECTING);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _setStatus(status) {
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status));
  }
}

const marketSocket = new MarketSocket();
export default marketSocket;