/**
 * hub-autostart 纯函数与 ensure 流程单测（不真实长时间跑 hub）。
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";
import {
	defaultHubLogPath,
	ensureHubRunning,
	hubUrlToHttpOrigin,
	isAutostartEnabled,
	resetAutostartCooldownState,
	resolveHubSpawnSpec,
	resolvePackageRoot,
} from "./hub-autostart.js";

const okSpawn = (logPath = "/tmp/hub-test.log") =>
	({ ok: true as const, logPath });

describe("isAutostartEnabled", () => {
	it("默认开启（未设置）", () => {
		assert.equal(isAutostartEnabled({}), true);
		assert.equal(isAutostartEnabled({ PI_LARK_HUB_AUTOSTART: "" }), true);
	});

	it("falsy 关闭", () => {
		for (const v of ["0", "false", "FALSE", "no", "off", " Off "]) {
			assert.equal(isAutostartEnabled({ PI_LARK_HUB_AUTOSTART: v }), false, v);
		}
	});

	it("truthy 开启", () => {
		for (const v of ["1", "true", "yes", "on"]) {
			assert.equal(isAutostartEnabled({ PI_LARK_HUB_AUTOSTART: v }), true, v);
		}
	});
});

describe("hubUrlToHttpOrigin", () => {
	it("解析默认 ws 与显式端口", () => {
		assert.equal(
			hubUrlToHttpOrigin("ws://127.0.0.1:8765"),
			"http://127.0.0.1:8765",
		);
		assert.equal(
			hubUrlToHttpOrigin("ws://127.0.0.1"),
			"http://127.0.0.1:8765",
		);
		assert.equal(
			hubUrlToHttpOrigin("ws://localhost:9001"),
			"http://127.0.0.1:9001",
		);
	});

	it("非 loopback 返回 null", () => {
		assert.equal(hubUrlToHttpOrigin("ws://192.168.1.2:8765"), null);
		assert.equal(hubUrlToHttpOrigin("wss://example.com/hub"), null);
	});

	it("非法 URL 返回 null", () => {
		assert.equal(hubUrlToHttpOrigin("not-a-url"), null);
	});
});

describe("resolvePackageRoot / resolveHubSpawnSpec", () => {
	it("从 lark-bridge 路径定位包根并能解析 spawn 入口", () => {
		const root = resolvePackageRoot(import.meta.url);
		const bridgeUrl = pathToFileURL(
			path.join(root, "src", "lark-bridge", "index.ts"),
		).href;
		const fromBridge = resolvePackageRoot(bridgeUrl);
		assert.equal(path.normalize(fromBridge), path.normalize(root));

		const spec = resolveHubSpawnSpec(root);
		assert.ok(!("error" in spec), "error" in spec ? spec.error : "");
		if (!("error" in spec)) {
			assert.equal(spec.command, process.execPath);
			assert.ok(spec.args.length >= 1);
			assert.equal(path.normalize(spec.cwd), path.normalize(root));
		}
	});
});

describe("ensureHubRunning", () => {
	beforeEach(() => {
		resetAutostartCooldownState();
	});

	it("defaultHubLogPath 指向 ~/.pi/lark-hub/hub.log", () => {
		const p = defaultHubLogPath("/home/user");
		assert.ok(p.replace(/\\/g, "/").endsWith(".pi/lark-hub/hub.log"));
	});

	it("autostart 关闭时 skipped 且不 spawn", async () => {
		let spawned = 0;
		const r = await ensureHubRunning({
			env: { PI_LARK_HUB_AUTOSTART: "0" },
			hubWsUrl: "ws://127.0.0.1:8765",
			probe: async () => false,
			spawnFn: (_spec, logPath) => {
				spawned++;
				return okSpawn(logPath);
			},
		});
		assert.equal(r.status, "skipped");
		assert.match(r.detail ?? "", /关闭自动拉起/);
		assert.equal(spawned, 0);
	});

	it("非 loopback skipped", async () => {
		let spawned = 0;
		const r = await ensureHubRunning({
			env: {},
			hubWsUrl: "ws://10.0.0.1:8765",
			probe: async () => false,
			spawnFn: (_spec, logPath) => {
				spawned++;
				return okSpawn(logPath);
			},
		});
		assert.equal(r.status, "skipped");
		assert.equal(spawned, 0);
	});

	it("health 已就绪 → ready 不 spawn", async () => {
		let spawned = 0;
		const r = await ensureHubRunning({
			env: {},
			hubWsUrl: "ws://127.0.0.1:8765",
			probe: async () => true,
			spawnFn: (_spec, logPath) => {
				spawned++;
				return okSpawn(logPath);
			},
		});
		assert.equal(r.status, "ready");
		assert.equal(spawned, 0);
	});

	it("不可达时 spawn 并轮询到 ready → spawned-ready", async () => {
		let probes = 0;
		let spawned = 0;
		let clock = 1_000_000;
		const r = await ensureHubRunning({
			env: {},
			hubWsUrl: "ws://127.0.0.1:8765",
			logPath: "C:/tmp/hub-autostart-test.log",
			probeTimeoutMs: 50,
			readyTimeoutMs: 2_000,
			pollIntervalMs: 100,
			probe: async () => {
				probes++;
				return probes > 1;
			},
			spawnFn: (_spec, logPath) => {
				spawned++;
				return okSpawn(logPath);
			},
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
		});
		assert.equal(r.status, "spawned-ready");
		assert.equal(spawned, 1);
		assert.match(r.detail ?? "", /hub-autostart-test\.log/);
	});

	it("超时失败文案包含日志路径", async () => {
		let clock = 1_000_000;
		const r = await ensureHubRunning({
			env: {},
			hubWsUrl: "ws://127.0.0.1:8765",
			logPath: "C:/tmp/hub-timeout.log",
			cooldownMs: 30_000,
			probeTimeoutMs: 50,
			readyTimeoutMs: 300,
			pollIntervalMs: 100,
			probe: async () => false,
			spawnFn: (_spec, logPath) => okSpawn(logPath),
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
		});
		assert.equal(r.status, "failed");
		assert.match(r.detail ?? "", /hub-timeout\.log/);
		assert.match(r.detail ?? "", /tsx/);
	});

	it("冷却内第二次不 spawn", async () => {
		let spawned = 0;
		let clock = 1_000_000;
		const opts = {
			env: {} as NodeJS.ProcessEnv,
			hubWsUrl: "ws://127.0.0.1:8765",
			logPath: "C:/tmp/hub-cool.log",
			cooldownMs: 30_000,
			probeTimeoutMs: 50,
			readyTimeoutMs: 300,
			pollIntervalMs: 100,
			probe: async () => false,
			spawnFn: (_spec: unknown, logPath: string) => {
				spawned++;
				return okSpawn(logPath);
			},
			sleep: async (ms: number) => {
				clock += ms;
			},
			now: () => clock,
		};

		const first = await ensureHubRunning(opts);
		assert.equal(first.status, "failed");
		assert.equal(spawned, 1);

		// 仍在 30s 冷却（ready 轮询已推进部分时钟，再加一点仍 < 30s）
		clock = 1_000_000 + 5_000;
		const second = await ensureHubRunning(opts);
		assert.equal(second.status, "skipped");
		assert.match(second.detail ?? "", /冷却/);
		assert.equal(spawned, 1);
	});
});
