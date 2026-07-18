/**
 * 配对二维码辅助：载荷为「配对 <码>」写 PNG，并尽力用系统打开。
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";

export function defaultPairQrPath(home = os.homedir()): string {
	return path.join(home, ".pi", "lark-hub", "pair-qr.png");
}

/** 二维码文本载荷：与飞书口令一致 */
export function pairQrPayload(code: string): string {
	return `配对 ${code.trim().toUpperCase()}`;
}

export type WritePairQrResult =
	| { ok: true; path: string; payload: string }
	| { ok: false; error: string; path: string; payload: string };

export type WritePairQrOptions = {
	outPath?: string;
	/** 注入 QR 写入（测试） */
	toFile?: (
		filePath: string,
		text: string,
		opts?: { width?: number; margin?: number },
	) => Promise<void>;
};

export async function writePairQrPng(
	code: string,
	options: WritePairQrOptions = {},
): Promise<WritePairQrResult> {
	const payload = pairQrPayload(code);
	const outPath = options.outPath ?? defaultPairQrPath();
	const toFile =
		options.toFile ??
		((filePath: string, text: string, opts?: { width?: number; margin?: number }) =>
			QRCode.toFile(filePath, text, {
				type: "png",
				width: opts?.width ?? 320,
				margin: opts?.margin ?? 2,
			}));

	try {
		mkdirSync(path.dirname(outPath), { recursive: true });
		await toFile(outPath, payload, { width: 320, margin: 2 });
		return { ok: true, path: outPath, payload };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message, path: outPath, payload };
	}
}

export type OpenPathOptions = {
	platform?: NodeJS.Platform;
	spawnFn?: typeof spawn;
};

/** 尽力打开本地文件；错误吞掉 */
export function openPathBestEffort(
	filePath: string,
	options: OpenPathOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	const spawnFn = options.spawnFn ?? spawn;
	try {
		if (platform === "win32") {
			spawnFn("cmd", ["/c", "start", "", filePath], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			}).unref();
			return;
		}
		if (platform === "darwin") {
			spawnFn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
			return;
		}
		spawnFn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// ignore
	}
}
