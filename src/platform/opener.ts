import { callRpc } from "./rpcClient";

export async function openExternalUrl(url: string) {
  if (typeof window === "undefined") {
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    window.location.href = url;
  }
}

export async function revealInFileManager(path: string) {
  await callRpc("reveal_item_in_dir", { path });
}
