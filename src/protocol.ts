/**
 * Pi ↔ pi-lark-hub 共享协议类型与辅助函数。
 * 传输：本机 loopback WebSocket，JSON 文本帧。
 */

export const PROTOCOL_VERSION = 1;

export type PiStatus = "idle" | "busy";

export type NotifyEvent = "approval" | "need_reply" | "task_end";

export type MessageSource = "reply" | "default" | "command";

export type ApprovalDecision = "approve" | "reject";

export type Capability = "approval" | "prompt" | "settled";

/** Hub 对 Bridge 暴露的协议能力；新增不破坏旧客户端 */
export const HUB_FEATURES = ["pair_begin"] as const;
export type HubFeature = (typeof HUB_FEATURES)[number];

/** Pi → Hub：注册（piId 可省略，由 Hub 生成） */
export type RegisterMessage = {
	type: "register";
	piId?: string;
	displayName: string;
	cwd: string;
	pid: number;
	capabilities?: Capability[];
};

/** Pi → Hub：心跳 */
export type HeartbeatMessage = {
	type: "heartbeat";
	piId: string;
	status: PiStatus;
	ts: number;
};

/** Pi → Hub：出站事件（阶段 0-1 可仅记录） */
export type NotifyMessage = {
	type: "notify";
	piId: string;
	event: NotifyEvent;
	requestId: string;
	title: string;
	body: string;
	actions?: Array<"approve" | "reject">;
	timeoutMs?: number;
};

/** Pi → Hub：注销 */
export type UnregisterMessage = {
	type: "unregister";
	piId: string;
};

/** Pi → Hub：发起飞书本人配对（生成短码） */
export type PairBeginMessage = {
	type: "pair_begin";
	piId: string;
};

/** Hub → Pi：注册成功 */
export type RegisterOkMessage = {
	type: "register_ok";
	piId: string;
};

/** Hub → Pi：notify 已出站（含飞书 messageId，供绑定/调试） */
export type NotifyAckMessage = {
	type: "notify_ack";
	requestId: string;
	messageId: string;
};

/** Hub → Pi：用户文本 */
export type UserMessage = {
	type: "user_message";
	piId: string;
	text: string;
	source: MessageSource;
	replyToRequestId?: string;
};

/** Hub → Pi：审批结果 */
export type ApprovalResultMessage = {
	type: "approval_result";
	piId: string;
	requestId: string;
	decision: ApprovalDecision;
	actorOpenId?: string;
};

/** Hub → Pi：错误 */
export type ErrorMessage = {
	type: "error";
	message: string;
};

/** Hub → Pi：配对码挑战（本机展示） */
export type PairChallengeMessage = {
	type: "pair_challenge";
	code: string;
	expiresAt: number;
	ttlMs: number;
};

/** Hub → Pi：配对结果（成功/失败摘要） */
export type PairResultMessage = {
	type: "pair_result";
	ok: boolean;
	openId?: string;
	message: string;
};

export type PiToHubMessage =
	| RegisterMessage
	| HeartbeatMessage
	| NotifyMessage
	| UnregisterMessage
	| PairBeginMessage;

export type HubToPiMessage =
	| RegisterOkMessage
	| NotifyAckMessage
	| UserMessage
	| ApprovalResultMessage
	| ErrorMessage
	| PairChallengeMessage
	| PairResultMessage;

export type ProtocolMessage = PiToHubMessage | HubToPiMessage;

/** 在线实例快照（HTTP /health、/instances） */
export type InstanceSnapshot = {
	piId: string;
	displayName: string;
	cwd: string;
	pid: number;
	status: PiStatus;
	capabilities: Capability[];
	lastHeartbeatAt: number;
	connectedAt: number;
};

export function generatePiId(): string {
	return Math.random().toString(36).slice(2, 6);
}

export function generateRequestId(): string {
	// 足够熵，不可仅靠短可猜串
	const a = Math.random().toString(36).slice(2);
	const b = Date.now().toString(36);
	const c = Math.random().toString(36).slice(2);
	return `${b}-${a}-${c}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProtocolMessage(raw: string): ProtocolMessage | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(data) || typeof data.type !== "string") return null;
	return data as ProtocolMessage;
}

export function serializeMessage(msg: ProtocolMessage): string {
	return JSON.stringify(msg);
}

export function isPiToHubMessage(msg: ProtocolMessage): msg is PiToHubMessage {
	return (
		msg.type === "register" ||
		msg.type === "heartbeat" ||
		msg.type === "notify" ||
		msg.type === "unregister" ||
		msg.type === "pair_begin"
	);
}
