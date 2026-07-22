/** Pi 与本机 Hub 的 loopback WebSocket 协议。 */

export const PROTOCOL_VERSION = 1;

export type PiStatus = "idle" | "busy";
export type NotifyEvent = "approval" | "task_end";
export type MessageSource = "reply" | "default" | "command";
export type ApprovalDecision = "approve" | "reject";
export type Capability = "approval" | "prompt" | "settled";

export const HUB_FEATURES = ["lark_open", "lark_reset"] as const;
export type HubFeature = (typeof HUB_FEATURES)[number];

export type RegisterMessage = {
	type: "register";
	piId?: string;
	displayName: string;
	cwd: string;
	pid: number;
	capabilities?: Capability[];
};
export type HeartbeatMessage = { type: "heartbeat"; piId: string; status: PiStatus; ts: number };
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
export type UnregisterMessage = { type: "unregister"; piId: string };
export type LarkOpenMessage = { type: "lark_open"; piId: string };
export type LarkResetMessage = { type: "lark_reset"; piId: string };
export type RegisterOkMessage = { type: "register_ok"; piId: string };
export type NotifyAckMessage = { type: "notify_ack"; requestId: string; messageId: string };
export type UserMessage = {
	type: "user_message";
	piId: string;
	text: string;
	source: MessageSource;
	replyToRequestId?: string;
};
export type ApprovalResultMessage = {
	type: "approval_result";
	piId: string;
	requestId: string;
	decision: ApprovalDecision;
	actorOpenId?: string;
};
export type ErrorMessage = { type: "error"; message: string };
export type LarkChallengeMessage = {
	type: "lark_challenge";
	url: string;
	expiresAt: number;
	ttlMs: number;
};
export type LarkResultMessage = {
	type: "lark_result";
	ok: boolean;
	connected: boolean;
	reset?: boolean;
	appId?: string;
	message: string;
};

export type PiToHubMessage =
	| RegisterMessage
	| HeartbeatMessage
	| NotifyMessage
	| UnregisterMessage
	| LarkOpenMessage
	| LarkResetMessage;
export type HubToPiMessage =
	| RegisterOkMessage
	| NotifyAckMessage
	| UserMessage
	| ApprovalResultMessage
	| ErrorMessage
	| LarkChallengeMessage
	| LarkResultMessage;
export type ProtocolMessage = PiToHubMessage | HubToPiMessage;

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

/** 协议帧与字段上限（JS string length，除非另注字节） */
export const PROTOCOL_LIMITS = {
	frameBytes: 256 * 1024,
	title: 512,
	body: 200_000,
	text: 200_000,
	cwd: 2048,
	displayName: 128,
	id: 128,
	url: 4096,
	errorMessage: 2048,
	appId: 128,
	openId: 128,
	messageId: 256,
	arrayMax: 16,
	pidMin: 1,
	pidMax: 2 ** 31 - 1,
	timeoutMsMax: 24 * 60 * 60 * 1000,
} as const;

export type ProtocolDecodeErrorCode =
	| "frame_too_large"
	| "invalid_json"
	| "not_object"
	| "unknown_type"
	| "wrong_direction"
	| "missing_field"
	| "invalid_type"
	| "invalid_enum"
	| "too_long"
	| "invalid_number"
	| "array_too_large";

export type ProtocolDecodeError = {
	ok: false;
	code: ProtocolDecodeErrorCode;
	message: string;
};

export type ProtocolDecodeOk<T> = { ok: true; message: T };
export type ProtocolDecodeResult<T> = ProtocolDecodeOk<T> | ProtocolDecodeError;

const PI_TO_HUB_TYPES = new Set([
	"register",
	"heartbeat",
	"notify",
	"unregister",
	"lark_open",
	"lark_reset",
]);
const HUB_TO_PI_TYPES = new Set([
	"register_ok",
	"notify_ack",
	"user_message",
	"approval_result",
	"error",
	"lark_challenge",
	"lark_result",
]);

const PI_STATUS = new Set<PiStatus>(["idle", "busy"]);
const NOTIFY_EVENT = new Set<NotifyEvent>(["approval", "task_end"]);
const MESSAGE_SOURCE = new Set<MessageSource>(["reply", "default", "command"]);
const APPROVAL_DECISION = new Set<ApprovalDecision>(["approve", "reject"]);
const CAPABILITY = new Set<Capability>(["approval", "prompt", "settled"]);
const ACTION = new Set<"approve" | "reject">(["approve", "reject"]);

export function generatePiId(): string {
	return Math.random().toString(36).slice(2, 6);
}

export function generateRequestId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: ProtocolDecodeErrorCode, message: string): ProtocolDecodeError {
	return { ok: false, code, message };
}

function parseJsonObject(raw: string): ProtocolDecodeResult<Record<string, unknown>> {
	if (typeof raw !== "string") return fail("invalid_type", "消息必须是字符串");
	const bytes = Buffer.byteLength(raw, "utf8");
	if (bytes > PROTOCOL_LIMITS.frameBytes) {
		return fail("frame_too_large", `消息过大（${bytes} 字节，上限 ${PROTOCOL_LIMITS.frameBytes}）`);
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return fail("invalid_json", "无法解析的 JSON");
	}
	if (!isRecord(data)) return fail("not_object", "消息必须是 JSON 对象");
	return { ok: true, message: data };
}

function requireString(
	obj: Record<string, unknown>,
	key: string,
	max: number,
	options?: { optional?: boolean; allowEmpty?: boolean },
): string | ProtocolDecodeError | undefined {
	const value = obj[key];
	if (value === undefined) {
		if (options?.optional) return undefined;
		return fail("missing_field", `缺少字段 ${key}`);
	}
	if (typeof value !== "string") return fail("invalid_type", `字段 ${key} 必须是字符串`);
	if (!options?.allowEmpty && value.trim().length === 0) {
		return fail("missing_field", `字段 ${key} 不能为空`);
	}
	if (value.length > max) return fail("too_long", `字段 ${key} 过长（上限 ${max}）`);
	return value;
}

function requireNumber(
	obj: Record<string, unknown>,
	key: string,
	options?: { optional?: boolean; min?: number; max?: number; integer?: boolean },
): number | ProtocolDecodeError | undefined {
	const value = obj[key];
	if (value === undefined) {
		if (options?.optional) return undefined;
		return fail("missing_field", `缺少字段 ${key}`);
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fail("invalid_number", `字段 ${key} 必须是有限数字`);
	}
	if (options?.integer && !Number.isInteger(value)) {
		return fail("invalid_number", `字段 ${key} 必须是整数`);
	}
	if (options?.min !== undefined && value < options.min) {
		return fail("invalid_number", `字段 ${key} 过小`);
	}
	if (options?.max !== undefined && value > options.max) {
		return fail("invalid_number", `字段 ${key} 过大`);
	}
	return value;
}

function requireBoolean(
	obj: Record<string, unknown>,
	key: string,
	options?: { optional?: boolean },
): boolean | ProtocolDecodeError | undefined {
	const value = obj[key];
	if (value === undefined) {
		if (options?.optional) return undefined;
		return fail("missing_field", `缺少字段 ${key}`);
	}
	if (typeof value !== "boolean") return fail("invalid_type", `字段 ${key} 必须是布尔值`);
	return value;
}

function requireEnum<T extends string>(
	obj: Record<string, unknown>,
	key: string,
	allowed: Set<T>,
	options?: { optional?: boolean },
): T | ProtocolDecodeError | undefined {
	const value = obj[key];
	if (value === undefined) {
		if (options?.optional) return undefined;
		return fail("missing_field", `缺少字段 ${key}`);
	}
	if (typeof value !== "string" || !allowed.has(value as T)) {
		return fail("invalid_enum", `字段 ${key} 取值无效`);
	}
	return value as T;
}

function requireStringArray<T extends string>(
	obj: Record<string, unknown>,
	key: string,
	allowed: Set<T>,
	options?: { optional?: boolean },
): T[] | ProtocolDecodeError | undefined {
	const value = obj[key];
	if (value === undefined) {
		if (options?.optional) return undefined;
		return fail("missing_field", `缺少字段 ${key}`);
	}
	if (!Array.isArray(value)) return fail("invalid_type", `字段 ${key} 必须是数组`);
	if (value.length > PROTOCOL_LIMITS.arrayMax) {
		return fail("array_too_large", `字段 ${key} 元素过多（上限 ${PROTOCOL_LIMITS.arrayMax}）`);
	}
	const out: T[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !allowed.has(item as T)) {
			return fail("invalid_enum", `字段 ${key} 含无效元素`);
		}
		out.push(item as T);
	}
	return out;
}

function isError(value: unknown): value is ProtocolDecodeError {
	return isRecord(value) && value.ok === false;
}

function decodePiToHubObject(data: Record<string, unknown>): ProtocolDecodeResult<PiToHubMessage> {
	const type = data.type;
	if (typeof type !== "string") return fail("missing_field", "缺少字段 type");
	if (HUB_TO_PI_TYPES.has(type)) return fail("wrong_direction", `消息方向错误：${type} 应由 Hub 下发`);
	if (!PI_TO_HUB_TYPES.has(type)) return fail("unknown_type", `未知消息类型：${type}`);

	switch (type) {
		case "register": {
			const displayName = requireString(data, "displayName", PROTOCOL_LIMITS.displayName);
			if (isError(displayName)) return displayName;
			const cwd = requireString(data, "cwd", PROTOCOL_LIMITS.cwd);
			if (isError(cwd)) return cwd;
			const pid = requireNumber(data, "pid", {
				integer: true,
				min: PROTOCOL_LIMITS.pidMin,
				max: PROTOCOL_LIMITS.pidMax,
			});
			if (isError(pid)) return pid;
			const piId = requireString(data, "piId", PROTOCOL_LIMITS.id, { optional: true });
			if (isError(piId)) return piId;
			const capabilities = requireStringArray(data, "capabilities", CAPABILITY, { optional: true });
			if (isError(capabilities)) return capabilities;
			const msg: RegisterMessage = {
				type: "register",
				displayName: displayName!,
				cwd: cwd!,
				pid: pid!,
			};
			if (piId !== undefined) msg.piId = piId;
			if (capabilities !== undefined) msg.capabilities = capabilities;
			return { ok: true, message: msg };
		}
		case "heartbeat": {
			const piId = requireString(data, "piId", PROTOCOL_LIMITS.id);
			if (isError(piId)) return piId;
			const status = requireEnum(data, "status", PI_STATUS);
			if (isError(status)) return status;
			const ts = requireNumber(data, "ts");
			if (isError(ts)) return ts;
			return {
				ok: true,
				message: { type: "heartbeat", piId: piId!, status: status!, ts: ts! },
			};
		}
		case "notify": {
			const piId = requireString(data, "piId", PROTOCOL_LIMITS.id);
			if (isError(piId)) return piId;
			const event = requireEnum(data, "event", NOTIFY_EVENT);
			if (isError(event)) return event;
			const requestId = requireString(data, "requestId", PROTOCOL_LIMITS.id);
			if (isError(requestId)) return requestId;
			const title = requireString(data, "title", PROTOCOL_LIMITS.title, { allowEmpty: true });
			if (isError(title)) return title;
			const body = requireString(data, "body", PROTOCOL_LIMITS.body, { allowEmpty: true });
			if (isError(body)) return body;
			const actions = requireStringArray(data, "actions", ACTION, { optional: true });
			if (isError(actions)) return actions;
			const timeoutMs = requireNumber(data, "timeoutMs", {
				optional: true,
				min: 1,
				max: PROTOCOL_LIMITS.timeoutMsMax,
			});
			if (isError(timeoutMs)) return timeoutMs;
			const msg: NotifyMessage = {
				type: "notify",
				piId: piId!,
				event: event!,
				requestId: requestId!,
				title: title!,
				body: body!,
			};
			if (actions !== undefined) msg.actions = actions;
			if (timeoutMs !== undefined) msg.timeoutMs = timeoutMs;
			return { ok: true, message: msg };
		}
		case "unregister":
		case "lark_open":
		case "lark_reset": {
			const piId = requireString(data, "piId", PROTOCOL_LIMITS.id);
			if (isError(piId)) return piId;
			return { ok: true, message: { type, piId: piId! } as PiToHubMessage };
		}
		default:
			return fail("unknown_type", `未知消息类型：${String(type)}`);
	}
}

function decodeHubToPiObject(data: Record<string, unknown>): ProtocolDecodeResult<HubToPiMessage> {
	const type = data.type;
	if (typeof type !== "string") return fail("missing_field", "缺少字段 type");
	if (PI_TO_HUB_TYPES.has(type)) return fail("wrong_direction", `消息方向错误：${type} 应由 Pi 上报`);
	if (!HUB_TO_PI_TYPES.has(type)) return fail("unknown_type", `未知消息类型：${type}`);

	switch (type) {
		case "register_ok": {
			const piId = requireString(data, "piId", PROTOCOL_LIMITS.id);
			if (isError(piId)) return piId;
			return { ok: true, message: { type: "register_ok", piId: piId! } };
		}
		case "notify_ack": {
			const requestId = requireString(data, "requestId", PROTOCOL_LIMITS.id);
			if (isError(requestId)) return requestId;
			const messageId = requireString(data, "messageId", PROTOCOL_LIMITS.messageId);
			if (isError(messageId)) return messageId;
			return {
				ok: true,
				message: { type: "notify_ack", requestId: requestId!, messageId: messageId! },
			};
		}
		case "user_message": {
			const piId = requireString(data, "piId", PROTOCOL_LIMITS.id);
			if (isError(piId)) return piId;
			const text = requireString(data, "text", PROTOCOL_LIMITS.text, { allowEmpty: true });
			if (isError(text)) return text;
			const source = requireEnum(data, "source", MESSAGE_SOURCE);
			if (isError(source)) return source;
			const replyToRequestId = requireString(data, "replyToRequestId", PROTOCOL_LIMITS.id, {
				optional: true,
			});
			if (isError(replyToRequestId)) return replyToRequestId;
			const msg: UserMessage = {
				type: "user_message",
				piId: piId!,
				text: text!,
				source: source!,
			};
			if (replyToRequestId !== undefined) msg.replyToRequestId = replyToRequestId;
			return { ok: true, message: msg };
		}
		case "approval_result": {
			const piId = requireString(data, "piId", PROTOCOL_LIMITS.id);
			if (isError(piId)) return piId;
			const requestId = requireString(data, "requestId", PROTOCOL_LIMITS.id);
			if (isError(requestId)) return requestId;
			const decision = requireEnum(data, "decision", APPROVAL_DECISION);
			if (isError(decision)) return decision;
			const actorOpenId = requireString(data, "actorOpenId", PROTOCOL_LIMITS.openId, {
				optional: true,
			});
			if (isError(actorOpenId)) return actorOpenId;
			const msg: ApprovalResultMessage = {
				type: "approval_result",
				piId: piId!,
				requestId: requestId!,
				decision: decision!,
			};
			if (actorOpenId !== undefined) msg.actorOpenId = actorOpenId;
			return { ok: true, message: msg };
		}
		case "error": {
			const message = requireString(data, "message", PROTOCOL_LIMITS.errorMessage, {
				allowEmpty: true,
			});
			if (isError(message)) return message;
			return { ok: true, message: { type: "error", message: message! } };
		}
		case "lark_challenge": {
			const url = requireString(data, "url", PROTOCOL_LIMITS.url);
			if (isError(url)) return url;
			const expiresAt = requireNumber(data, "expiresAt");
			if (isError(expiresAt)) return expiresAt;
			const ttlMs = requireNumber(data, "ttlMs", { min: 0 });
			if (isError(ttlMs)) return ttlMs;
			return {
				ok: true,
				message: {
					type: "lark_challenge",
					url: url!,
					expiresAt: expiresAt!,
					ttlMs: ttlMs!,
				},
			};
		}
		case "lark_result": {
			const ok = requireBoolean(data, "ok");
			if (isError(ok)) return ok;
			const connected = requireBoolean(data, "connected");
			if (isError(connected)) return connected;
			const message = requireString(data, "message", PROTOCOL_LIMITS.errorMessage, {
				allowEmpty: true,
			});
			if (isError(message)) return message;
			const reset = requireBoolean(data, "reset", { optional: true });
			if (isError(reset)) return reset;
			const appId = requireString(data, "appId", PROTOCOL_LIMITS.appId, { optional: true });
			if (isError(appId)) return appId;
			const msg: LarkResultMessage = {
				type: "lark_result",
				ok: ok!,
				connected: connected!,
				message: message!,
			};
			if (reset !== undefined) msg.reset = reset;
			if (appId !== undefined) msg.appId = appId;
			return { ok: true, message: msg };
		}
		default:
			return fail("unknown_type", `未知消息类型：${String(type)}`);
	}
}

export function decodePiToHubMessage(raw: string): ProtocolDecodeResult<PiToHubMessage> {
	const parsed = parseJsonObject(raw);
	if (!parsed.ok) return parsed;
	return decodePiToHubObject(parsed.message);
}

export function decodeHubToPiMessage(raw: string): ProtocolDecodeResult<HubToPiMessage> {
	const parsed = parseJsonObject(raw);
	if (!parsed.ok) return parsed;
	return decodeHubToPiObject(parsed.message);
}

/**
 * 兼容旧调用：宽松解析。新代码请使用 decodePiToHubMessage / decodeHubToPiMessage。
 * 仅在解码成功时返回消息，失败返回 null（不区分错误码）。
 */
export function parseProtocolMessage(raw: string): ProtocolMessage | null {
	const asPi = decodePiToHubMessage(raw);
	if (asPi.ok) return asPi.message;
	const asHub = decodeHubToPiMessage(raw);
	if (asHub.ok) return asHub.message;
	return null;
}

export function serializeMessage(msg: ProtocolMessage): string {
	return JSON.stringify(msg);
}

export function isPiToHubMessage(msg: ProtocolMessage): msg is PiToHubMessage {
	return PI_TO_HUB_TYPES.has(msg.type);
}

export function isHubToPiMessage(msg: ProtocolMessage): msg is HubToPiMessage {
	return HUB_TO_PI_TYPES.has(msg.type);
}

export function formatProtocolDecodeError(error: ProtocolDecodeError): string {
	return `协议错误（${error.code}）：${error.message}`;
}
