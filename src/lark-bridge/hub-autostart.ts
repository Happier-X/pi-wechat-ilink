/**
 * Bridge 侧本机 Hub 自动拉起：探测 /health → 可选 spawn → 轮询就绪。
 * 仅 loopback；子进程日志写入 ~/.pi/lark-hub/hub.log，不污染 Pi TUI。
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import {
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	appendFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
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

export type HubHealthStatus = {
	ok: boolean;
	pid?: number;
	packageVersion?: string;
	features?: string[];
	feishuMode?: string;
	ownerBound?: boolean;
	needsPairing?: boolean;
};

export const REQUIRED_HUB_FEATURES = ["pair_begin"] as const;

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
	/** Hub 子进程日志路径（默认 ~/.pi/lark-hub/hub.log） */
	logPath?: string;
	/** 可注入时钟（测试） */
	now?: () => number;
	/** 可注入探测（测试） */
	probe?: (httpOrigin: string, timeoutMs: number) => Promise<boolean>;
	/** 可注入 health 详情探测（stale 判定） */
	probeDetail?: (httpOrigin: string, timeoutMs: number) => Promise<HubHealthStatus | null>;
	/** 可注入 kill（测试） */
	killFn?: (pid: number) => void;
	/** 可注入 spawn（测试） */
	spawnFn?: (
		spec: HubSpawnSpec,
		logPath: string,
	) => { ok: true; logPath: string } | { ok: false; error: string; logPath?: string };
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

export function isAutorestartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.PI_LARK_HUB_AUTORESTART;
	if (raw === undefined || raw.trim() === "") return true;
	return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
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

export function defaultHubLogPath(home = os.homedir()): string {
	return path.join(home, ".pi", "lark-hub", "hub.log");
}

export function resolvePackageRoot(fromUrl: string = import.meta.url): string {
	// .../src/lark-bridge/xxx → package root
	const dir = path.dirname(fileURLToPath(fromUrl));
	return path.resolve(dir, "..", "..");
}

function resolveTsxCli(packageRoot: string): string | null {
	try {
		const require = createRequire(path.join(packageRoot, "package.json"));
		return require.resolve("tsx/cli");
	} catch {
		return null;
	}
}

export function resolveHubSpawnSpec(
	packageRoot: string,
): HubSpawnSpec | { error: string } {
	const mjs = path.join(packageRoot, "scripts", "pi-lark-hub.mjs");
	const cliTs = path.join(packageRoot, "src", "hub", "cli.ts");
	const tsxCli = resolveTsxCli(packageRoot);

	if (!tsxCli) {
		return {
			error:
				"未找到运行时依赖 tsx（scripts/pi-lark-hub.mjs 需要它）。请在 pi-lark-hub 包目录执行 npm install，或 pi update 后重装本包。",
		};
	}

	if (existsSync(mjs)) {
		return {
			command: process.execPath,
			args: [mjs],
			cwd: packageRoot,
		};
	}

	if (!existsSync(cliTs)) {
		return {
			error: `未找到 hub 入口（期望 ${mjs} 或 ${cliTs}）`,
		};
	}

	return {
		command: process.execPath,
		args: [tsxCli, cliTs],
		cwd: packageRoot,
	};
}

/** 是否应自动发起 pair_begin（每进程最多一次） */
export function shouldAutoPair(input: {
	needsPairing: boolean;
	autoPairAttempted: boolean;
}): boolean {
	return input.needsPairing && !input.autoPairAttempted;
}

export function isHubCompatible(
	status: HubHealthStatus | null,
	required: readonly string[] = REQUIRED_HUB_FEATURES,
): boolean {
	if (!status?.ok || !Array.isArray(status.features)) return false;
	return required.every((feature) => status.features!.includes(feature));
}

export function stopStaleHub(
	pid: number | undefined,
	killFn: (pid: number) => void = (value) => process.kill(value, "SIGTERM"),
): { ok: true } | { ok: false; error: string } {
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		pid === process.pid
	) {
		return {
			ok: false,
			error: "旧 Hub health 未提供合法 pid，无法自动重启；请手动重启 Hub",
		};
	}
	try {
		killFn(pid);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: `结束旧 Hub（pid=${pid}）失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export type HubPairingStatus = {
	ok: boolean;
	feishuMode?: string;
	ownerBound?: boolean;
	needsPairing: boolean;
};

/** GET /health 解析配对相关字段；失败返回 null */
export function fetchHubHealthDetail(
	httpOrigin: string,
	timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<HubHealthStatus | null> {
	return new Promise((resolve) => {
		const req = http.get(`${httpOrigin.replace(/\/$/, "")}/health`, { timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				if (res.statusCode !== 200) return resolve(null);
				try {
					const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HubHealthStatus;
					resolve(value.ok === true ? value : null);
				} catch { resolve(null); }
			});
		});
		req.on("timeout", () => { req.destroy(); resolve(null); });
		req.on("error", () => resolve(null));
	});
}

export function fetchHubPairingStatus(
	httpOrigin: string,
	timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<HubPairingStatus | null> {
	return new Promise((resolve) => {
		const url = `${httpOrigin.replace(/\/$/, "")}/health`;
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				if (res.statusCode !== 200) {
					resolve(null);
					return;
				}
				try {
					const body = Buffer.concat(chunks).toString("utf8");
					const json = JSON.parse(body) as {
						ok?: unknown;
						feishuMode?: unknown;
						ownerBound?: unknown;
						needsPairing?: unknown;
					};
					if (json.ok !== true) {
						resolve(null);
						return;
					}
					resolve({
						ok: true,
						feishuMode:
							typeof json.feishuMode === "string" ? json.feishuMode : undefined,
						ownerBound:
							typeof json.ownerBound === "boolean" ? json.ownerBound : undefined,
						needsPairing: json.needsPairing === true,
					});
				} catch {
					resolve(null);
				}
			});
		});
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
		req.on("error", () => resolve(null));
	});
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

function ensureLogFile(logPath: string): { fd: number } | { error: string } {
	try {
		mkdirSync(path.dirname(logPath), { recursive: true });
		const stamp = new Date().toISOString();
		appendFileSync(
			logPath,
			`\n----- pi-lark-hub autostart ${stamp} -----\n`,
			"utf8",
		);
		const fd = openSync(logPath, "a");
		return { fd };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function spawnHubDetached(
	spec: HubSpawnSpec,
	logPath: string = defaultHubLogPath(),
): { ok: true; logPath: string } | { ok: false; error: string; logPath?: string } {
	const opened = ensureLogFile(logPath);
	if ("error" in opened) {
		return {
			ok: false,
			error: `无法写入 Hub 日志 ${logPath}：${opened.error}`,
			logPath,
		};
	}

	const { fd } = opened;
	try {
		const opts: SpawnOptions = {
			cwd: spec.cwd,
			detached: true,
			// stdin ignore；stdout/stderr 进 hub.log，避免污染 TUI
			stdio: ["ignore", fd, fd],
			env: process.env,
			windowsHide: true,
		};
		const child = spawn(spec.command, spec.args, opts);
		// 父进程不再持有 fd；子进程继续写日志
		try {
			closeSync(fd);
		} catch {
			// ignore
		}
		child.unref();
		child.on("error", () => {
			// detached 后错误难向上抛；ensure 靠 health + 日志
		});
		return { ok: true, logPath };
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			// ignore
		}
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			logPath,
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
	// 旧测试/调用方只注入 boolean probe 时，视为兼容 health；生产使用详情探测
	const probeDetail = options.probeDetail ??
		(options.probe
			? async (origin: string, timeout: number): Promise<HubHealthStatus | null> =>
				(await options.probe!(origin, timeout))
					? { ok: true, features: [...REQUIRED_HUB_FEATURES] }
					: null
			: fetchHubHealthDetail);
	const spawnFn = options.spawnFn ?? spawnHubDetached;
	const killFn = options.killFn;
	const sleep = options.sleep ?? defaultSleep;
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	const logPath = options.logPath ?? defaultHubLogPath();

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

	const health = await probeDetail(httpOrigin, probeTimeoutMs);
	if (isHubCompatible(health)) {
		return { status: "ready", detail: "Hub 已在运行" };
	}

	if (health?.ok && !isHubCompatible(health)) {
		if (!isAutorestartEnabled(env)) {
			return {
				status: "skipped",
				detail:
					"Hub 版本过期，但已关闭自动重启（PI_LARK_HUB_AUTORESTART=0）",
			};
		}
		const stopped = stopStaleHub(health.pid, killFn);
		if (!stopped.ok) return { status: "failed", detail: stopped.error };

		// 等旧 Hub 下线，避免新进程抢不到端口；超时禁止继续 spawn
		const stopDeadline = now() + Math.min(readyTimeoutMs, 5_000);
		let oldHubStillOnline = await probe(httpOrigin, probeTimeoutMs);
		while (now() < stopDeadline && oldHubStillOnline) {
			await sleep(pollIntervalMs);
			oldHubStillOnline = await probe(httpOrigin, probeTimeoutMs);
		}
		if (oldHubStillOnline) {
			return {
				status: "failed",
				detail: `旧 Hub（pid=${health.pid}）在 SIGTERM 后仍未退出；为避免端口冲突，未启动新 Hub，请手动重启`,
			};
		}
	}

	const t = now();
	if (lastSpawnAttemptAt > 0 && t - lastSpawnAttemptAt < cooldownMs) {
		// 冷却内：再探一次（可能别的 Pi 刚拉起）
		const detail = await probeDetail(httpOrigin, probeTimeoutMs);
		if (isHubCompatible(detail)) {
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
		return {
			status: "failed",
			detail: `${specOrErr.error} 日志：${logPath}`,
		};
	}

	lastSpawnAttemptAt = t;
	const spawned = spawnFn(specOrErr, logPath);
	if (!spawned.ok) {
		return {
			status: "failed",
			detail: `启动 Hub 进程失败：${spawned.error}${spawned.logPath ? ` 日志：${spawned.logPath}` : ""}`,
		};
	}

	const usedLog = spawned.logPath ?? logPath;
	const deadline = t + readyTimeoutMs;
	while (now() < deadline) {
		if (isHubCompatible(await probeDetail(httpOrigin, probeTimeoutMs))) {
			return {
				status: "spawned-ready",
				detail: `已自动启动本机 Hub（日志：${usedLog}）`,
			};
		}
		await sleep(pollIntervalMs);
	}

	// 最后一次探测
	if (isHubCompatible(await probeDetail(httpOrigin, probeTimeoutMs))) {
		return {
			status: "spawned-ready",
			detail: `已自动启动本机 Hub（日志：${usedLog}）`,
		};
	}

	return {
		status: "failed",
		detail:
			`自动启动 Hub 超时（${httpOrigin}）。请查看日志：${usedLog}。常见原因：包依赖未装全（需含生产依赖 tsx）、端口被占用。也可在包目录手动 npm install && npm run hub。关闭自动拉起：PI_LARK_HUB_AUTOSTART=0`,
	};
}
