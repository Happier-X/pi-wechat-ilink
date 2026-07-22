/**
 * Bridge 用户消息 FIFO：短 id、容量上限、列表与取消。
 * 仅管理待执行项；已开始的 agent run 不在此队列。
 */

export type QueuedTask = {
	id: string;
	text: string;
	source: string;
	enqueuedAt: number;
};

export type TaskQueueOptions = {
	maxSize?: number;
	/** 生成 id；默认 q + base36 时间 + 随机 */
	idFactory?: () => string;
};

export class TaskQueue {
	private readonly items: QueuedTask[] = [];
	private readonly maxSize: number;
	private readonly idFactory: () => string;

	constructor(options?: TaskQueueOptions) {
		this.maxSize = options?.maxSize ?? 20;
		this.idFactory =
			options?.idFactory ??
			(() => `q${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`);
	}

	get size(): number {
		return this.items.length;
	}

	get max(): number {
		return this.maxSize;
	}

	list(): QueuedTask[] {
		return this.items.map((i) => ({ ...i }));
	}

	/** 入队；满则返回 null */
	enqueue(input: { text: string; source: string; enqueuedAt?: number }): QueuedTask | null {
		if (this.items.length >= this.maxSize) return null;
		const item: QueuedTask = {
			id: this.idFactory(),
			text: input.text,
			source: input.source,
			enqueuedAt: input.enqueuedAt ?? Date.now(),
		};
		this.items.push(item);
		return item;
	}

	/** 取出队首 */
	shift(): QueuedTask | undefined {
		return this.items.shift();
	}

	/** 按 id 取消；支持完整 id 或唯一前缀 */
	cancel(idOrPrefix: string): { ok: true; item: QueuedTask } | { ok: false; reason: string } {
		const q = idOrPrefix.trim();
		if (!q) return { ok: false, reason: "缺少队列项 id" };
		const matches = this.items.filter((i) => i.id === q || i.id.startsWith(q));
		if (matches.length === 0) return { ok: false, reason: `未找到队列项 ${q}` };
		if (matches.length > 1) return { ok: false, reason: `前缀 ${q} 匹配多项，请用更长 id` };
		const item = matches[0]!;
		const idx = this.items.findIndex((i) => i.id === item.id);
		if (idx < 0) return { ok: false, reason: `未找到队列项 ${q}` };
		this.items.splice(idx, 1);
		return { ok: true, item };
	}

	clear(): number {
		const n = this.items.length;
		this.items.length = 0;
		return n;
	}

	formatList(busyHint?: string): string {
		const lines = [
			`【待执行队列】${this.items.length}/${this.maxSize}${busyHint ? ` · ${busyHint}` : ""}`,
		];
		if (this.items.length === 0) {
			lines.push("（空）");
			return lines.join("\n");
		}
		for (const item of this.items) {
			const preview = item.text.replace(/\s+/g, " ").slice(0, 40);
			const ageSec = Math.max(0, Math.floor((Date.now() - item.enqueuedAt) / 1000));
			lines.push(`- ${item.id} · ${item.source} · ${ageSec}s · ${preview}`);
		}
		lines.push("取消：取消 <id> 或 /lark cancel <id>；清空：清空队列");
		return lines.join("\n");
	}
}
