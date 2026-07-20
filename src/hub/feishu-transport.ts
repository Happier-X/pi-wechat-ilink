/**
 * 飞书出站传输抽象。阶段 2 起 send 返回 messageId 供绑定；
 * 未开局时使用不可对外发送的占位实现。
 */

export type FeishuOutboundMessage = {
	title?: string;
	body: string;
	piId?: string;
	event?: string;
	requestId?: string;
	actions?: string[];
};

export type FeishuSendResult = {
	messageId: string;
};

export interface FeishuTransport {
	/**
	 * 向授权用户发送文本/摘要/卡片。
	 * 必须返回可绑定的真实飞书 message_id。
	 */
	send(message: FeishuOutboundMessage): Promise<FeishuSendResult>;


	/** 发送审批卡片（阶段 3）；可与 send 合并 */
	sendApprovalCard?(message: FeishuOutboundMessage): Promise<FeishuSendResult>;
}

/** 测试用：可预测 messageId 或自定义生成 */
export class NoopFeishuTransport implements FeishuTransport {
	readonly sent: Array<FeishuOutboundMessage & { messageId: string }> = [];
	private seq = 0;
	private readonly idFactory?: () => string;

	constructor(options?: { idFactory?: () => string }) {
		this.idFactory = options?.idFactory;
	}

	async send(message: FeishuOutboundMessage): Promise<FeishuSendResult> {
		const messageId = this.idFactory?.() ?? `noop-${++this.seq}`;
		this.sent.push({ ...message, messageId });
		return { messageId };
	}
}
