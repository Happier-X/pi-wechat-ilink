/**
 * pi-lark-hub：loopback WebSocket（Pi 连接）+ HTTP 控制面（模拟飞书入站）。
 * 仅监听 127.0.0.1。
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";
import {
	generatePiId,
	parseProtocolMessage,
	serializeMessage,
	type Capability,
	type HubToPiMessage,
	type MessageSource,
	HUB_FEATURES,
	type NotifyMessage,
	type PiToHubMessage,
} from "../protocol.js";
import { ApprovalStore, DEFAULT_APPROVAL_TIMEOUT_MS } from "./approvals.js";
import { MessageBindingStore } from "./bindings.js";
import { defaultConfigPath, resetNativeConfig, saveNativeSetupConfig, type HubConfig } from "./config.js";
import { credentialsPath, deleteCredentials, loadCredentials, saveCredentials } from "./credentials.js";
import { FeishuRegistrationClient } from "./feishu-registration.js";
import { NativeFeishuTransport } from "./feishu-native.js";
import { handleControlApproval, handleControlMessage } from "./control.js";
import type { FeishuTransport } from "./feishu-transport.js";
import { NoopFeishuTransport } from "./feishu-transport.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS, InstanceRegistry } from "./registry.js";

export const DEFAULT_HUB_PORT = 8765;
export const DEFAULT_HUB_HOST = "127.0.0.1";

const packageVersion = (() => {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require("../../package.json") as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
})();

export type HubServerOptions = {
	host?: string;
	port?: number;
	heartbeatTimeoutMs?: number;
	feishu?: FeishuTransport;
	bindings?: MessageBindingStore;
	approvals?: ApprovalStore;
	/** 唯一可信主人 openId；未开局时为空并拒绝所有飞书入站。 */
	allowedOpenIds?: string[];
	/** 用于落盘绑定的配置路径/基线 */
	hubConfig?: HubConfig;
	log?: (line: string) => void;
	/** 扫码注册客户端（测试可注入） */
	registration?: FeishuRegistrationClient;
	credentialsFile?: string;
	/** setup 成功时启动原生 WS；抛错会阻止 mode/transport 切换 */
	onNativeRuntime?: (transport: NativeFeishuTransport, credentials: import("./credentials.js").FeishuCredentials, hub: HubServer) => void | (() => void) | Promise<void | (() => void)>;
	/**
	 * 可选：启动后调用（例如挂载飞书 event consume）。
	 * 接收已绑定的 control 回调；失败不应抛弃 Hub。
	 */
	onReady?: (hub: HubServer) => void | (() => void) | Promise<void | (() => void)>;
};

export type ControlDeliveryResult = {
	ok: boolean;
	reply: string;
	deliveredTo?: string | null;
	source?: MessageSource;
	decision?: unknown;
	alreadyHandled?: boolean;
};

export type HubServer = {
	host: string;
	port: number;
	registry: InstanceRegistry;
	bindings: MessageBindingStore;
	approvals: ApprovalStore;
	feishu: FeishuTransport;
	/** 与 POST /control/message 相同路径（供飞书入站复用） */
	handleInboundMessage: (input: {
		text: string;
		openId?: string;
		replyToMessageId?: string;
	}) => Promise<ControlDeliveryResult>;
	/** 与 POST /control/approval 相同路径 */
	handleInboundApproval: (input: {
		requestId: string;
		decision: "approve" | "reject";
		openId?: string;
	}) => Promise<ControlDeliveryResult>;
	close: () => Promise<void>;
};

type ClientState = {
	connectionId: string;
	piId: string | null;
	socket: WebSocket;
};

export async function startHubServer(options: HubServerOptions = {}): Promise<HubServer> {
	const host = options.host ?? DEFAULT_HUB_HOST;
	if (host !== "127.0.0.1" && host !== "localhost") {
		throw new Error(`安全限制：Hub 仅允许监听 loopback，收到 host=${host}`);
	}

	const envPort = Number(process.env.PI_LARK_HUB_PORT);
	const port =
		options.port ??
		(Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_HUB_PORT);
	const log = options.log ?? ((line: string) => console.log(line));
	let feishu: FeishuTransport = options.feishu ?? new NoopFeishuTransport();
	const registration = options.registration ?? new FeishuRegistrationClient();
	const bindings = options.bindings ?? new MessageBindingStore();
	const allowed = new Set(options.allowedOpenIds ?? []);
	let hubConfigSnapshot = options.hubConfig;


	const registry = new InstanceRegistry({
		heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
	});
	registry.startSweeper();

	const clients = new Map<string, ClientState>();
	const piSockets = new Map<string, WebSocket>(); // piId → socket
	let setupInFlight = false;
	let setupAbort: AbortController | null = null;
	let setupTask: Promise<void> | null = null;
	let nativeRuntimeStop: (() => void) | undefined;

	const isAuthorized = (openId?: string): boolean => {
		if (allowed.size === 0) return false;
		if (!openId) return false;
		return allowed.has(openId);
	};


	const isPiSocketOnline = (piId: string): boolean => {
		const socket = piSockets.get(piId);
		return Boolean(socket && socket.readyState === WebSocket.OPEN && registry.get(piId));
	};

	const sendToPi = (piId: string, msg: HubToPiMessage): boolean => {
		const socket = piSockets.get(piId);
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		socket.send(serializeMessage(msg));
		return true;
	};

	// 先占位，创建后挂超时回调，避免 const 自引用歧义
	let approvalsRef: ApprovalStore;

	const deliverApprovalResult = (input: {
		piId: string;
		requestId: string;
		decision: "approve" | "reject";
		actorOpenId?: string;
	}): boolean => {
		const delivered = sendToPi(input.piId, {
			type: "approval_result",
			piId: input.piId,
			requestId: input.requestId,
			decision: input.decision,
			actorOpenId: input.actorOpenId,
		});
		if (delivered) {
			approvalsRef.markDelivered(input.requestId);
			log(
				`[hub] approval_result → piId=${input.piId} requestId=${input.requestId} decision=${input.decision}`,
			);
		} else {
			// 不 markDelivered，标 failed 以便 Pi 恢复后可重试；绝不改投其他实例
			approvalsRef.markFailedDelivery(input.requestId);
			log(
				`[hub] approval_result 投递失败（连接不可用）piId=${input.piId} requestId=${input.requestId}`,
			);
		}
		return delivered;
	};

	const handleApprovalTimeout = (requestId: string) => {
		const result = approvalsRef.applyTimeout(requestId, isPiSocketOnline);
		if (result.kind !== "timed_out") return;
		log(
			`[hub] approval timeout requestId=${requestId} piId=${result.record.piId} offline=${result.offline}`,
		);
		if (result.shouldDeliver) {
			deliverApprovalResult({
				piId: result.record.piId,
				requestId: result.record.requestId,
				decision: "reject",
			});
		}
	};

	const approvals =
		options.approvals ??
		new ApprovalStore({
			defaultTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
			onTimeoutFire: handleApprovalTimeout,
		});
	approvalsRef = approvals;

	const controlCtx = {
		registry,
		bindings,
		approvals,
		isAuthorized,
	};

	const handleNotify = async (client: ClientState, m: NotifyMessage) => {
		if (!client.piId || m.piId !== client.piId) {
			safeSend(client.socket, {
				type: "error",
				message: "notify 失败：piId 与连接绑定不一致",
			});
			return;
		}

		log(
			`[hub] notify piId=${m.piId} event=${m.event} requestId=${m.requestId} title=${m.title}`,
		);

		try {
			// 审批：先入状态机，再出站卡片
			if (m.event === "approval") {
				approvals.create({
					requestId: m.requestId,
					piId: m.piId,
					timeoutMs: m.timeoutMs,
					title: m.title,
					body: m.body,
				});
			}

			const outbound = {
				title: m.title,
				body: m.body,
				piId: m.piId,
				event: m.event,
				requestId: m.requestId,
				actions: m.actions,
			};

			let messageId: string;
			if (m.event === "approval" && feishu.sendApprovalCard) {
				const result = await feishu.sendApprovalCard(outbound);
				messageId = result.messageId;
			} else {
				const result = await feishu.send(outbound);
				messageId = result.messageId;
			}

			if (m.event === "approval") {
				approvals.setMessageId(m.requestId, messageId);
			}

			bindings.bind({
				messageId,
				piId: m.piId,
				requestId: m.requestId,
				event: m.event,
			});

			safeSend(client.socket, {
				type: "notify_ack",
				requestId: m.requestId,
				messageId,
			});
			log(
				`[hub] notify_ack piId=${m.piId} requestId=${m.requestId} messageId=${messageId}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`[hub] notify 发送失败 piId=${m.piId}: ${message}`);
			safeSend(client.socket, {
				type: "error",
				message: `notify 发送失败：${message}`,
			});
		}
	};

	const handleSetup = async (client: ClientState) => {
		if (!client.piId) return;
		if (setupInFlight) { safeSend(client.socket, { type: "error", message: "已有扫码开局正在进行，请等待其结束" }); return; }
		const file = options.credentialsFile ?? credentialsPath();
		const existing = loadCredentials(file);
		if (existing) {
			const configuredOwner = hubConfigSnapshot?.feishu.userId?.trim();
			if (allowed.size !== 1 || !configuredOwner || [...allowed][0] !== configuredOwner) { safeSend(client.socket, { type: "lark_result", ok: false, connected: false, message: "凭证缺少一致的可信主人配置，请执行 /lark reset 后重新扫码" }); return; }
			setupInFlight = true;
			let stop: (() => void) | undefined;
			try {
				const candidate = new NativeFeishuTransport(existing, { userId: configuredOwner });
				const bot = await candidate.probeBotOpenId();
				if (!bot || configuredOwner === bot) {
					throw new Error("无法验证可信真人主人，请执行 /lark reset 后重新扫码");
				}
				const started = await options.onNativeRuntime?.(candidate, existing, hub);
				stop = typeof started === "function" ? started : undefined;
				nativeRuntimeStop?.(); nativeRuntimeStop = stop; feishu = candidate; hub.feishu = candidate;
				safeSend(client.socket, { type: "lark_result", ok: true, connected: true, message: "原生飞书连接已确认" });
			} catch (e) { stop?.(); safeSend(client.socket, { type: "lark_result", ok: false, connected: false, message: `原生飞书重连失败：${e instanceof Error ? e.message : String(e)}` }); }
			finally { setupInFlight = false; }
			return;
		}
		setupInFlight = true;
		const abort = new AbortController(); setupAbort = abort;
		const previous = { feishu, allowed: [...allowed], config: hubConfigSnapshot, stop: nativeRuntimeStop };
		let candidateStop: (() => void) | undefined;
		let credentialsSaved = false;
		try {
			const challenge = await registration.begin();
			safeSend(client.socket, { type: "lark_challenge", url: challenge.url, expiresAt: challenge.expiresAt, ttlMs: challenge.expiresAt - Date.now() });
			const result = await registration.poll(challenge, abort.signal);
			// O1：先以无收件人状态启动原生运行时；只有确认扫码用户是真人后才设置收件人。
			const native = new NativeFeishuTransport(result.credentials);
			let owner: string | undefined;
			const bot = await native.probeBotOpenId();
			if (!result.ownerOpenId || !bot || result.ownerOpenId === bot) throw new Error("registration 未返回可信真人 open_id");
			owner = result.ownerOpenId;
			const startedRuntime = await options.onNativeRuntime?.(native, result.credentials, hub);
			candidateStop = typeof startedRuntime === "function" ? startedRuntime : undefined;
			const currentPath = hubConfigSnapshot?.configPath ?? defaultConfigPath();
			saveCredentials(result.credentials, file);
			credentialsSaved = true;
			const saved = saveNativeSetupConfig({ configPath: currentPath, base: hubConfigSnapshot, ownerOpenId: owner });
			if (previous.stop && previous.stop !== candidateStop) {
				try { previous.stop(); } catch (error) {
					log(`[hub] 停止旧原生运行时失败：${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (owner) { allowed.clear(); allowed.add(owner); native.setRecipient({ userId: owner }); }
			else allowed.clear();
			feishu = native; hub.feishu = native; nativeRuntimeStop = candidateStop;
			hubConfigSnapshot = saved.config;
			safeSend(client.socket, { type: "lark_result", ok: true, appId: result.credentials.appId, connected: true, message: "扫码开局成功，主人已绑定" });
		} catch (e) {
			if (credentialsSaved) deleteCredentials(file);
			if (candidateStop) { try { candidateStop(); } catch { /* ignore */ } }
			feishu = previous.feishu; hub.feishu = previous.feishu; allowed.clear(); previous.allowed.forEach((id) => allowed.add(id)); hubConfigSnapshot = previous.config; nativeRuntimeStop = previous.stop;
			const message = e instanceof Error ? e.message.replace(/app_secret|client_secret|secret/gi, "密钥") : "扫码开局失败";
			safeSend(client.socket, { type: "lark_result", ok: false, connected: false, message });
		} finally { setupAbort = null; setupInFlight = false; }
	};

	const handlePiMessage = (client: ClientState, raw: string) => {
		const msg = parseProtocolMessage(raw);
		if (!msg || !("type" in msg)) {
			safeSend(client.socket, { type: "error", message: "无法解析的消息" });
			return;
		}

		switch ((msg as PiToHubMessage).type) {
			case "register": {
				const m = msg as Extract<PiToHubMessage, { type: "register" }>;
				let piId = (m.piId && m.piId.trim()) || "";
				if (!piId) {
					// 生成短可读 id，并避免与在线表冲突
					for (let i = 0; i < 8; i++) {
						const candidate = generatePiId();
						if (!registry.get(candidate) && !piSockets.has(candidate)) {
							piId = candidate;
							break;
						}
					}
					if (!piId) piId = `${generatePiId()}${generatePiId()}`;
				}
				// 同 piId 重连：踢掉旧连接映射
				const prev = piSockets.get(piId);
				if (prev && prev !== client.socket) {
					try {
						prev.close(4000, "replaced");
					} catch {
						// ignore
					}
				}
				// 若本连接曾注册其他 piId，先摘掉旧映射，避免幽灵在线
				if (client.piId && client.piId !== piId) {
					registry.unregister(client.piId, "unregister");
					piSockets.delete(client.piId);
				}
				client.piId = piId;
				piSockets.set(piId, client.socket);
				const caps = (m.capabilities ?? []) as Capability[];
				registry.register({
					piId,
					displayName: m.displayName || "pi",
					cwd: m.cwd || process.cwd(),
					pid: typeof m.pid === "number" ? m.pid : 0,
					capabilities: caps,
					connectionId: client.connectionId,
				});
				safeSend(client.socket, { type: "register_ok", piId });
				log(`[hub] register ok piId=${piId} name=${m.displayName} cwd=${m.cwd}`);
				return;
			}
			case "heartbeat": {
				const m = msg as Extract<PiToHubMessage, { type: "heartbeat" }>;
				if (!client.piId) {
					safeSend(client.socket, {
						type: "error",
						message: "心跳失败：尚未 register",
					});
					return;
				}
				if (m.piId !== client.piId) {
					safeSend(client.socket, {
						type: "error",
						message: `心跳失败：piId 与连接绑定不一致（期望 ${client.piId}）`,
					});
					return;
				}
				if (!registry.heartbeat(m.piId, m.status, m.ts)) {
					safeSend(client.socket, {
						type: "error",
						message: `心跳失败：未知 piId=${m.piId}，请重新 register`,
					});
				}
				return;
			}
			case "notify": {
				void handleNotify(client, msg as NotifyMessage);
				return;
			}
			case "unregister": {
				const m = msg as Extract<PiToHubMessage, { type: "unregister" }>;
				if (!client.piId || m.piId !== client.piId) {
					safeSend(client.socket, {
						type: "error",
						message: "unregister 失败：piId 与连接绑定不一致",
					});
					return;
				}
				registry.unregister(m.piId, "unregister");
				piSockets.delete(m.piId);
				client.piId = null;
				log(`[hub] unregister piId=${m.piId}`);
				return;
			}
			case "lark_open": { const m = msg as Extract<PiToHubMessage, { type: "lark_open" }>; if (!client.piId || m.piId !== client.piId) { safeSend(client.socket, { type: "error", message: "lark 操作失败：piId 不一致" }); return; } if (!setupTask) setupTask = handleSetup(client).finally(() => { setupTask = null; }); else safeSend(client.socket, { type: "error", message: "已有扫码开局正在进行，请等待其结束" }); return; }
			case "lark_reset": { const m = msg as Extract<PiToHubMessage, { type: "lark_reset" }>; if (!client.piId || m.piId !== client.piId) { safeSend(client.socket, { type: "error", message: "lark reset 失败：piId 不一致" }); return; } void (async () => { try { setupAbort?.abort(); await setupTask; nativeRuntimeStop?.(); nativeRuntimeStop = undefined; deleteCredentials(options.credentialsFile ?? credentialsPath()); resetNativeConfig({ configPath: hubConfigSnapshot?.configPath, base: hubConfigSnapshot }); allowed.clear(); hubConfigSnapshot = undefined; feishu = new NoopFeishuTransport(); hub.feishu = feishu; safeSend(client.socket, { type: "lark_result", ok: true, connected: false, reset: true, message: "飞书原生凭证、配置和主人绑定已清理" }); } catch (e) { safeSend(client.socket, { type: "lark_result", ok: false, connected: false, reset: true, message: e instanceof Error ? e.message : String(e) }); } })(); return; }
			default:
				safeSend(client.socket, {
					type: "error",
					message: `未知消息类型: ${(msg as { type: string }).type}`,
				});
		}
	};

	const httpServer = http.createServer(async (req, res) => {
		try {
			await handleHttp(req, res);
		} catch (error) {
			res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
			res.end(
				JSON.stringify({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	});

	async function handleHttp(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${host}:${port}`);
		const method = req.method ?? "GET";

		if (method === "GET" && url.pathname === "/health") {
			const pairingHealth = { feishuMode: "native", ownerBound: allowed.size > 0, needsPairing: allowed.size === 0 };
			json(res, 200, {
				ok: true,
				pid: process.pid,
				packageVersion,
				features: [...HUB_FEATURES],
				host,
				port,
				defaultPiId: registry.getDefaultPiId(),
				online: registry.listSnapshots(),
				bindingCount: bindings.size(),
				pendingApprovals: approvals.listPending().length,
				feishuMode: pairingHealth.feishuMode,
				ownerBound: pairingHealth.ownerBound,
				needsPairing: pairingHealth.needsPairing,
			});
			return;
		}

		if (method === "GET" && url.pathname === "/instances") {
			json(res, 200, {
				defaultPiId: registry.getDefaultPiId(),
				instances: registry.listSnapshots(),
			});
			return;
		}

		if (method === "GET" && url.pathname === "/notifications") {
			const history = readTransportHistory(feishu, bindings);
			json(res, 200, {
				bindings: bindings.list(),
				history,
			});
			return;
		}

		if (method === "GET" && url.pathname === "/approvals") {
			json(res, 200, {
				pending: approvals.listPending(),
				all: approvals.list(),
			});
			return;
		}

		if (method === "POST" && url.pathname === "/control/approval") {
			const body = await readBody(req);
			let payload: {
				requestId?: string;
				decision?: string;
				openId?: string;
			};
			try {
				payload = JSON.parse(body || "{}") as typeof payload;
			} catch {
				json(res, 400, { ok: false, error: "invalid JSON" });
				return;
			}

			const decision = payload.decision;
			if (decision !== "approve" && decision !== "reject") {
				json(res, 400, {
					ok: false,
					error: 'decision 必须是 "approve" 或 "reject"',
				});
				return;
			}

			const out = await applyInboundApproval({
				requestId: payload.requestId ?? "",
				decision,
				openId: payload.openId,
			});
			json(res, 200, out);
			return;
		}

		if (method === "POST" && url.pathname === "/control/message") {
			const body = await readBody(req);
			let payload: { text?: string; openId?: string; replyToMessageId?: string };
			try {
				payload = JSON.parse(body || "{}") as {
					text?: string;
					openId?: string;
					replyToMessageId?: string;
				};
			} catch {
				json(res, 400, { ok: false, error: "invalid JSON" });
				return;
			}

			const out = await applyInboundMessage({
				text: payload.text ?? "",
				openId: payload.openId,
				replyToMessageId: payload.replyToMessageId,
			});
			json(res, 200, out);
			return;
		}

		json(res, 404, {
			ok: false,
			error: "not found",
			routes: [
				"GET /health",
				"GET /instances",
				"GET /notifications",
				"GET /approvals",
				"POST /control/message",
				"POST /control/approval",
				"WS /",
			],
		});
	}

	const wss = new WebSocketServer({ server: httpServer });

	wss.on("connection", (socket, req) => {
		const remote = req.socket.remoteAddress ?? "";
		// 额外校验：仅本机（IPv4 / IPv6 loopback）
		if (remote && remote !== "127.0.0.1" && remote !== "::1" && remote !== ":ffff:127.0.0.1") {
			log(`[hub] 拒绝非 loopback 连接: ${remote}`);
			socket.close(1008, "loopback only");
			return;
		}

		const connectionId = randomUUID();
		const client: ClientState = { connectionId, piId: null, socket };
		clients.set(connectionId, client);
		log(`[hub] ws connected ${connectionId}`);

		socket.on("message", (data) => {
			const raw = typeof data === "string" ? data : data.toString("utf8");
			handlePiMessage(client, raw);
		});

		socket.on("close", () => {
			clients.delete(connectionId);
			const removed = registry.disconnectByConnection(connectionId);
			for (const inst of removed) {
				piSockets.delete(inst.piId);
				log(`[hub] disconnect piId=${inst.piId}`);
			}
		});

		socket.on("error", (err) => {
			log(`[hub] ws error ${connectionId}: ${err.message}`);
		});
	});

	registry.on("offline", (instance, reason) => {
		log(`[hub] offline piId=${instance.piId} reason=${reason}`);
		if (reason === "timeout") {
			const socket = piSockets.get(instance.piId);
			if (socket) {
				try {
					socket.close(4001, "heartbeat timeout");
				} catch {
					// ignore
				}
				piSockets.delete(instance.piId);
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, host, () => {
			httpServer.off("error", reject);
			resolve();
		});
	});

	const address = httpServer.address();
	const boundPort =
		typeof address === "object" && address ? address.port : port;

	log(`[hub] listening on ws://${host}:${boundPort} (HTTP control same port)`);

	const hub: HubServer = {
		host,
		port: boundPort,
		registry,
		bindings,
		approvals,
		feishu,
		handleInboundMessage: applyInboundMessage,
		handleInboundApproval: applyInboundApproval,
		close: async () => {
			setupAbort?.abort();
			try { nativeRuntimeStop?.(); } catch { /* ignore */ }
			registry.stopSweeper();
			approvals.clear();
			for (const client of clients.values()) {
				try {
					client.socket.close(1001, "hub shutdown");
				} catch {
					// ignore
				}
			}
			clients.clear();
			piSockets.clear();
			await new Promise<void>((resolve, reject) => {
				wss.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
			await new Promise<void>((resolve, reject) => {
				httpServer.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		},
	};

	if (options.onReady) {
		try {
			const initialStop = await options.onReady(hub);
			if (typeof initialStop === "function") nativeRuntimeStop = initialStop;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`[hub] onReady 失败（Hub 继续运行）: ${message}`);
		}
	}

	return hub;

	async function applyInboundMessage(input: {
		text: string;
		openId?: string;
		replyToMessageId?: string;
	}): Promise<ControlDeliveryResult> {
		const result = handleControlMessage(controlCtx, {
			text: input.text ?? "",
			openId: input.openId,
			replyToMessageId: input.replyToMessageId,
		});

		if (result.approvalDeliver) {
			const delivered = deliverApprovalResult(result.approvalDeliver);
			return {
				ok: delivered || result.decision.kind === "approval",
				reply: delivered
					? result.reply
					: `目标 Pi ${result.approvalDeliver.piId} 连接不可用，审批结果未投递。`,
				deliveredTo: delivered ? result.approvalDeliver.piId : null,
				decision: result.decision,
			};
		}

		let delivered = false;
		if (result.deliveredTo && result.deliverText) {
			const source: MessageSource = result.source ?? "default";
			delivered = sendToPi(result.deliveredTo, {
				type: "user_message",
				piId: result.deliveredTo,
				text: result.deliverText,
				source,
				replyToRequestId: result.replyToRequestId,
			});
			if (!delivered) {
				return {
					ok: false,
					reply: `目标 Pi ${result.deliveredTo} 连接不可用，消息未投递。`,
					deliveredTo: null,
					decision: result.decision,
				};
			}
		}

		const isUnauthorized =
			result.decision.kind === "ignored" &&
			result.decision.reason === "unauthorized";
		const isApprovalFail =
			result.decision.kind === "approval" &&
			(result.decision.result.kind === "not_found" ||
				(result.decision.result.kind === "decided" &&
					result.decision.result.offline));

		return {
			ok:
				!isUnauthorized &&
				!isApprovalFail &&
				result.decision.kind !== "reply_unbound" &&
				result.decision.kind !== "reply_offline",
			reply: result.reply,
			deliveredTo: delivered ? result.deliveredTo : undefined,
			source: delivered ? (result.source ?? "default") : undefined,
			decision: result.decision,
		};
	}

	async function applyInboundApproval(input: {
		requestId: string;
		decision: "approve" | "reject";
		openId?: string;
	}): Promise<ControlDeliveryResult> {
		const result = handleControlApproval(controlCtx, {
			requestId: input.requestId,
			decision: input.decision,
			openId: input.openId,
		});

		let delivered = false;
		if (result.approvalDeliver) {
			delivered = deliverApprovalResult(result.approvalDeliver);
			if (!delivered) {
				return {
					ok: false,
					reply: `目标 Pi ${result.approvalDeliver.piId} 连接不可用，审批结果未投递（未改投其他实例）。`,
					deliveredTo: null,
					decision: result.decision,
				};
			}
		}

		const isIgnored = result.decision.kind === "ignored";
		const isNotFound =
			result.decision.kind === "approval" &&
			result.decision.result.kind === "not_found";
		const isOfflineFail =
			result.decision.kind === "approval" &&
			result.decision.result.kind === "decided" &&
			result.decision.result.offline;

		return {
			ok: !isIgnored && !isNotFound && !isOfflineFail,
			reply: result.reply,
			deliveredTo: delivered ? result.approvalDeliver?.piId : undefined,
			decision: result.decision,
			alreadyHandled:
				result.decision.kind === "approval" &&
				result.decision.result.kind === "already_handled",
		};
	}
}

function readTransportHistory(
	feishu: FeishuTransport,
	bindings: MessageBindingStore,
): unknown[] {
	const withHistory = feishu as FeishuTransport & {
		history?: Array<Record<string, unknown>>;
	};
	if (Array.isArray(withHistory.history)) {
		return withHistory.history;
	}
	return bindings.list().map((b) => ({
		messageId: b.messageId,
		piId: b.piId,
		requestId: b.requestId,
		event: b.event,
		sentAt: b.createdAt,
	}));
}

function safeSend(socket: WebSocket, msg: HubToPiMessage): void {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(serializeMessage(msg));
	}
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body, null, 2));
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
