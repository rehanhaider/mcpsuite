/** A real stdio child and a minimal JSON-RPC client for transport tests. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RESPONSE_TIMEOUT_MS = 20_000;

export type RpcResponse = {
  id: number;
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }>; [key: string]: unknown };
  error?: { code: number; message: string };
};

export interface StdioChild {
  request(method: string, params: unknown): Promise<RpcResponse>;
  callTool(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; payload: unknown }>;
  close(): void;
}

export async function startStdio(env: NodeJS.ProcessEnv): Promise<StdioChild> {
  const child: ChildProcessWithoutNullStreams = spawn(join(appDir, "node_modules", ".bin", "tsx"), ["src/stdio.ts"], {
    cwd: appDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrLog = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (msg: RpcResponse) => void; reject: (err: Error) => void }>();
  const failAll = (reason: string) => {
    for (const [, waiter] of pending) waiter.reject(new Error(`${reason}\nchild stderr:\n${stderrLog}`));
    pending.clear();
  };
  child.stderr.on("data", (chunk: Buffer) => {
    stderrLog += chunk.toString("utf8");
  });
  child.on("exit", (code) => failAll(`stdio child exited early (code ${code})`));
  child.on("error", (error) => failAll(`stdio child failed to spawn: ${error.message}`));

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        continue; // not a protocol line
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  const request = (method: string, params: unknown): Promise<RpcResponse> => {
    const id = nextId++;
    const promise = new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for ${method} (id ${id})\nchild stderr:\n${stderrLog}`));
      }, RESPONSE_TIMEOUT_MS);
      timer.unref();
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolvePromise(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        },
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  };

  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcpsuite-stdio-test", version: "0.0.0" },
  });
  expect(init.error).toBeUndefined();
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  return {
    request,
    async callTool(name, args = {}) {
      const response = await request("tools/call", { name, arguments: args });
      expect(response.error).toBeUndefined();
      const text = response.result?.content?.[0]?.text ?? "null";
      return { isError: response.result?.isError === true, payload: JSON.parse(text) };
    },
    close() {
      child.removeAllListeners("exit");
      child.kill();
    },
  };
}
