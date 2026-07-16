declare module "qrcode-terminal" {
	interface GenerateOptions {
		small?: boolean;
	}

	function generate(
		input: string,
		opts?: GenerateOptions,
		callback?: (qr: string) => void,
	): void;

	export default {
		generate,
	};
}
