import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerEvent } from "../types";
import { subscribeRpcNotification } from "../platform/rpcClient";
import {
  subscribeAppServerEvents,
  subscribeMenuCycleCollaborationMode,
  subscribeMenuCycleModel,
  subscribeMenuNewAgent,
  subscribeTerminalOutput,
} from "./events";

vi.mock("../platform/rpcClient", () => ({
  subscribeRpcNotification: vi.fn(),
}));

describe("events subscriptions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("delivers payloads and unsubscribes on cleanup", async () => {
    let handler: (payload: unknown) => void = () => {};
    const unlisten = vi.fn();

    vi.mocked(subscribeRpcNotification).mockImplementation((_event, callback) => {
      handler = callback;
      return unlisten;
    });

    const onEvent = vi.fn();
    const cleanup = subscribeAppServerEvents(onEvent);
    const payload: AppServerEvent = {
      workspace_id: "ws-1",
      message: { method: "ping" },
    };

    handler(payload);
    expect(onEvent).toHaveBeenCalledWith(payload);

    cleanup();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("delivers menu events to subscribers", async () => {
    let handler: (payload: unknown) => void = () => {};
    const unlisten = vi.fn();

    vi.mocked(subscribeRpcNotification).mockImplementation((_event, callback) => {
      handler = callback;
      return unlisten;
    });

    const onEvent = vi.fn();
    const cleanup = subscribeMenuCycleModel(onEvent);

    handler(undefined);
    expect(onEvent).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("delivers collaboration cycle menu events to subscribers", async () => {
    let handler: (payload: unknown) => void = () => {};
    const unlisten = vi.fn();

    vi.mocked(subscribeRpcNotification).mockImplementation((_event, callback) => {
      handler = callback;
      return unlisten;
    });

    const onEvent = vi.fn();
    const cleanup = subscribeMenuCycleCollaborationMode(onEvent);

    handler(undefined);
    expect(onEvent).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("reports subscribe errors through options", async () => {
    const error = new Error("nope");
    vi.mocked(subscribeRpcNotification).mockImplementationOnce(() => {
      throw error;
    });

    const onError = vi.fn();
    const cleanup = subscribeTerminalOutput(() => {}, { onError });

    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);

    cleanup();
  });

  it("cleans up listeners", async () => {
    const unlisten = vi.fn();
    vi.mocked(subscribeRpcNotification).mockImplementation(() => unlisten);

    const cleanup = subscribeMenuNewAgent(() => {});
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
