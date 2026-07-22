/**
 * Pi × 飞书 Multi-Pi 桥接扩展（lark-bridge）。
 *
 * 连接本机 pi-lark-hub：注册、心跳、接收 user_message / approval_result、
 * 上报 task_end 与危险 bash 审批。
 * 远程文本走扩展自有 FIFO，禁止 pi.sendUserMessage(..., { deliverAs: "followUp" })。
 *
 * 加载方式：
 *   默认：package pi.extensions → src/index.ts（re-export 本模块）
 *   显式：pi -e ./src/lark-bridge/index.ts
 *   或 pi -e <本包绝对路径>/src/lark-bridge/index.ts
 *
 * 命令：
 *   /lark                 连接或发起官方扫码
 *   /lark status          脱敏诊断（Hub/凭证/在线 Pi）
 *   /lark queue|cancel|clear-queue  本地队列
 *   /lark reset           清理凭证并重新开局
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";
import { formatHubStatusReport, type HubStatusSnapshot } from "../hub/status-report.js";
import {
	generateRequestId,
	decodeHubToPiMessage,
	serializeMessage,
	type ApprovalDecision,
	type HubToPiMessage,
	type PiStatus,
	type PiToHubMessage,
	type UserMessage,
} from "../protocol.js";
import {
	ensureHubRunning,
	fetchHubHealthDetail,
	hubUrlToHttpOrigin,
	isAutostartEnabled,
	type EnsureHubResult,
} from "./hub-autostart.js";
import { NotifyAckQueue, type PendingNotifyPayload } from "./notify-queue.js";
import { openPathBestEffort, writeSetupQrPng } from "./setup-qr.js";
import { TaskQueue } from "./task-queue.js";

const STATUS_KEY = "lark-bridge";
const DEFAULT_HUB_URL = process.env.PI_LARK_HUB_URL ?? "ws://127.0.0.1:8765";
const HEARTBEAT_MS = 10_000;
const RECONNECT_MS = 5_000;
const SUMMARY_MAX = 800;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 危险 bash 模式（拦截后走 hub 审批 / 本机 UI） */
const DANGEROUS_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f[a-z]*|--recursive)/i,
	/\bsudo\b/i,
	/\bgit\s+push\b.*--force/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bdrop\s+(table|database)\b/i,
	/\bformat\s+[a-z]:/i,
	/\bdel\s+\/[sfq]/i,
	/\brmdir\s+\/s/i,
];

type Decision = ApprovalDecision | "timeout";

type PendingApproval = {
	requestId: string;
	command: string;
	createdAt: number;
	resolve: (decision: Decision) => void;
	promise: Promise<Decision>;
	done: boolean;
};

type AssistantLikeMessage = {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
};

function displayNameFromCwd(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "pi";
}

function messageText(message: AssistantLikeMessage | undefined): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function finalAssistantText(messages: AssistantLikeMessage[]): string {
	let text = "";
	for (const message of messages ?? []) {
		if (message?.role === "assistant") {
			const value = messageText(message);
			if (value) text = value;
		}
	}
	return text;
}

function compactSummary(text: string, max = SUMMARY_MAX): string {
	const clean = text.trim().replace(/\s+\n/g, "\n");
	if (!clean) return "（无文字摘要）";
	return clean.length <= max ? clean : `${clean.slice(0, max - 12)}\n…（已截断）`;
}

function compact(text: string, max = 1000): string {
	const clean = text.trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 12)}\n…（已截断）`;
}

export default function larkBridge(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | null = null;
	let socket: WebSocket | null = null;
	let piId: string | null = null;
	let connected = false;
	let hubDownNotified = false;
	let autostartFailureNotified = false;
	/** 本进程是否已自动发起过配对（重连不再刷） */
	let lastEnsureResult: EnsureHubResult | null = null;
	let intentionalClose = false;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const taskQueue = new TaskQueue({ maxSize: 20 });
	let currentFromHub = false;
	let drainingQueue = false;
	/** agent_end 缓存的助手摘要，settled 时用于 task_end */
	let pendingAssistantSummary = "";
	let lastNotifyAck: { requestId: string; messageId: string } | null = null;
	const approvals = new Map<string, PendingApproval>();
	const notifyAckQueue = new NotifyAckQueue({
		maxAttempts: 3,
		ackTimeoutMs: 8_000,
		onGiveUp: (item, reason) => {
			notify(
				`通知未确认（${item.payload.event} ${item.payload.requestId.slice(0, 12)}…）：${reason}`,
				"warning",
			);
		},
	});

	const sendNotifyReliable = (payload: PendingNotifyPayload): boolean => {
		notifyAckQueue.setSend((p) => send(p));
		const r = notifyAckQueue.enqueue(payload);
		if (!r.ok) {
			notify(r.reason ?? "notify 队列已满", "warning");
			return false;
		}
		return true;
	};

	const status = (text?: string) => {
		if (activeCtx?.hasUI) activeCtx.ui.setStatus(STATUS_KEY, text);
	};

	const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
		if (activeCtx?.hasUI) activeCtx.ui.notify(text, level);
	};


	const clearTimers = () => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	const send = (msg: PiToHubMessage): boolean => {
		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.send(serializeMessage(msg));
			return true;
		}
		return false;
	};

	const currentStatus = (): PiStatus => {
		if (activeCtx && !activeCtx.isIdle()) return "busy";
		if (currentFromHub || drainingQueue) return "busy";
		return "idle";
	};

	const startHeartbeat = () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(() => {
			if (!piId || !connected) return;
			send({
				type: "heartbeat",
				piId,
				status: currentStatus(),
				ts: Date.now(),
			});
		}, HEARTBEAT_MS);
	};

	const decideLocalApproval = (requestId: string, decision: Decision): boolean => {
		const item = approvals.get(requestId);
		if (!item || item.done) return false;
		item.done = true;
		approvals.delete(requestId);
		item.resolve(decision);
		return true;
	};

	const tryDrainQueue = (ctx: ExtensionContext) => {
		if (drainingQueue || !ctx.isIdle()) return;
		if (currentFromHub) return;

		drainingQueue = true;
		try {
			while (taskQueue.size > 0 && ctx.isIdle() && !currentFromHub) {
				const item = taskQueue.shift()!;
				try {
					currentFromHub = true;
					status(`飞书指令：${item.text.slice(0, 50)}`);
					// 禁止 deliverAs followUp / steer — 远程文本不得进入 TUI 恢复队列
					pi.sendUserMessage(item.text);
					return;
				} catch (error) {
					currentFromHub = false;
					notify(
						`飞书指令提交失败：${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
		} finally {
			drainingQueue = false;
		}
	};

	const handleUserMessage = (msg: UserMessage, ctx: ExtensionContext) => {
		const text = (msg.text ?? "").trim();
		if (!text) return;

		const slotBusy = currentFromHub || drainingQueue;
		if (!ctx.isIdle() || slotBusy) {
			const item = taskQueue.enqueue({ text, source: msg.source });
			if (!item) {
				notify(`飞书队列已满（${taskQueue.max}），消息未入队`, "warning");
				return;
			}
			status(`飞书已排队：${taskQueue.size}`);
			notify(`飞书消息已入队 ${item.id}（${taskQueue.size}/${taskQueue.max}）`, "info");
			return;
		}

		currentFromHub = true;
		status(`飞书指令：${text.slice(0, 50)}`);
		try {
			pi.sendUserMessage(text);
		} catch (error) {
			currentFromHub = false;
			notify(
				`飞书指令提交失败：${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	};

	const sendTaskEndNotify = (ctx: ExtensionContext) => {
		if (!connected || !piId) return;

		const cwd = ctx.cwd || process.cwd();
		const displayName = displayNameFromCwd(cwd);
		const summary = compactSummary(pendingAssistantSummary);
		const requestId = generateRequestId();
		const title = `✅ 任务结束 · ${displayName}`;
		const body = [
			`项目: ${displayName}`,
			`piId: ${piId}`,
			`cwd: ${cwd}`,
			`事件: task_end`,
			"",
			"摘要:",
			summary,
			"",
			"回复本条消息可继续向该 Pi 发指令。",
		].join("\n");

		sendNotifyReliable({
			type: "notify",
			piId,
			event: "task_end",
			requestId,
			title,
			body,
		});
	};

	const handleHubMessage = (raw: string) => {
		const decoded = decodeHubToPiMessage(raw);
		if (!decoded.ok) return;
		const msg: HubToPiMessage = decoded.message;

		switch (msg.type) {
			case "register_ok": {
				piId = msg.piId;
				connected = true;
				hubDownNotified = false;
				autostartFailureNotified = false;
				status(`飞书 Hub ✓ ${piId}`);
				notify(`已注册到 pi-lark-hub\npiId: ${piId}`, "info");
				startHeartbeat();
				notifyAckQueue.setSend((p) => send(p));
				notifyAckQueue.flush();
				return;
			}
			case "notify_ack": {
				lastNotifyAck = {
					requestId: msg.requestId,
					messageId: msg.messageId,
				};
				notifyAckQueue.ack(msg.requestId);
				return;
			}
			case "user_message": {
				if (activeCtx) handleUserMessage(msg, activeCtx);
				return;
			}
			case "queue_control": {
				const report = applyQueueControl(msg.action, msg.id);
				notify(report, "info");
				if (piId) {
					send({
						type: "queue_report",
						piId,
						text: report,
					});
				}
				return;
			}
			case "approval_result": {
				const ok = decideLocalApproval(msg.requestId, msg.decision);
				if (ok) {
					notify(
						`飞书审批 ${msg.decision === "approve" ? "已批准" : "已拒绝"}：${msg.requestId}`,
						msg.decision === "approve" ? "info" : "warning",
					);
				}
				// 无论是否本地首次应用，均 ack 以便 Hub markDelivered（幂等）
				if (piId) {
					send({
						type: "approval_result_ack",
						piId,
						requestId: msg.requestId,
					});
				}
				return;
			}
			case "error": {
				notify(`Hub 错误：${msg.message}`, "warning");
				return;
			}
			case "lark_challenge": {
				status("等待飞书扫码…");
				void (async () => { const qr = await writeSetupQrPng(msg.url); const lines = ["请用飞书扫描官方授权二维码：", msg.url]; if (qr.ok) { lines.push(`二维码：${qr.path}`); openPathBestEffort(qr.path); } else lines.push(`二维码生成失败：${qr.error}`); notify(lines.join("\n"), "info"); })();
				return;
			}
			case "lark_result": { notify(`${msg.ok ? "飞书操作成功" : "飞书操作失败"}：${msg.message}`, msg.ok ? "info" : "warning"); status(msg.connected && piId ? `飞书 Hub ✓ ${piId}` : `飞书 Hub ✓ ${piId ?? "-"} · 未开局`); return; }

			default:
				return;
		}
	};

	const scheduleReconnect = () => {
		if (intentionalClose || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (activeCtx && !intentionalClose) {
				void connectHubWithEnsure(activeCtx);
			}
		}, RECONNECT_MS);
	};

	/** 先 ensure（冷却内可能 skip spawn），再连 WS */
	const connectHubWithEnsure = async (ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (intentionalClose) return;

		if (
			socket &&
			(socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
		) {
			return;
		}

		status("飞书 Hub 准备中…");
		const result = await ensureHubRunning({ hubWsUrl: DEFAULT_HUB_URL });
		lastEnsureResult = result;
		if (intentionalClose) return;

		if (result.status === "spawned-ready") {
			autostartFailureNotified = false;
			notify(result.detail ?? "已自动启动本机 Hub", "info");
		} else if (result.status === "ready") {
			autostartFailureNotified = false;
		} else if (result.status === "failed") {
			// 与通用断线提示分开去重：Hub 崩溃后的首次重启失败也必须给出可操作原因。
			if (!autostartFailureNotified) {
				autostartFailureNotified = true;
				hubDownNotified = true;
				notify(result.detail ?? "自动启动 Hub 失败", "warning");
			}
			status("飞书 Hub 不可用");
		}

		connectHub(ctx);
	};

	const connectHub = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		intentionalClose = false;

		if (
			socket &&
			(socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
		) {
			return;
		}

		status("飞书 Hub 连接中…");

		let ws: WebSocket;
		try {
			ws = new WebSocket(DEFAULT_HUB_URL);
		} catch (error) {
			connected = false;
			status("飞书 Hub 不可用");
			if (!hubDownNotified) {
				hubDownNotified = true;
				notify(
					`无法连接 pi-lark-hub（${DEFAULT_HUB_URL}）：${error instanceof Error ? error.message : String(error)}。本机可继续使用；将自动重试。`,
					"warning",
				);
			}
			scheduleReconnect();
			return;
		}

		socket = ws;

		ws.on("open", () => {
			const cwd = ctx.cwd || process.cwd();
			const registerMsg: PiToHubMessage = {
				type: "register",
				displayName: displayNameFromCwd(cwd),
				cwd,
				pid: process.pid,
				capabilities: ["approval", "prompt", "settled"],
				// 同一扩展生命周期内重连复用 piId，保持审批/绑定连续性
				...(piId ? { piId } : {}),
			};
			ws.send(serializeMessage(registerMsg));
		});

		ws.on("message", (data) => {
			try {
				const raw = typeof data === "string" ? data : data.toString("utf8");
				handleHubMessage(raw);
			} catch {
				// 畸形或处理异常不得拖垮扩展
			}
		});

		ws.on("close", () => {
			const wasConnected = connected;
			connected = false;
			socket = null;
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			if (intentionalClose) {
				status(undefined);
				return;
			}
			status("飞书 Hub 已断开");
			if (wasConnected || !hubDownNotified) {
				hubDownNotified = true;
				notify("pi-lark-hub 不可用或已断开，将自动重试；本机 Pi 可继续使用。", "warning");
			}
			scheduleReconnect();
		});

		ws.on("error", () => {
			// close 会随后触发；此处避免未处理 error 崩溃（AC9）
			if (!hubDownNotified) {
				hubDownNotified = true;
				const hint = !isAutostartEnabled()
					? `已关闭自动拉起（PI_LARK_HUB_AUTOSTART=0）。请手动启动：在包目录 npm run hub。`
					: lastEnsureResult?.status === "skipped" && lastEnsureResult.detail
						? `${lastEnsureResult.detail}；将仅重试连接。`
						: `将自动重试并尝试拉起本机 Hub（可设 PI_LARK_HUB_AUTOSTART=0 关闭）。也可手动在包目录执行 npm run hub。`;
				notify(`pi-lark-hub 连接失败（${DEFAULT_HUB_URL}）。${hint}`, "warning");
			}
			status("飞书 Hub 不可用");
		});
	};

	const disconnectHub = () => {
		intentionalClose = true;
		clearTimers();
		if (piId && socket?.readyState === WebSocket.OPEN) {
			send({ type: "unregister", piId });
		}
		try {
			socket?.close();
		} catch {
			// ignore
		}
		socket = null;
		connected = false;
		piId = null;
		status(undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		// hub 不可用时不崩溃；默认尝试自动拉起本机 Hub（AC9 + autostart）
		await connectHubWithEnsure(ctx);
	});

	pi.on("session_shutdown", async () => {
		taskQueue.clear();
		drainingQueue = false;
		currentFromHub = false;
		pendingAssistantSummary = "";
		lastNotifyAck = null;
		// 未决审批按超时拒绝，避免挂起 tool_call
		for (const item of approvals.values()) {
			if (!item.done) {
				item.done = true;
				item.resolve("timeout");
			}
		}
		approvals.clear();
		notifyAckQueue.clear();
		disconnectHub();
		activeCtx = null;
	});

	pi.on("agent_start", async () => {
		// 新一轮开始时清空上一轮摘要缓存
		pendingAssistantSummary = "";
		if (connected && piId) status(`飞书 Hub ✓ ${piId} · 执行中`);
	});

	// agent_end 可能后跟 retry/compaction，先缓存助手文本
	pi.on("agent_end", async (event, ctx) => {
		activeCtx = ctx;
		const answer = finalAssistantText(
			((event as { messages?: AssistantLikeMessage[] }).messages ?? []) as AssistantLikeMessage[],
		);
		if (answer) pendingAssistantSummary = answer;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		activeCtx = ctx;
		// 先上报 task_end（绑定 reply 路由），再释放槽位 drain
		if (connected && piId) {
			sendTaskEndNotify(ctx);
			status(`飞书 Hub ✓ ${piId}`);
			send({
				type: "heartbeat",
				piId,
				status: "idle",
				ts: Date.now(),
			});
		}
		pendingAssistantSummary = "";
		// 当前 run 若来自 hub，释放槽位后排空队列
		currentFromHub = false;
		tryDrainQueue(ctx);
	});

	/**
	 * 危险 bash：Hub 审批卡片 + 本机 UI 竞速。
	 * Hub 不可用时仅本机 UI（AC9）；超时默认拒绝。
	 */
	pi.on("tool_call", async (event, ctx) => {
		activeCtx = ctx;
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: string }).command ?? "");
		if (!DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) return;

		const requestId = generateRequestId();
		let resolver: (decision: Decision) => void = () => {};
		const promise = new Promise<Decision>((resolve) => {
			resolver = resolve;
		});
		const item: PendingApproval = {
			requestId,
			command,
			createdAt: Date.now(),
			resolve: resolver,
			promise,
			done: false,
		};
		approvals.set(requestId, item);

		const timer = setTimeout(() => {
			decideLocalApproval(requestId, "timeout");
		}, APPROVAL_TIMEOUT_MS);
		if (typeof timer.unref === "function") timer.unref();

		const cwd = ctx.cwd || process.cwd();
		const displayName = displayNameFromCwd(cwd);
		const hubOnline = connected && Boolean(piId);

		// 向 Hub 上报审批（若在线）
		if (hubOnline && piId) {
			const sent = sendNotifyReliable({
				type: "notify",
				piId,
				event: "approval",
				requestId,
				title: `⚠️ 需要审批 · ${displayName}`,
				body: [
					`项目: ${displayName}`,
					`piId: ${piId}`,
					`cwd: ${cwd}`,
					`事件: approval`,
					`requestId: ${requestId}`,
					"",
					"危险命令:",
					compact(command, 1500),
					"",
					"请批准或拒绝。5 分钟未操作将自动拒绝。",
					`模拟: POST /control/approval {\"requestId\":\"${requestId}\",\"decision\":\"approve\"}`,
				].join("\n"),
				actions: ["approve", "reject"],
				timeoutMs: APPROVAL_TIMEOUT_MS,
			});
			if (sent) {
				status(`等待飞书审批 ${requestId.slice(0, 12)}…`);
				notify(`危险命令已请求飞书审批\nrequestId: ${requestId}`, "warning");
			}
		} else {
			status("Hub 不可用 · 本机审批");
			notify("pi-lark-hub 不可用，危险命令改为本机审批。", "warning");
		}

		// 本机 UI 与 Hub 竞速；Hub 宕机时仅本机
		if (ctx.hasUI) {
			void (async () => {
				try {
					const options = hubOnline
						? ["批准", "拒绝", "仅等待飞书"]
						: ["批准", "拒绝"];
					const choice = await ctx.ui.select(
						`危险命令需要审批\nrequestId: ${requestId}\n\n${compact(command, 300)}`,
						options,
						{ timeout: APPROVAL_TIMEOUT_MS },
					);
					if (choice === "批准") decideLocalApproval(requestId, "approve");
					else if (choice === "拒绝") decideLocalApproval(requestId, "reject");
					// 「仅等待飞书」：不 resolve，继续等 hub / 超时
				} catch {
					// 取消/超时 UI：继续等 hub 或全局 timer
				}
			})();
		} else if (!hubOnline) {
			// 无 UI 且无 Hub：fail closed，立即拒绝（避免永久挂起）
			decideLocalApproval(requestId, "reject");
		}

		const decision = await item.promise;
		clearTimeout(timer);

		if (decision === "approve") {
			status(connected && piId ? `飞书 Hub ✓ ${piId}` : undefined);
			notify(`已批准危险命令（${requestId.slice(0, 12)}…）`, "info");
			return;
		}

		const reason =
			decision === "timeout"
				? `飞书/本机审批超时自动拒绝（${requestId}）`
				: `飞书/本机审批拒绝（${requestId}）`;
		status(connected && piId ? `飞书 Hub ✓ ${piId}` : undefined);
		notify(reason, "warning");
		return {
			block: true,
			reason,
		};
	});

	const applyQueueControl = (
		action: "list" | "cancel" | "clear",
		id?: string,
	): string => {
		const busyHint = currentFromHub || drainingQueue ? "当前有任务执行中" : undefined;
		if (action === "list") return taskQueue.formatList(busyHint);
		if (action === "clear") {
			const n = taskQueue.clear();
			status(taskQueue.size > 0 ? `飞书已排队：${taskQueue.size}` : undefined);
			return `已清空待执行队列（${n} 条）`;
		}
		const r = taskQueue.cancel(id ?? "");
		if (!r.ok) return r.reason;
		status(taskQueue.size > 0 ? `飞书已排队：${taskQueue.size}` : undefined);
		return `已取消 ${r.item.id}：${r.item.text.slice(0, 40)}`;
	};

	const reportLocalStatus = async () => {
		const origin = hubUrlToHttpOrigin(DEFAULT_HUB_URL);
		const health = origin ? await fetchHubHealthDetail(origin, 1500) : null;
		const bridgeLines = [
			"【Bridge 本机】",
			`WS连接=${connected ? "是" : "否"}  piId=${piId ?? "（未注册）"}`,
			`Hub URL=${DEFAULT_HUB_URL}`,
			`队列=${taskQueue.size}/${taskQueue.max}  本地待审批=${[...approvals.values()].filter((a) => !a.done).length}`,
			`notify待确认=${notifyAckQueue.size()}`,
		];
		if (!health) {
			notify(
				[...bridgeLines, "", "Hub /health 不可达：请确认 npm run hub 或允许自动拉起"].join("\n"),
				"warning",
			);
			return;
		}
		const snap: HubStatusSnapshot = {
			packageVersion: typeof health.packageVersion === "string" ? health.packageVersion : "unknown",
			host: typeof health.host === "string" ? health.host : "127.0.0.1",
			port: typeof health.port === "number" ? health.port : 8765,
			pid: typeof health.pid === "number" ? health.pid : undefined,
			feishuMode: typeof health.feishuMode === "string" ? health.feishuMode : "native",
			ownerBound: Boolean(health.ownerBound),
			needsPairing: Boolean(health.needsPairing),
			credentialsPresent: Boolean(health.credentialsPresent),
			credentialsUpdatedAt:
				typeof health.credentialsUpdatedAt === "number" ? health.credentialsUpdatedAt : 0,
			defaultPiId:
				typeof health.defaultPiId === "string" || health.defaultPiId === null
					? (health.defaultPiId as string | null)
					: null,
			online: Array.isArray(health.online) ? (health.online as HubStatusSnapshot["online"]) : [],
			pendingApprovals:
				typeof health.pendingApprovals === "number" ? health.pendingApprovals : 0,
			bindingCount: typeof health.bindingCount === "number" ? health.bindingCount : 0,
			nativeWsAttached:
				typeof health.nativeWsAttached === "boolean" ? health.nativeWsAttached : undefined,
		};
		notify(`${formatHubStatusReport(snap)}\n\n${bridgeLines.join("\n")}`, "info");
	};

	pi.registerCommand("lark", {
		description:
			"连接飞书；status 诊断；queue/cancel/clear-queue 队列；reset 清理",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const raw = (args ?? "").trim();
			const arg = raw.toLowerCase();
			if (arg === "status" || arg === "诊断") {
				await reportLocalStatus();
				return;
			}
			if (arg === "queue" || arg === "队列") {
				notify(applyQueueControl("list"), "info");
				return;
			}
			if (arg === "clear-queue" || arg === "清空队列") {
				notify(applyQueueControl("clear"), "info");
				return;
			}
			const cancelMatch = raw.match(/^(cancel|取消)\s+(\S+)$/i);
			if (cancelMatch) {
				notify(applyQueueControl("cancel", cancelMatch[2]), "info");
				return;
			}
			if (arg && arg !== "reset") {
				notify(
					"用法：/lark | status | queue | cancel <id> | clear-queue | reset",
					"warning",
				);
				return;
			}
			if (!connected || !piId) {
				notify("尚未连接 Hub，正在重试，请稍后再次执行 /lark", "warning");
				await connectHubWithEnsure(ctx);
				return;
			}
			const type = arg === "reset" ? "lark_reset" : "lark_open";
			if (!send({ type, piId } as PiToHubMessage)) {
				notify("飞书操作发送失败", "error");
				return;
			}
			status(arg === "reset" ? "正在重置飞书…" : "正在连接飞书…");
		},
	});
}
