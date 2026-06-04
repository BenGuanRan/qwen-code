/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocket } from 'ws';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { TransportStream } from './transportStream.js';

/**
 * WebSocket adapter implementing `TransportStream`. Wraps a `ws.WebSocket`
 * instance to provide the same `send`/`close`/`isClosed` contract as
 * `SseStream`, letting `AcpConnection` drive both transports uniformly.
 *
 * Unlike SSE (which needs a separate connection-scoped + session-scoped
 * GET stream), a single WebSocket carries ALL frames for a connection
 * (connection-level + all sessions). The `AcpConnection` multiplexes
 * by routing via `sendConn` / `sendSession` — both call `stream.send()`
 * on the same `WsStream` instance.
 */
export class WsStream implements TransportStream {
  private writeChain: Promise<void> = Promise.resolve();
  private _closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly onClose?: () => void,
    private readonly onHeartbeat?: () => void,
  ) {
    ws.on('close', () => this.close());
    ws.on('error', (err) => {
      writeStderrLine(
        `qwen serve: /acp WS error: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.close();
    });

    this.heartbeat = setInterval(() => {
      if (this._closed) return;
      this.onHeartbeat?.();
      this.ws.ping();
    }, 15_000);
    this.heartbeat.unref();
  }

  send(message: unknown): Promise<void> {
    const data = JSON.stringify(message);
    const next = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this._closed) {
            resolve();
            return;
          }
          this.ws.send(data, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    );
    this.writeChain = next.catch((err: unknown) => {
      if (!this._closed) {
        writeStderrLine(
          `qwen serve: /acp WS write failed, closing: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.close();
      }
    });
    return next;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close(1000, 'connection closed');
      }
    } catch {
      // socket already gone
    }
    try {
      this.onClose?.();
    } catch (err) {
      writeStderrLine(
        `qwen serve: /acp WS onClose threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
