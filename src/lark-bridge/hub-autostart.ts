/**
 * Bridge 侧本机 Hub 自动拉起：探测 /health → 可选 spawn → 轮询就绪。
 * 仅 loopback；stdio ignore，不污染 Pi TUI。
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type EnsureHubStatus =
	| "ready"
	| "skipped"
	| "spawned-ready"
	| "failed";

export type EnsureHubResult = {
	status: EnsureHubStatus;
	detail?: string;
};

export type HubSpawnSpec = {
	command: string;
	args: string[];
	cwd: string;
};

export type EnsureHubRunningOptions = {
	hubWsUrl?: string;
	env?: NodeJS.ProcessEnv;
	/** 距上次 spawn 尝试的冷却（ms） */
	cooldownMs?: number;
	/** 单次 health 请求超时 */
	probeTimeoutMs?: number;
	/** spawn 后等待 health 的总时长 */
	readyTimeoutMs?: number;
	/** health 轮询间隔 */
	pollIntervalMs?: number;
	/** 解析包根用的模块 URL，默认 import.meta.url */
	moduleUrl?: string;
	/** 可注入时钟（测试） */
	now?: () => number;
	/** 可注入探测（测试） */
	probe?: (httpOrigin: string, timeoutMs: number) => Promise<boolean>;
	/** 可注入 spawn（测试） */
	spawnFn?: (spec: HubSpawnSpec) => { ok: true } | { ok: false; error: string };
	/** 可注入 sleep（测试） */
	sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 400;

/** 每进程上次 spawn 尝试时间（满足冷却） */
let lastSpawnAttemptAt = 0;

/** 测试用：重置冷却状态 */
export function resetAutostartCooldownState(): void {
	lastSpawnAttemptAt = 0;
}

export function isAutostartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.PI_LARK_HUB_AUTOSTART;
	if (raw === undefined || raw.trim() === "") return true;
	const v = raw.trim().toLowerCase();
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
	if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
	// 未知值：保守开启（与「默认开」一致）
	return true;
}

/**
 * 将 bridge 的 WS URL 转为 loopback HTTP origin；非本机返回 null。
 */
export function hubUrlToHttpOrigin(wsUrl: string): string | null {
	try {
		const u = new URL(wsUrl);
		const host = u.hostname.toLowerCase();
		if (host !== "127.0.0.1" && host !== "localhost") return null;
		const protocol = u.protocol === "wss:" ? "https:" : "http:";
		// ws:// 无显式端口时按产品默认 8765（与 DEFAULT_HUB_URL 一致）
		const effectivePort =
			u.port ||
			(u.protocol === "ws:" || u.protocol === "http:"
				? "8765"
				: u.protocol === "wss:" || u.protocol === "https:"
					? "443"
					: "8765");
		const normalizedHost = host === "localhost" ? "127.0.0.1" : host;
		return `${protocol}//${normalizedHost}:${effectivePort}`;
	} catch {
		return null;
	}
}

export function resolvePackageRoot(fromUrl: string = import.meta.url): string {
	// .../src/lark-bridge/xxx → package root
	const dir = path.dirname(fileURLToPath(fromUrl));
	return path.resolve(dir, "..", "..");
}

export function resolveHubSpawnSpec(
	packageRoot: string,
): HubSpawnSpec | { error: string } {
	const mjs = path.join(packageRoot, "scripts", "pi-lark-hub.mjs");
	if (existsSync(mjs)) {
		return {
			command: process.execPath,
			args: [mjs],
			cwd: packageRoot,
		};
	}

	const cliTs = path.join(packageRoot, "src", "hub", "cli.ts");
	if (!existsSync(cliTs)) {
		return {
			error: `未找到 hub 入口（期望 ${mjs} 或 ${cliTs}）`,
		};
	}

	try {
		const require = createRequire(path.join(packageRoot, "package.json"));
		const tsxCli = require.resolve("tsx/cli");
		return {
			command: process.execPath,
			args: [tsxCli, cliTs],
			cwd: packageRoot,
		};
	} catch {
		return {
			error:
				"未找到 tsx。请在 pi-lark-hub 包目录执行 npm install 后重试（Pi 的 git install 一般会自动安装依赖）。",
		};
	}
}

export function probeHubHealth(
	httpOrigin: string,
	timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	return new Promise((resolve) => {
		const url = `${httpOrigin.replace(/\/$/, "")}/health`;
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				if (res.statusCode !== 200) {
					resolve(false);
					return;
				}
				try {
					const body = Buffer.concat(chunks).toString("utf8");
					const json = JSON.parse(body) as { ok?: unknown };
					resolve(json.ok === true);
				} catch {
					resolve(false);
				}
			});
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
	});
}

export function spawnHubDetached(
	spec: HubSpawnSpec,
): { ok: true } | { ok: false; error: string } {
	try {
		const opts: SpawnOptions = {
			cwd: spec.cwd,
			detached: true,
			stdio: "ignore",
			env: process.env,
			windowsHide: true,
		};
		const child = spawn(spec.command, spec.args, opts);
		child.unref();
		child.on("error", () => {
			// detached 后错误难向上抛；ensure 靠 health 超时反映
		});
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * 确保本机 loopback Hub 可达；必要时 detached spawn 一次（带冷却）。
 */
export async function ensureHubRunning(
	options: EnsureHubRunningOptions = {},
): Promise<EnsureHubResult> {
	const env = options.env ?? process.env;
	const hubWsUrl = options.hubWsUrl ?? env.PI_LARK_HUB_URL ?? "ws://127.0.0.1:8765";
	const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const probe = options.probe ?? probeHubHealth;
	const spawnFn = options.spawnFn ?? spawnHubDetached;
	const sleep = options.sleep ?? defaultSleep;
	const moduleUrl = options.moduleUrl ?? import.meta.url;

	if (!isAutostartEnabled(env)) {
		return {
			status: "skipped",
			detail: "已关闭自动拉起（PI_LARK_HUB_AUTOSTART=0）",
		};
	}

	const httpOrigin = hubUrlToHttpOrigin(hubWsUrl);
	if (!httpOrigin) {
		return {
			status: "skipped",
			detail: `Hub URL 非本机 loopback，跳过自动拉起：${hubWsUrl}`,
		};
	}

	if (await probe(httpOrigin, probeTimeoutMs)) {
		return { status: "ready", detail: "Hub 已在运行" };
	}

	const t = now();
	if (lastSpawnAttemptAt > 0 && t - lastSpawnAttemptAt < cooldownMs) {
		// 冷却内：再探一次（可能别的 Pi 刚拉起）
		if (await probe(httpOrigin, probeTimeoutMs)) {
			return { status: "ready", detail: "Hub 已在运行" };
		}
		return {
			status: "skipped",
			detail: `自动拉起冷却中（${Math.ceil((cooldownMs - (t - lastSpawnAttemptAt)) / 1000)}s），稍后重试连接`,
		};
	}

	const packageRoot = resolvePackageRoot(moduleUrl);
	const specOrErr = resolveHubSpawnSpec(packageRoot);
	if ("error" in specOrErr) {
		return { status: "failed", detail: specOrErr.error };
	}

	lastSpawnAttemptAt = t;
	const spawned = spawnFn(specOrErr);
	if (!spawned.ok) {
		return {
			status: "failed",
			detail: `启动 Hub 进程失败：${spawned.error}`,
		};
	}

	const deadline = t + readyTimeoutMs;
	while (now() < deadline) {
		if (await probe(httpOrigin, probeTimeoutMs)) {
			return { status: "spawned-ready", detail: "已自动启动本机 Hub" };
		}
		await sleep(pollIntervalMs);
	}

	// 最后一次探测
	if (await probe(httpOrigin, probeTimeoutMs)) {
		return { status: "spawned-ready", detail: "已自动启动本机 Hub" };
	}

	return {
		status: "failed",
		detail:
			`自动启动 Hub 超时（${httpOrigin}）。可检查：包目录依赖是否完整（npm install）、端口是否被其它程序占用；也可手动在包目录执行 npm run hub。关闭自动拉起：PI_LARK_HUB_AUTOSTART=0`,
	};
}
