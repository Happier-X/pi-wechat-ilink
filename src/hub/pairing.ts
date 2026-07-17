/**
 * 飞书本人短码配对：内存会话，5 分钟 TTL，用后即废。
 */

export const DEFAULT_PAIR_TTL_MS = 5 * 60 * 1000;

/** 去掉易混字符 0OIl1 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_CODE_LEN = 6;

export type PairingSession = {
	code: string;
	expiresAt: number;
	createdByPiId?: string;
	createdAt: number;
};

export type BeginPairResult = {
	code: string;
	expiresAt: number;
	ttlMs: number;
};

export type ConsumePairResult =
	| { ok: true; openId: string; code: string }
	| { ok: false; reason: "no_session" | "expired" | "mismatch" | "no_open_id" };

export type PairingStoreOptions = {
	ttlMs?: number;
	codeLength?: number;
	now?: () => number;
	/** 测试可注入随机 */
	random?: () => number;
};

export function parsePairCommand(
	text: string,
): { code: string } | null {
	const t = (text ?? "").trim();
	const m = t.match(/^(配对|pair)\s+([A-Za-z0-9]{4,12})$/i);
	if (!m) return null;
	return { code: m[2]!.toUpperCase() };
}

export class PairingStore {
	private readonly ttlMs: number;
	private readonly codeLength: number;
	private readonly now: () => number;
	private readonly random: () => number;
	private session: PairingSession | null = null;

	constructor(options: PairingStoreOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_PAIR_TTL_MS;
		this.codeLength = options.codeLength ?? DEFAULT_CODE_LEN;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
	}

	begin(createdByPiId?: string): BeginPairResult {
		const code = this.generateCode();
		const createdAt = this.now();
		const expiresAt = createdAt + this.ttlMs;
		this.session = {
			code,
			expiresAt,
			createdByPiId: createdByPiId?.trim() || undefined,
			createdAt,
		};
		return { code, expiresAt, ttlMs: this.ttlMs };
	}

	peek(): PairingSession | null {
		this.dropIfExpired();
		return this.session;
	}

	/** 校验并消耗会话（成功或码匹配失败都可能清会话：仅成功/过期清除；错码保留防刷可选项——MVP 错码不废码） */
	consume(input: { code: string; openId?: string }): ConsumePairResult {
		const openId = input.openId?.trim();
		if (!openId) {
			return { ok: false, reason: "no_open_id" };
		}

		if (!this.session) {
			return { ok: false, reason: "no_session" };
		}

		// 先判过期再废会话，便于返回 expired（区别于从未 begin）
		if (this.now() > this.session.expiresAt) {
			this.session = null;
			return { ok: false, reason: "expired" };
		}

		const code = input.code.trim().toUpperCase();
		if (code !== this.session.code) {
			return { ok: false, reason: "mismatch" };
		}

		const matched = this.session.code;
		this.session = null;
		return { ok: true, openId, code: matched };
	}

	clear(): void {
		this.session = null;
	}

	private dropIfExpired(): void {
		if (this.session && this.now() > this.session.expiresAt) {
			this.session = null;
		}
	}

	private generateCode(): string {
		let out = "";
		for (let i = 0; i < this.codeLength; i++) {
			const idx = Math.floor(this.random() * CODE_ALPHABET.length);
			out += CODE_ALPHABET[idx]!;
		}
		return out;
	}
}
