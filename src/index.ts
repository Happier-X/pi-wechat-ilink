/**
 * Pi × WeChat official iLink bridge.
 *
 * Commands:
 *   /wechat            Connect (QR login on first use)
 *   /wechat --force    Force a new QR login
 *   /wechat-status     Show connection status
 *   /wechat-stop       Disconnect
 *   /wechat-test       Send a test message to the last WeChat user
 *   /weixin            Alias for /wechat
 *
 * Incoming WeChat text becomes pi.sendUserMessage(). Pi's final answer is
 * replied through iLink. Dangerous bash calls can be approved by replying
 * "批准 <id>" or "拒绝 <id>" in WeChat.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WeChatBot, stripMarkdown, type IncomingMessage } from "@wechatbot/wechatbot";
import qrTerminal from "qrcode-terminal";
import * as os from "node:os";
import * as path from "node:path";

const PACKAGE_VERSION = "0.1.0";
const STATUS_KEY = "wechat-ilink";
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_WECHAT_TEXT = 3500;

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

type Decision = "approve" | "reject" | "timeout";

type PendingApproval = {
	id: string;
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

function randomId(): string {
	return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function compact(text: string, max = MAX_WECHAT_TEXT): string {
	const clean = text.trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 20)}\n…（内容已截断）`;
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

function parseApproval(text: string): { decision: "approve" | "reject"; id?: string } | null {
	const normalized = text.trim();
	const approve = normalized.match(/^(批准|同意|允许|approve|yes|y)(?:\s+([a-z0-9]+))?$/i);
	if (approve) return { decision: "approve", id: approve[2]?.toUpperCase() };
	const reject = normalized.match(/^(拒绝|不同意|禁止|reject|no|n)(?:\s+([a-z0-9]+))?$/i);
	if (reject) return { decision: "reject", id: reject[2]?.toUpperCase() };
	return null;
}

export default function wechatILink(pi: ExtensionAPI) {
	let bot: WeChatBot | null = null;
	let connected = false;
	let starting = false;
	let activeCtx: ExtensionContext | null = null;
	let lastInbound: IncomingMessage | null = null;
	let currentWechatRequest: IncomingMessage | null = null;
	let currentRunFromWechat = false;
	let pendingWechatAnswer = "";
	let localRunStartedAt = 0;
	let lastProactiveNoticeAt = 0;
	const approvals = new Map<string, PendingApproval>();

	const storageDir = path.join(os.homedir(), ".pi", "agent", "wechat-ilink-state");

	const status = (text?: string) => {
		if (activeCtx?.hasUI) activeCtx.ui.setStatus(STATUS_KEY, text);
	};

	const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
		if (activeCtx?.hasUI) activeCtx.ui.notify(text, level);
	};

	const sendToLastUser = async (text: string): Promise<boolean> => {
		if (!bot || !connected || !lastInbound) return false;
		try {
			await bot.reply(lastInbound, compact(stripMarkdown(text)));
			return true;
		} catch (error) {
			notify(`微信发送失败: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	};

	const decideApproval = (
		decision: "approve" | "reject",
		requestedId?: string,
	): PendingApproval | null => {
		let pending: PendingApproval | undefined;
		if (requestedId) pending = approvals.get(requestedId.toUpperCase());
		else if (approvals.size === 1) pending = [...approvals.values()][0];
		if (!pending || pending.done) return null;
		pending.done = true;
		approvals.delete(pending.id);
		pending.resolve(decision);
		return pending;
	};

	const onWechatMessage = async (msg: IncomingMessage) => {
		lastInbound = msg;
		const text = (msg.text || "").trim();

		// Approval messages are control-plane messages; don't send them to the LLM.
		const approval = parseApproval(text);
		if (approval) {
			const item = decideApproval(approval.decision, approval.id);
			if (item) {
				await bot?.reply(
					msg,
					`${approval.decision === "approve" ? "✅ 已批准" : "⛔ 已拒绝"} ${item.id}\n${compact(item.command, 500)}`,
				);
			} else {
				await bot?.reply(msg, "没有找到对应的待审批操作。可回复“待审批”查看列表。");
			}
			return;
		}

		if (/^(待审批|审批列表|pending)$/i.test(text)) {
			const items = [...approvals.values()];
			await bot?.reply(
				msg,
				items.length
					? `${items.map((x) => `${x.id}: ${compact(x.command, 300)}`).join("\n\n")}\n\n回复：批准 ID 或 拒绝 ID`
					: "当前没有待审批操作。",
			);
			return;
		}

		if (/^(状态|status)$/i.test(text)) {
			await bot?.reply(
				msg,
				[
					"Pi 微信连接正常",
					`工作目录：${activeCtx?.cwd ?? process.cwd()}`,
					`状态：${activeCtx?.isIdle() === false ? "执行中" : "空闲"}`,
					`待审批：${approvals.size}`,
				].join("\n"),
			);
			return;
		}

		if (!text) {
			await bot?.reply(msg, "目前先支持文字指令，请发送文字消息。");
			return;
		}

		try {
			await bot?.sendTyping(msg.userId);
		} catch {
			// Typing is best-effort.
		}

		currentWechatRequest = msg;
		currentRunFromWechat = true;
		status(`微信指令：${compact(text, 50)}`);
		try {
			if (activeCtx && !activeCtx.isIdle()) {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				await bot?.reply(msg, "收到，当前任务完成后继续处理这条指令。\n发送“状态”可查看进度。");
			} else {
				pi.sendUserMessage(text);
			}
		} catch (error) {
			currentRunFromWechat = false;
			currentWechatRequest = null;
			await bot?.reply(msg, `指令提交失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const connect = async (force: boolean, ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (starting) {
			notify("微信 iLink 正在连接，请稍候", "warning");
			return;
		}
		if (connected && bot && !force) {
			const creds = bot.getCredentials();
			notify(`微信 iLink 已连接\nBot: ${creds?.accountId ?? "connected"}`, "info");
			return;
		}

		starting = true;
		if (bot) bot.stop();
		bot = new WeChatBot({
			storage: "file",
			storageDir,
			logLevel: "warn",
			botAgent: `Pi-WeChat-iLink/${PACKAGE_VERSION}`,
		});
		status("微信 iLink 连接中…");

		try {
			const creds = await bot.login({
				force,
				callbacks: {
					onQrUrl: (url: string) => {
						qrTerminal.generate(url, { small: true }, (qr: string) => {
							process.stderr.write("\n  请使用手机微信扫描二维码：\n\n");
							for (const line of qr.split("\n")) process.stderr.write(`  ${line}\n`);
							process.stderr.write(`\n  若无法扫码，在微信中打开：${url}\n\n`);
						});
						status("请用微信扫码确认…");
					},
					onScanned: () => status("已扫码，请在微信确认…"),
					onExpired: () => status("二维码过期，正在刷新…"),
				},
			});

			connected = true;
			status(`微信 ✓ ${creds.accountId}`);
			notify(`微信官方 iLink 已连接\nBot: ${creds.accountId}\n现在可从手机微信向机器人发指令`, "info");

			bot.onMessage(onWechatMessage);
			bot.on("error", (error) => {
				status(`微信错误: ${error instanceof Error ? error.message : String(error)}`);
			});
			bot.on("session:expired", () => {
				connected = false;
				status("微信登录已过期，请 /wechat --force");
			});
			bot.on("session:restored", (credentials) => {
				connected = true;
				status(`微信 ✓ ${credentials.accountId}`);
			});
			void bot.start().catch((error) => {
				connected = false;
				status(`微信轮询失败: ${error instanceof Error ? error.message : String(error)}`);
			});
		} catch (error) {
			bot = null;
			connected = false;
			status(undefined);
			notify(`微信 iLink 登录失败: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			starting = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		// Stored iLink credentials are restored automatically, so reconnect on Pi start.
		void connect(false, ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const item of approvals.values()) {
			if (!item.done) {
				item.done = true;
				item.resolve("reject");
			}
		}
		approvals.clear();
		if (bot) bot.stop();
		bot = null;
		connected = false;
		activeCtx = null;
	});

	pi.on("before_agent_start", async (event) => {
		if (!currentRunFromWechat) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## 微信 iLink 会话\n本轮用户从手机微信发来指令。回复会原样发送到微信，请简洁、使用纯文本。若任务涉及文件，请明确给出文件路径和结果摘要。",
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		activeCtx = ctx;
		localRunStartedAt = Date.now();
		if (connected) status(currentRunFromWechat ? "微信任务执行中…" : "Pi 任务执行中…");
	});

	pi.on("agent_end", async (event, ctx) => {
		activeCtx = ctx;
		if (!currentRunFromWechat) return;
		// agent_end may be followed by retry/compaction. Cache the latest answer and only
		// reply after agent_settled confirms Pi will not continue automatically.
		const answer = finalAssistantText((event.messages as AssistantLikeMessage[]) ?? []);
		if (answer) pendingWechatAnswer = answer;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		activeCtx = ctx;
		if (!bot || !connected) return;

		if (currentRunFromWechat && currentWechatRequest) {
			const request = currentWechatRequest;
			const answer = pendingWechatAnswer || "任务已结束，但没有生成文字回复。";
			try {
				await bot.stopTyping(request.userId);
				await bot.reply(request, compact(stripMarkdown(answer)));
				status("微信回复已发送");
			} catch (error) {
				status(`微信回复失败: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				currentRunFromWechat = false;
				currentWechatRequest = null;
				pendingWechatAnswer = "";
				lastProactiveNoticeAt = localRunStartedAt;
			}
			return;
		}

		status(`微信 ✓ ${bot.getCredentials()?.accountId ?? "connected"}`);
		// A task started at the computer has no pending WeChat request. Proactively notify
		// the last user, but suppress duplicates caused by retries/very short runs.
		if (lastInbound && localRunStartedAt > lastProactiveNoticeAt) {
			lastProactiveNoticeAt = Date.now();
			await sendToLastUser(`✅ Pi 当前任务已完成，正在等待下一条指令。\n目录：${ctx.cwd}`);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" || !bot || !connected || !lastInbound) return;
		const command = String((event.input as { command?: string }).command ?? "");
		if (!DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) return;

		let resolver: (decision: Decision) => void = () => {};
		const promise = new Promise<Decision>((resolve) => {
			resolver = resolve;
		});
		const item: PendingApproval = {
			id: randomId(),
			command,
			createdAt: Date.now(),
			resolve: resolver,
			promise,
			done: false,
		};
		approvals.set(item.id, item);

		const timer = setTimeout(() => {
			if (item.done) return;
			item.done = true;
			approvals.delete(item.id);
			item.resolve("timeout");
		}, APPROVAL_TIMEOUT_MS);
		if (typeof timer.unref === "function") timer.unref();

		await sendToLastUser(
			[
				"⚠️ Pi 需要你审批危险操作",
				`审批 ID：${item.id}`,
				`命令：${compact(command, 1000)}`,
				"",
				`回复“批准 ${item.id}”或“拒绝 ${item.id}”`,
				"5 分钟未回复将自动拒绝。",
			].join("\n"),
		);
		status(`等待微信审批 ${item.id}`);

		// Local UI competes with WeChat; either side can decide first.
		if (ctx.hasUI) {
			void (async () => {
				try {
					const choice = await ctx.ui.select(
						`危险命令，等待微信审批 ${item.id}\n\n${compact(command, 300)}`,
						["批准", "拒绝", "仅等待微信"],
						{ timeout: APPROVAL_TIMEOUT_MS },
					);
					if (choice === "批准") decideApproval("approve", item.id);
					else if (choice === "拒绝") decideApproval("reject", item.id);
				} catch {
					// Keep waiting for WeChat.
				}
			})();
		}

		const decision = await item.promise;
		clearTimeout(timer);
		status(decision === "approve" ? `已批准 ${item.id}` : `已拒绝 ${item.id}`);
		if (decision === "approve") return;
		return {
			block: true,
			reason: `微信 iLink 审批${decision === "timeout" ? "超时" : "拒绝"}（${item.id}）`,
		};
	});

	pi.registerCommand("wechat", {
		description: "连接微信官方 iLink（首次显示二维码；--force 重新登录）",
		handler: async (args, ctx) => connect((args || "").includes("--force"), ctx),
	});
	pi.registerCommand("weixin", {
		description: "连接微信官方 iLink（/wechat 的别名）",
		handler: async (args, ctx) => connect((args || "").includes("--force"), ctx),
	});
	pi.registerCommand("wechat-status", {
		description: "查看微信 iLink 连接状态",
		handler: async (_args, ctx) => {
			activeCtx = ctx;
			const credentials = bot?.getCredentials();
			ctx.ui.notify(
				[
					`连接：${connected ? "正常" : starting ? "连接中" : "未连接"}`,
					`Bot：${credentials?.accountId ?? "-"}`,
					`最近用户：${lastInbound?.userId ?? "尚未收到消息"}`,
					`待审批：${approvals.size}`,
					`状态目录：${storageDir}`,
					`版本：${PACKAGE_VERSION}`,
				].join("\n"),
				"info",
			);
		},
	});
	pi.registerCommand("wechat-stop", {
		description: "断开微信 iLink",
		handler: async (_args, ctx) => {
			if (bot) bot.stop();
			bot = null;
			connected = false;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify("微信 iLink 已断开（凭证仍保留）", "info");
		},
	});
	pi.registerCommand("wechat-test", {
		description: "向最近联系 Pi 的微信用户发送测试消息",
		handler: async (_args, ctx) => {
			activeCtx = ctx;
			const ok = await sendToLastUser(
				"✅ Pi × 微信官方 iLink 连接测试成功。\n你可以直接在微信里发送任务指令。\n危险操作可回复“批准 ID”或“拒绝 ID”。",
			);
			ctx.ui.notify(
				ok ? "测试消息已发送" : "发送失败：请先在微信里给机器人发一条消息",
				ok ? "info" : "warning",
			);
		},
	});
}
