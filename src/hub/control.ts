/**
 * 控制面：处理「列表」「使用」、纯文本路由、按 messageId 回复绑定、审批决策。
 */

import type { ApprovalDecision, InstanceSnapshot, MessageSource } from "../protocol.js";
import {
	parseApprovalTextCommand,
	type ApprovalStore,
	type DecideApprovalResult,
} from "./approvals.js";
import type { MessageBindingStore } from "./bindings.js";
import { parsePairCommand, type PairingStore } from "./pairing.js";
import type { InstanceRegistry } from "./registry.js";
import {
	formatOnlineList,
	isListCommand,
	parseUseCommand,
	routePlainText,
	routeUseCommand,
	type RouteDecision,
} from "./router.js";

export type ControlResult = {
	/** 回给用户（飞书 / curl）的文本 */
	reply: string;
	/** 若应投递到某 Pi */
	deliveredTo?: string;
	/** 投递的用户文本（去掉控制命令后的原文） */
	deliverText?: string;
	/** 投递来源：reply 绑定 / default 路由 / command */
	source?: MessageSource;
	/** 若来自回复绑定，附带 requestId */
	replyToRequestId?: string;
	/** 审批：应向 Pi 下发的 approval_result */
	approvalDeliver?: {
		piId: string;
		requestId: string;
		decision: ApprovalDecision;
		actorOpenId?: string;
	};
	/** 内部决策，便于测试与日志 */
	decision:
		| RouteDecision
		| { kind: "list" }
		| { kind: "reply"; piId: string; messageId: string }
		| { kind: "reply_unbound"; messageId: string }
		| { kind: "reply_offline"; piId: string; messageId: string }
		| {
				kind: "approval";
				result: DecideApprovalResult;
				requestId: string;
		  }
		| {
				kind: "pair";
				ok: boolean;
				openId?: string;
				reason?: string;
		  }
		| { kind: "ignored"; reason: string };
};

export type ControlContext = {
	registry: InstanceRegistry;
	bindings?: MessageBindingStore;
	approvals?: ApprovalStore;
	pairing?: PairingStore;
	/** 是否授权；空白名单策略由调用方 isAuthorized 决定 */
	isAuthorized?: (openId?: string) => boolean;
	/** 配对成功后落盘并热更新；返回给用户的附加说明 */
	onOwnerBound?: (openId: string) => {
		ok: boolean;
		message: string;
	};
};

/**
 * 处理一条模拟飞书入站消息。
 * - 列表 / 使用：本地处理，不转发 Pi
 * - replyToMessageId：按绑定精确路由（忽略默认歧义）
 * - 其它文本：按路由规则投递或提示选择
 */
export function handleControlMessage(
	ctx: ControlContext,
	input: { text: string; openId?: string; replyToMessageId?: string },
): ControlResult {
	const text = (input.text ?? "").trim();
	const auth = ctx.isAuthorized ?? (() => true);

	if (!text) {
		return {
			reply: "请发送文字消息。可用命令：列表、使用 <piId|项目名>、配对 <码>",
			decision: { kind: "ignored", reason: "empty" },
		};
	}

	// 配对口令优先于白名单（解决首次无人在名单无法绑定）
	if (ctx.pairing) {
		const pairCmd = parsePairCommand(text);
		if (pairCmd) {
			return handlePairCommand(ctx, {
				code: pairCmd.code,
				openId: input.openId,
			});
		}
	}

	if (!auth(input.openId)) {
		return {
			reply:
				"无权限：当前用户未在白名单中。若为本人首次绑定，请在 Pi 执行 /lark-pair 后发送：配对 <码>",
			decision: { kind: "ignored", reason: "unauthorized" },
		};
	}

	const replyToMessageId = input.replyToMessageId?.trim();
	if (replyToMessageId) {
		return handleReplyRouting(ctx, { text, replyToMessageId });
	}

	// 可选：文本「批准/拒绝 <requestId前缀>」
	if (ctx.approvals) {
		const approvalCmd = parseApprovalTextCommand(text);
		if (approvalCmd) {
			return handleApprovalTextCommand(ctx, {
				...approvalCmd,
				openId: input.openId,
			});
		}
	}

	const online = ctx.registry.listSnapshots();
	const defaultPiId = ctx.registry.getDefaultPiId();

	if (isListCommand(text)) {
		return {
			reply: formatOnlineList(online, defaultPiId),
			decision: { kind: "list" },
		};
	}

	const useQuery = parseUseCommand(text);
	if (useQuery !== null) {
		const matches = ctx.registry.resolve(useQuery).map((i) => toSnapshot(i));
		const decision = routeUseCommand({
			query: useQuery,
			matches,
			online,
			defaultPiId,
		});
		if (decision.kind === "set_default") {
			ctx.registry.setDefault(decision.piId);
			return { reply: decision.reply, decision };
		}
		if (decision.kind === "ambiguous" || decision.kind === "not_found") {
			return { reply: decision.reply, decision };
		}
		return {
			reply: "无法处理「使用」命令。",
			decision: { kind: "ignored", reason: "use_unexpected" },
		};
	}

	// 默认离线时 routePlainText 会提示；同步清默认
	const decision = routePlainText({ online, defaultPiId });
	if (decision.kind === "need_select" && decision.reason === "default_offline") {
		ctx.registry.setDefault(null);
	}
	if (decision.kind === "deliver") {
		if (decision.reason === "single_online") {
			ctx.registry.setDefault(decision.piId);
		}
		return {
			reply: `已投递到 ${decision.piId}`,
			deliveredTo: decision.piId,
			deliverText: text,
			source: "default",
			decision,
		};
	}
	if (decision.kind === "need_select") {
		return { reply: decision.reply, decision };
	}

	return {
		reply: "无法路由该消息。",
		decision: { kind: "ignored", reason: "unhandled" },
	};
}

/**
 * 回复某条出站通知：messageId 绑定优先，未绑定则 fail-closed，不改投默认。
 */
function handleReplyRouting(
	ctx: ControlContext,
	input: { text: string; replyToMessageId: string },
): ControlResult {
	const { text, replyToMessageId } = input;
	const bindings = ctx.bindings;

	if (!bindings) {
		return {
			reply: `无法路由回复：Hub 未启用消息绑定（messageId=${replyToMessageId}）。`,
			decision: { kind: "reply_unbound", messageId: replyToMessageId },
		};
	}

	const binding = bindings.get(replyToMessageId);
	if (!binding) {
		return {
			reply:
				`无法路由回复：未找到 messageId=${replyToMessageId} 的绑定（可能已过期或非本 Hub 发出）。消息未投递。`,
			decision: { kind: "reply_unbound", messageId: replyToMessageId },
		};
	}

	const online = ctx.registry.get(binding.piId);
	if (!online) {
		return {
			reply:
				`目标 Pi ${binding.piId} 已离线，无法投递对 messageId=${replyToMessageId} 的回复。消息未改投其他实例。`,
			decision: {
				kind: "reply_offline",
				piId: binding.piId,
				messageId: replyToMessageId,
			},
		};
	}

	return {
		reply: `已按回复绑定投递到 ${binding.piId}`,
		deliveredTo: binding.piId,
		deliverText: text,
		source: "reply",
		replyToRequestId: binding.requestId,
		decision: {
			kind: "reply",
			piId: binding.piId,
			messageId: replyToMessageId,
		},
	};
}

function toSnapshot(i: {
	piId: string;
	displayName: string;
	cwd: string;
	pid: number;
	status: "idle" | "busy";
	capabilities: import("../protocol.js").Capability[];
	lastHeartbeatAt: number;
	connectedAt: number;
}): InstanceSnapshot {
	return {
		piId: i.piId,
		displayName: i.displayName,
		cwd: i.cwd,
		pid: i.pid,
		status: i.status,
		capabilities: [...i.capabilities],
		lastHeartbeatAt: i.lastHeartbeatAt,
		connectedAt: i.connectedAt,
	};
}

/**
 * HTTP / 卡片回调审批决策。
 * 调用方负责在 approvalDeliver 时 sendToPi + markDelivered。
 */
export function handleControlApproval(
	ctx: ControlContext,
	input: {
		requestId: string;
		decision: ApprovalDecision;
		openId?: string;
	},
): ControlResult {
	const auth = ctx.isAuthorized ?? (() => true);
	if (!auth(input.openId)) {
		return {
			reply: "无权限：当前用户未在白名单中，无法审批。",
			decision: { kind: "ignored", reason: "unauthorized" },
		};
	}

	const approvals = ctx.approvals;
	if (!approvals) {
		return {
			reply: "Hub 未启用审批状态机。",
			decision: { kind: "ignored", reason: "approvals_disabled" },
		};
	}

	const requestId = (input.requestId ?? "").trim();
	if (!requestId) {
		return {
			reply: "缺少 requestId。",
			decision: { kind: "ignored", reason: "empty_request_id" },
		};
	}

	if (input.decision !== "approve" && input.decision !== "reject") {
		return {
			reply: 'decision 必须是 "approve" 或 "reject"。',
			decision: { kind: "ignored", reason: "invalid_decision" },
		};
	}

	const result = approvals.decide({
		requestId,
		decision: input.decision,
		actorOpenId: input.openId,
		isPiOnline: (piId) => Boolean(ctx.registry.get(piId)),
	});

	return approvalResultToControl(result, requestId, input.openId);
}

function handlePairCommand(
	ctx: ControlContext,
	input: { code: string; openId?: string },
): ControlResult {
	const pairing = ctx.pairing!;
	const result = pairing.consume({
		code: input.code,
		openId: input.openId,
	});

	if (!result.ok) {
		const messages: Record<typeof result.reason, string> = {
			no_session: "没有进行中的配对。请在本机 Pi 执行 /lark-pair 获取新码。",
			expired: "配对码已过期。请在本机 Pi 重新执行 /lark-pair。",
			mismatch: "配对码不正确。请核对后重试（码区分大小写已自动忽略）。",
			no_open_id: "无法识别你的 open_id，配对失败。",
		};
		return {
			reply: messages[result.reason],
			decision: {
				kind: "pair",
				ok: false,
				reason: result.reason,
			},
		};
	}

	if (!ctx.onOwnerBound) {
		return {
			reply: `配对码正确，但 Hub 未配置落盘回调（openId=${result.openId}）。`,
			decision: {
				kind: "pair",
				ok: false,
				openId: result.openId,
				reason: "no_callback",
			},
		};
	}

	const bound = ctx.onOwnerBound(result.openId);
	return {
		reply: bound.ok
			? `已绑定为本人（仅你可控制）。open_id 已写入白名单与私聊目标。\n${bound.message}`
			: `配对校验通过，但保存配置失败：${bound.message}`,
		decision: {
			kind: "pair",
			ok: bound.ok,
			openId: result.openId,
			reason: bound.ok ? undefined : "save_failed",
		},
	};
}

function handleApprovalTextCommand(
	ctx: ControlContext,
	input: {
		decision: ApprovalDecision;
		requestIdPrefix: string;
		openId?: string;
	},
): ControlResult {
	const approvals = ctx.approvals!;
	// 前缀唯一匹配，或完整 requestId 精确命中
	const matched =
		approvals.resolveByPrefix(input.requestIdPrefix) ??
		approvals.get(input.requestIdPrefix) ??
		null;
	if (!matched) {
		return {
			reply: `未找到唯一匹配的审批 requestId 前缀「${input.requestIdPrefix}」。可用 GET /approvals 查看。`,
			decision: { kind: "ignored", reason: "approval_not_found" },
		};
	}

	return handleControlApproval(ctx, {
		requestId: matched.requestId,
		decision: input.decision,
		openId: input.openId,
	});
}

function approvalResultToControl(
	result: DecideApprovalResult,
	requestId: string,
	openId?: string,
): ControlResult {
	if (result.kind === "not_found") {
		return {
			reply: `未找到审批 requestId=${requestId}。`,
			decision: { kind: "approval", result, requestId },
		};
	}

	if (result.kind === "already_handled") {
		const r = result.record;
		return {
			reply: `审批已处理（幂等）：requestId=${r.requestId} status=${r.status} decision=${r.decision ?? "-"}。不会重复通知 Pi。`,
			decision: { kind: "approval", result, requestId: r.requestId },
		};
	}

	// decided
	const r = result.record;
	if (result.offline) {
		return {
			reply: `目标 Pi ${r.piId} 已离线，审批结果（${r.decision}）无法投递，未改投其他实例。requestId=${r.requestId}`,
			decision: { kind: "approval", result, requestId: r.requestId },
		};
	}

	if (result.shouldDeliver) {
		return {
			reply: `已将审批结果 ${r.decision} 投递到 Pi ${r.piId}（requestId=${r.requestId}）。`,
			deliveredTo: r.piId,
			approvalDeliver: {
				piId: r.piId,
				requestId: r.requestId,
				decision: r.decision ?? "reject",
				actorOpenId: openId ?? r.actorOpenId,
			},
			decision: { kind: "approval", result, requestId: r.requestId },
		};
	}

	return {
		reply: `审批已记录：requestId=${r.requestId} status=${r.status}。`,
		decision: { kind: "approval", result, requestId: r.requestId },
	};
}
