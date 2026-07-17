/**
 * 通过 lark-cli 子进程发送飞书消息（Phase 5 opt-in）。
 * 不依赖真实飞书即可单测：注入 runCommand。
 */

import { spawn } from "node:child_process";
import type {
	FeishuOutboundMessage,
	FeishuSendResult,
	FeishuTransport,
} from "./feishu-transport.js";

export type LarkCliRunResult = {
	stdout: string;
	stderr: string;
	code: number | null;
};

export type LarkCliRunner = (
	args: string[],
	options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<LarkCliRunResult>;

export type LarkCliFeishuTransportOptions = {
	/** bot | user */
	as?: "bot" | "user";
	/** ou_xxx，与 chatId 互斥 */
	userId?: string;
	/** oc_xxx，与 userId 互斥 */
	chatId?: string;
	/** 默认 lark-cli */
	cliPath?: string;
	/** 子进程超时，默认 30s */
	timeoutMs?: number;
	/** 注入执行器（测试 mock） */
	runCommand?: LarkCliRunner;
	/** 最近出站历史条数 */
	maxHistory?: number;
	log?: (line: string) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;

const QUIET_ENV: NodeJS.ProcessEnv = {
	LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
	LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
};

export class LarkCliFeishuTransport implements FeishuTransport {
	readonly history: Array<FeishuOutboundMessage & { messageId: string; sentAt: number }> =
		[];
	private readonly as: "bot" | "user";
	private userId?: string;
	private chatId?: string;
	private readonly cliPath: string;
	private readonly timeoutMs: number;
	private readonly runCommand: LarkCliRunner;
	private readonly maxHistory: number;
	private readonly log: (line: string) => void;

	constructor(options: LarkCliFeishuTransportOptions = {}) {
		this.as = options.as ?? "bot";
		this.userId = options.userId?.trim() || undefined;
		this.chatId = options.chatId?.trim() || undefined;
		this.cliPath = options.cliPath ?? "lark-cli";
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.runCommand = options.runCommand ?? defaultLarkCliRunner(this.cliPath);
		this.maxHistory = options.maxHistory ?? 100;
			this.log = options.log ?? ((line: string) => console.log(line));

		// 允许无收件人构造（/lark-pair bootstrap）；真正 send 前须 setRecipient 或构造时带入
		if (this.userId && this.chatId) {
			throw new Error("LarkCliFeishuTransport 的 userId 与 chatId 互斥");
		}
	}

	/** 配对绑定后热更新出站目标（本人 DM） */
	setRecipient(input: { userId?: string; chatId?: string }): void {
		const userId = input.userId?.trim() || undefined;
		const chatId = input.chatId?.trim() || undefined;
		if (!userId && !chatId) {
			throw new Error("setRecipient 需要 userId 或 chatId");
		}
		if (userId && chatId) {
			throw new Error("setRecipient 的 userId 与 chatId 互斥");
		}
		this.userId = userId;
		this.chatId = chatId;
	}

	async send(message: FeishuOutboundMessage): Promise<FeishuSendResult> {
		if (!this.userId && !this.chatId) {
			throw new Error(
				"LarkCliFeishuTransport 未配置收件人：请在 Pi 执行 /lark-pair 绑定本人，或配置 feishu.userId / chatId",
			);
		}
		const text = formatOutboundText(message);
		const args = [
			"im",
			"+messages-send",
			"--as",
			this.as,
			"--text",
			text,
			"--json",
		];
		if (this.userId) {
			args.push("--user-id", this.userId);
		} else if (this.chatId) {
			args.push("--chat-id", this.chatId);
		}

		this.log(
			`[lark-cli] send piId=${message.piId ?? "-"} event=${message.event ?? "-"} requestId=${message.requestId ?? "-"}`,
		);

		const result = await this.runCommand(args, {
			timeoutMs: this.timeoutMs,
			env: { ...process.env, ...QUIET_ENV },
		});

		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout || "").trim().slice(0, 800);
			throw new Error(
				`lark-cli im +messages-send 失败 (code=${result.code}): ${detail || "无输出"}`,
			);
		}

		const messageId = extractMessageId(result.stdout);
		if (!messageId) {
			throw new Error(
				`lark-cli 输出无法解析 message_id。stdout=${result.stdout.slice(0, 400)}`,
			);
		}

		this.pushHistory({ ...message, messageId, sentAt: Date.now() });
		return { messageId };
	}

	async sendApprovalCard(message: FeishuOutboundMessage): Promise<FeishuSendResult> {
		// Phase 5：文本 MVP（完整 interactive 卡片后续）；说明如何回复批准/拒绝
		const actions = (message.actions ?? ["approve", "reject"]).join("|");
		const prefix = message.requestId
			? message.requestId.slice(0, 8)
			: "(无 requestId)";
		const body = [
			`[审批 card actions=${actions}]`,
			message.body,
			"",
			"操作方式（任选）：",
			`1) 回复文本：批准 ${prefix}  或  拒绝 ${prefix}`,
			`2) HTTP：POST /control/approval {"requestId":"${message.requestId ?? ""}","decision":"approve|reject","openId":"ou_xxx"}`,
			"",
			"（完整交互卡片 card.action.trigger 将在后续版本提供）",
		].join("\n");

		return this.send({
			...message,
			title: message.title ?? "需要审批",
			body,
		});
	}

	private pushHistory(
		entry: FeishuOutboundMessage & { messageId: string; sentAt: number },
	): void {
		this.history.push(entry);
		while (this.history.length > this.maxHistory) {
			this.history.shift();
		}
	}
}

export function formatOutboundText(message: FeishuOutboundMessage): string {
	const parts: string[] = [];
	if (message.title) parts.push(message.title);
	if (message.piId) parts.push(`piId: ${message.piId}`);
	if (message.event) parts.push(`event: ${message.event}`);
	if (message.requestId) parts.push(`requestId: ${message.requestId}`);
	if (parts.length) parts.push("");
	parts.push(message.body);
	return parts.join("\n");
}

/**
 * 从 lark-cli --json 输出中提取 message_id（om_xxx）。
 * 兼容 { message_id } / { data: { message_id } } / 嵌套。
 */
export function extractMessageId(stdout: string): string | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;

	// 先尝试整段 JSON
	const candidates = collectJsonObjects(trimmed);
	for (const obj of candidates) {
		const id = findMessageIdInObject(obj);
		if (id) return id;
	}

	// 回退：正则 om_（飞书 message_id 可能含下划线等）
	const m = trimmed.match(/\b(om_[A-Za-z0-9_]+)\b/);
	return m?.[1] ?? null;
}

function collectJsonObjects(text: string): unknown[] {
	const out: unknown[] = [];
	// 多行 NDJSON 或单 JSON
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (const line of lines) {
		try {
			out.push(JSON.parse(line));
		} catch {
			// ignore line
		}
	}
	if (out.length === 0) {
		try {
			out.push(JSON.parse(text));
		} catch {
			// 尝试截取第一个 { ... }
			const start = text.indexOf("{");
			const end = text.lastIndexOf("}");
			if (start >= 0 && end > start) {
				try {
					out.push(JSON.parse(text.slice(start, end + 1)));
				} catch {
					// ignore
				}
			}
		}
	}
	return out;
}

function isMessageId(value: string): boolean {
	return /^om_[A-Za-z0-9_]+$/.test(value);
}

function findMessageIdInObject(value: unknown, depth = 0): string | null {
	if (depth > 6 || value === null || value === undefined) return null;
	if (typeof value === "string") {
		return isMessageId(value) ? value : null;
	}
	if (typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	for (const key of ["message_id", "messageId", "id"]) {
		const v = obj[key];
		if (typeof v === "string" && isMessageId(v)) return v;
	}
	for (const nested of Object.values(obj)) {
		const found = findMessageIdInObject(nested, depth + 1);
		if (found) return found;
	}
	return null;
}

function defaultLarkCliRunner(cliPath: string): LarkCliRunner {
	return (args, options) =>
		new Promise((resolve, reject) => {
			const child = spawn(cliPath, args, {
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			let stdout = "";
			let stderr = "";
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
				reject(new Error(`lark-cli 超时（${options.timeoutMs}ms）: ${args.join(" ")}`));
			}, options.timeoutMs);

			child.stdout?.on("data", (c: Buffer | string) => {
				stdout += typeof c === "string" ? c : c.toString("utf8");
			});
			child.stderr?.on("data", (c: Buffer | string) => {
				stderr += typeof c === "string" ? c : c.toString("utf8");
			});

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(
					new Error(
						`无法启动 ${cliPath}: ${err.message}。请确认已安装 lark-cli 并完成 auth。`,
					),
				);
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ stdout, stderr, code });
			});
		});
}
