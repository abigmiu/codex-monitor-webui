import { appendToken, getBackendConfig } from "./backendConfig";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutHandle: number;
};

type NotificationHandler = (params: unknown) => void;

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
    code?: number;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 1_200;

class RpcClient {
  private socket: WebSocket | null = null;

  private connectPromise: Promise<void> | null = null;

  private nextId = 1;

  private readonly pending = new Map<number, PendingRequest>();

  private readonly listeners = new Map<string, Set<NotificationHandler>>();

  private reconnectHandle: number | null = null;

  private intentionalClose = false;

  private buildSocketUrl() {
    const { rpcUrl, token } = getBackendConfig();
    const url = new URL(rpcUrl);
    appendToken(url, token);
    return url.toString();
  }

  connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.intentionalClose = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.buildSocketUrl());
      this.socket = socket;

      socket.onopen = () => {
        this.connectPromise = null;
        resolve();
      };

      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      socket.onerror = () => {
        if (this.connectPromise) {
          this.connectPromise = null;
          reject(new Error("RPC websocket connection failed"));
        }
      };

      socket.onclose = () => {
        this.socket = null;
        this.rejectAllPending("RPC websocket disconnected");
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      };
    });

    return this.connectPromise;
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectHandle !== null) {
      window.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async call<T>(
    method: string,
    params?: Record<string, unknown> | null,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("RPC websocket is not connected");
    }

    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutHandle,
      });

      const payload = JSON.stringify({
        id,
        method,
        params: params ?? {},
      });

      try {
        this.socket?.send(payload);
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          window.clearTimeout(pending.timeoutHandle);
          this.pending.delete(id);
        }
        reject(error);
      }
    });
  }

  subscribe(method: string, handler: NotificationHandler) {
    const set = this.listeners.get(method) ?? new Set<NotificationHandler>();
    set.add(handler);
    this.listeners.set(method, set);
    void this.connect();
    return () => {
      const current = this.listeners.get(method);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (current.size === 0) {
        this.listeners.delete(method);
      }
    };
  }

  private scheduleReconnect() {
    if (this.reconnectHandle !== null || this.intentionalClose) {
      return;
    }
    this.reconnectHandle = window.setTimeout(() => {
      this.reconnectHandle = null;
      if (this.listeners.size === 0 && this.pending.size === 0) {
        return;
      }
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private rejectAllPending(message: string) {
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timeoutHandle);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== "string") {
      return;
    }
    let payload: RpcResponse;
    try {
      payload = JSON.parse(raw) as RpcResponse;
    } catch {
      return;
    }

    if (typeof payload.id === "number") {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timeoutHandle);
      this.pending.delete(payload.id);
      if (payload.error) {
        const message = payload.error.message || "RPC error";
        pending.reject(new Error(message));
      } else {
        pending.resolve(payload.result ?? null);
      }
      return;
    }

    if (!payload.method) {
      return;
    }
    const listeners = this.listeners.get(payload.method);
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(payload.params);
      } catch (error) {
        console.error(`[rpcClient] notification listener failed: ${payload.method}`, error);
      }
    }
  }
}

const singleton = new RpcClient();

export function connectRpc() {
  return singleton.connect();
}

export function callRpc<T>(
  method: string,
  params?: Record<string, unknown> | null,
  options?: { timeoutMs?: number },
) {
  return singleton.call<T>(method, params, options);
}

export function subscribeRpcNotification(
  method: string,
  handler: (params: unknown) => void,
) {
  return singleton.subscribe(method, handler);
}

export function disconnectRpc() {
  singleton.disconnect();
}
