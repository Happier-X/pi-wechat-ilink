#!/usr/bin/env node
/**
 * pi-lark-hub CLI：启动本机多 Pi 飞书协调守护进程。
 *
 * 用法：
 *   npm run hub
 *   npx tsx src/hub/cli.ts --port 8765
 *   PI_LARK_FEISHU_MODE=lark-cli npx tsx src/hub/cli.ts
 */

import {
	assertValidHubConfig,
	formatConfigSummary,
	loadHubConfig,
	type HubConfig,
} from "./config.js";
import { startFeishuInbound } from "./feishu-inbound.js";
import { LarkCliFeishuTransport } from "./feishu-lark-cli.js";
import { ConsoleFeishuTransport } from "./feishu-transport.js";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, startHubServer } from "./server.js";

function printHelp(): void {
	console.log(`pi-lark-hub — 本机多 Pi 飞书协调守护进程（Phase 0–5）

用法:
  pi-lark-hub [--port <n>] [--host 127.0.0.1]

选项:
  --port, -p     监听端口（默认 ${DEFAULT_HUB_PORT}，或环境变量 PI_LARK_HUB_PORT / 配置文件）
  --host         仅允许 127.0.0.1 / localhost（默认 ${DEFAULT_HUB_HOST}）
  --help, -h     显示帮助

配置:
  文件: ~/.pi/lark-hub/config.json（可用 PI_LARK_HUB_CONFIG 覆盖路径）
  合并: defaults < 配置文件 < 环境变量
  环境变量:
    PI_LARK_HUB_PORT
    PI_LARK_ALLOWED_OPEN_IDS          逗号分隔 open_id
    PI_LARK_FEISHU_MODE               console | lark-cli（默认 console）
    PI_LARK_FEISHU_USER_ID            ou_xxx
    PI_LARK_FEISHU_CHAT_ID            oc_xxx
    PI_LARK_REQUIRE_ALLOWLIST         true|false
    PI_LARK_HUB_CONFIG                配置文件路径

HTTP:
  GET  /health
  GET  /instances
  GET  /notifications
  GET  /approvals
  POST /control/message
  POST /control/approval

WebSocket:
  ws://127.0.0.1:<port>/  Pi 扩展

真实飞书:
  见 docs/lark-hub.md（mode=lark-cli + lark-cli auth + 白名单）
`);
}

function parseArgs(argv: string[]): { port?: number; host?: string; help?: boolean } {
	const out: { port?: number; host?: string; help?: boolean } = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--help" || a === "-h") {
			out.help = true;
		} else if (a === "--port" || a === "-p") {
			const v = Number(argv[++i]);
			if (!Number.isFinite(v) || v <= 0) throw new Error(`无效端口: ${argv[i]}`);
			out.port = v;
		} else if (a === "--host") {
			out.host = argv[++i];
		} else if (a.startsWith("--port=")) {
			out.port = Number(a.slice("--port=".length));
		} else {
			throw new Error(`未知参数: ${a}`);
		}
	}
	return out;
}

function createFeishuTransport(config: HubConfig) {
	if (config.feishu.mode === "lark-cli") {
		return new LarkCliFeishuTransport({
			as: config.feishu.as,
			userId: config.feishu.userId,
			chatId: config.feishu.chatId,
		});
	}
	return new ConsoleFeishuTransport();
}

async function main(): Promise<void> {
	let args: ReturnType<typeof parseArgs>;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		printHelp();
		process.exit(1);
		return;
	}

	if (args.help) {
		printHelp();
		return;
	}

	let config: HubConfig;
	try {
		config = loadHubConfig();
	} catch (error) {
		console.error(
			"[pi-lark-hub] 配置加载失败:",
			error instanceof Error ? error.message : error,
		);
		process.exit(1);
		return;
	}

	// CLI --port / --host 覆盖配置
	if (args.port !== undefined) config.port = args.port;
	if (args.host !== undefined) {
		if (args.host !== "127.0.0.1" && args.host !== "localhost") {
			console.error(`[pi-lark-hub] 安全限制：仅允许 loopback，收到 host=${args.host}`);
			process.exit(1);
			return;
		}
		config.host = "127.0.0.1";
	}

	try {
		assertValidHubConfig(config);
	} catch (error) {
		console.error(
			"[pi-lark-hub] 配置校验失败:\n",
			error instanceof Error ? error.message : error,
		);
		process.exit(1);
		return;
	}

	console.log("[pi-lark-hub] 配置摘要:");
	console.log(formatConfigSummary(config));

	const feishu = createFeishuTransport(config);
	let inboundStop: (() => void) | undefined;

	const hub = await startHubServer({
		host: config.host,
		port: config.port,
		feishu,
		allowedOpenIds: config.allowedOpenIds,
		hubConfig: config,
		consoleAllowEmptyAllowlist: config.feishu.mode === "console",
		onReady: (server) => {
			if (config.feishu.mode !== "lark-cli") return;

			// 可选入站：失败仅告警
			try {
				const consumer = startFeishuInbound({
					as: config.feishu.as,
					handlers: {
						onMessage: async (input) => {
							const r = await server.handleInboundMessage(input);
							return { ok: r.ok, reply: r.reply };
						},
						onApproval: async (input) => {
							const r = await server.handleInboundApproval(input);
							return { ok: r.ok, reply: r.reply };
						},
						replyToUser: async (text) => {
							try {
								await server.feishu.send({
									title: "Hub",
									body: text,
								});
							} catch (error) {
								const msg =
									error instanceof Error ? error.message : String(error);
								console.error(`[pi-lark-hub] 回写飞书失败: ${msg}`);
							}
						},
					},
					log: (line) => console.log(line),
				});
				inboundStop = () => consumer.stop();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.warn(
					`[pi-lark-hub] 飞书入站未启动: ${msg}；仍可用 HTTP /control/* 或 curl`,
				);
			}
		},
	});

	if (config.allowedOpenIds.length > 0) {
		console.log(
			`[pi-lark-hub] 白名单已启用：${config.allowedOpenIds.length} 个 openId`,
		);
	} else if (config.feishu.mode === "console") {
		console.log(
			"[pi-lark-hub] console 模式且未配置白名单：入站全部放行（仅开发）",
		);
	} else {
		console.log(
			"[pi-lark-hub] 白名单为空（bootstrap）：请在 Pi 执行 /lark-pair，飞书发送「配对 <码>」完成本人绑定",
		);
	}

	console.log(`[pi-lark-hub] 已启动 http://${hub.host}:${hub.port}`);
	console.log(`[pi-lark-hub] 健康检查: curl http://${hub.host}:${hub.port}/health`);
	if (config.feishu.mode === "console") {
		console.log(`[pi-lark-hub] 模拟飞书: POST /control/message`);
	} else {
		console.log(
			`[pi-lark-hub] 飞书出站: lark-cli；入站: event consume（失败则仅 HTTP）`,
		);
	}

	const shutdown = async (signal: string) => {
		console.log(`\n[pi-lark-hub] 收到 ${signal}，正在关闭…`);
		try {
			inboundStop?.();
		} catch {
			// ignore
		}
		try {
			await hub.close();
		} catch (error) {
			console.error("[pi-lark-hub] 关闭异常:", error);
		}
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
	console.error("[pi-lark-hub] 启动失败:", error instanceof Error ? error.message : error);
	process.exit(1);
});
