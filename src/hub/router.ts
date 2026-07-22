/**
 * 默认路由规则（纯函数）：
 * - 仅 1 个在线 → 自动选中并设为默认
 * - 默认在线 → 投递默认
 * - 多在线无默认 / 默认已离线 → 不投递，返回列表提示
 */

import type { InstanceSnapshot } from "../protocol.js";

export type RouteDecision =
	| { kind: "deliver"; piId: string; reason: "single_online" | "default" }
	| { kind: "need_select"; reason: "no_default" | "default_offline" | "empty"; reply: string }
	| { kind: "ambiguous"; matches: InstanceSnapshot[]; reply: string }
	| { kind: "not_found"; reply: string }
	| { kind: "set_default"; piId: string; reply: string }
	| { kind: "list"; reply: string };

export function formatInstanceLine(i: InstanceSnapshot, isDefault: boolean): string {
	const mark = isDefault ? " *默认*" : "";
	return `- ${i.displayName} | piId=${i.piId} | ${i.status}${mark}\n  cwd: ${i.cwd}`;
}

export function formatOnlineList(
	online: InstanceSnapshot[],
	defaultPiId: string | null,
	header = "在线 Pi 列表：",
): string {
	if (online.length === 0) {
		return "当前没有在线的 Pi 实例。请先在目标项目启动 Pi 并加载 lark-bridge。";
	}
	const lines = online.map((i) => formatInstanceLine(i, i.piId === defaultPiId));
	const footer =
		online.length > 1 && !defaultPiId
			? "\n\n请发送：使用 <piId|项目名> 设定默认实例后再发指令。"
			: "\n\n发送「使用 <piId|项目名>」可切换默认实例。";
	return `${header}\n${lines.join("\n")}${footer}`;
}

/**
 * 入站纯文本（非控制命令）的路由决策。
 * 调用方若 reason 为 single_online，应同步 setDefault(piId)。
 */
export function routePlainText(input: {
	online: InstanceSnapshot[];
	defaultPiId: string | null;
}): RouteDecision {
	const { online, defaultPiId } = input;

	if (online.length === 0) {
		return {
			kind: "need_select",
			reason: "empty",
			reply: formatOnlineList(online, defaultPiId),
		};
	}

	if (online.length === 1) {
		const only = online[0]!;
		return { kind: "deliver", piId: only.piId, reason: "single_online" };
	}

	if (defaultPiId) {
		const stillOnline = online.some((i) => i.piId === defaultPiId);
		if (stillOnline) {
			return { kind: "deliver", piId: defaultPiId, reason: "default" };
		}
		return {
			kind: "need_select",
			reason: "default_offline",
			reply:
				`默认实例 ${defaultPiId} 已离线，已清除默认。\n\n` +
				formatOnlineList(online, null),
		};
	}

	return {
		kind: "need_select",
		reason: "no_default",
		reply: formatOnlineList(online, null, "有多个 Pi 在线且未设定默认，消息未投递。"),
	};
}

/**
 * 「使用 <query>」命令：唯一匹配则 set_default，多匹配 ambiguous，零匹配 not_found。
 */
export function routeUseCommand(input: {
	query: string;
	matches: InstanceSnapshot[];
	online: InstanceSnapshot[];
	defaultPiId: string | null;
}): RouteDecision {
	const { query, matches, online, defaultPiId } = input;
	const q = query.trim();
	if (!q) {
		return {
			kind: "not_found",
			reply: "用法：使用 <piId|项目名>\n\n" + formatOnlineList(online, defaultPiId),
		};
	}

	if (matches.length === 1) {
		const m = matches[0]!;
		return {
			kind: "set_default",
			piId: m.piId,
			reply: `已设定默认 Pi：${m.displayName}（${m.piId}）\ncwd: ${m.cwd}`,
		};
	}

	if (matches.length === 0) {
		return {
			kind: "not_found",
			reply: `未找到匹配「${q}」的在线实例。\n\n` + formatOnlineList(online, defaultPiId),
		};
	}

	return {
		kind: "ambiguous",
		matches,
		reply:
			`「${q}」匹配到多个实例，请用更精确的 piId：\n` +
			matches.map((i) => formatInstanceLine(i, i.piId === defaultPiId)).join("\n"),
	};
}

export function isListCommand(text: string): boolean {
	const t = text.trim();
	return /^(列表|list|ls|在线)$/i.test(t);
}

/** 解析「使用 xxx」；返回 query 或 null（非该命令） */
export function parseUseCommand(text: string): string | null {
	const t = text.trim();
	const m = t.match(/^(使用|use|switch)\s+(.+)$/i);
	if (!m) return null;
	return m[2]!.trim();
}

export type QueueCommand =
	| { action: "list" }
	| { action: "clear" }
	| { action: "cancel"; id: string };

/** 解析队列查看/取消/清空；非该命令返回 null */
export function parseQueueCommand(text: string): QueueCommand | null {
	const t = text.trim();
	if (/^(队列|queue)$/i.test(t)) return { action: "list" };
	if (/^(清空队列|clear\s*queue|queue\s*clear)$/i.test(t)) return { action: "clear" };
	const cancel = t.match(/^(取消|cancel)\s+(\S+)$/i);
	if (cancel) return { action: "cancel", id: cancel[2]! };
	return null;
}
