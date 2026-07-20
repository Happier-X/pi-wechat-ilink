import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceFileAtomic } from "./atomic-file.js";

export type FeishuCredentials = { appId: string; appSecret: string; brand: "feishu" | "lark"; updatedAt: number };
export function credentialsPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
 return env.PI_LARK_HUB_CREDENTIALS?.trim() || path.join(home, ".pi", "lark-hub", "credentials.json");
}
export function loadCredentials(filePath = credentialsPath()): FeishuCredentials | null {
 if (!existsSync(filePath)) return null;
 try { const v = JSON.parse(readFileSync(filePath, "utf8")); if (!v.appId || !v.appSecret) return null; return { appId: String(v.appId), appSecret: String(v.appSecret), brand: v.brand === "lark" ? "lark" : "feishu", updatedAt: Number(v.updatedAt) || 0 }; } catch { return null; }
}
export function deleteCredentials(filePath = credentialsPath()): void { rmSync(filePath, { force: true }); }
export function saveCredentials(value: Omit<FeishuCredentials, "updatedAt"> & { updatedAt?: number }, filePath = credentialsPath()): FeishuCredentials {
 const next = { ...value, updatedAt: value.updatedAt ?? Date.now() };
 mkdirSync(path.dirname(filePath), { recursive: true });
 const tmp = `${filePath}.${process.pid}.tmp`;
 writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
 try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
 replaceFileAtomic(tmp, filePath);
 return next;
}
