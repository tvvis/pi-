import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export async function ansibleExec(
  host: string,
  command: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const url = `http://${host}:6677/ansible/agent/exec`;
  const body = new URLSearchParams({
    command,
    executable: "/bin/sh",
    become: "0",
    becomeMethod: "sudo",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ansible-exec HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return {
    status: Number(json.status ?? -1),
    stdout: String(json.stdout ?? ""),
    stderr: String(json.stderr ?? ""),
  };
}

export async function ansibleUpload(
  host: string,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `http://${host}:6677/ansible/agent/upload`;
  const file = await readFile(localPath);
  const blob = new Blob([file]);

  const form = new FormData();
  form.set("dest", remotePath);
  form.set("src", blob, basename(localPath));

  const res = await fetch(url, {
    method: "PUT",
    body: form,
    signal,
  });

  const text = await res.text();
  if (!res.ok || !text.includes("SUCCESS")) {
    throw new Error(`ansible-upload HTTP ${res.status}: ${text}`);
  }
}
