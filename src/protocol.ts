/** Pi 与本机 Hub 的 loopback WebSocket 协议。 */
export const PROTOCOL_VERSION = 1;
export type PiStatus = "idle" | "busy";
export type NotifyEvent = "approval" | "task_end";
export type MessageSource = "reply" | "default" | "command";
export type ApprovalDecision = "approve" | "reject";
export type Capability = "approval" | "prompt" | "settled";
export const HUB_FEATURES = ["lark_open", "lark_reset"] as const;
export type HubFeature = (typeof HUB_FEATURES)[number];
export type RegisterMessage = { type: "register"; piId?: string; displayName: string; cwd: string; pid: number; capabilities?: Capability[] };
export type HeartbeatMessage = { type: "heartbeat"; piId: string; status: PiStatus; ts: number };
export type NotifyMessage = { type: "notify"; piId: string; event: NotifyEvent; requestId: string; title: string; body: string; actions?: Array<"approve" | "reject">; timeoutMs?: number };
export type UnregisterMessage = { type: "unregister"; piId: string };
export type LarkOpenMessage = { type: "lark_open"; piId: string };
export type LarkResetMessage = { type: "lark_reset"; piId: string };
export type RegisterOkMessage = { type: "register_ok"; piId: string };
export type NotifyAckMessage = { type: "notify_ack"; requestId: string; messageId: string };
export type UserMessage = { type: "user_message"; piId: string; text: string; source: MessageSource; replyToRequestId?: string };
export type ApprovalResultMessage = { type: "approval_result"; piId: string; requestId: string; decision: ApprovalDecision; actorOpenId?: string };
export type ErrorMessage = { type: "error"; message: string };
export type LarkChallengeMessage = { type: "lark_challenge"; url: string; expiresAt: number; ttlMs: number };
export type LarkResultMessage = { type: "lark_result"; ok: boolean; connected: boolean; reset?: boolean; appId?: string; message: string };
export type PiToHubMessage = RegisterMessage | HeartbeatMessage | NotifyMessage | UnregisterMessage | LarkOpenMessage | LarkResetMessage;
export type HubToPiMessage = RegisterOkMessage | NotifyAckMessage | UserMessage | ApprovalResultMessage | ErrorMessage | LarkChallengeMessage | LarkResultMessage;
export type ProtocolMessage = PiToHubMessage | HubToPiMessage;
export type InstanceSnapshot = { piId: string; displayName: string; cwd: string; pid: number; status: PiStatus; capabilities: Capability[]; lastHeartbeatAt: number; connectedAt: number };
export function generatePiId(): string { return Math.random().toString(36).slice(2, 6); }
export function generateRequestId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function parseProtocolMessage(raw: string): ProtocolMessage | null { try { const data = JSON.parse(raw); return isRecord(data) && typeof data.type === "string" ? data as ProtocolMessage : null; } catch { return null; } }
export function serializeMessage(msg: ProtocolMessage): string { return JSON.stringify(msg); }
export function isPiToHubMessage(msg: ProtocolMessage): msg is PiToHubMessage { return ["register", "heartbeat", "notify", "unregister", "lark_open", "lark_reset"].includes(msg.type); }
