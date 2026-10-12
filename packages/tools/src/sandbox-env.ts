/**
 * Builds a minimal, safe environment for sandboxed child processes.
 *
 * SECURITY: Never spread `process.env` into child processes — it leaks
 * secrets (API keys, DB credentials) that can end up in tool output,
 * persisted to the database, and sent to LLM providers.
 */
export function buildSandboxEnv(workspaceDir: string, gatewayToken?: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: workspaceDir,
		USER: process.env.USER,
		LANG: process.env.LANG ?? "en_US.UTF-8",
		LC_ALL: process.env.LC_ALL,
		TERM: process.env.TERM ?? "xterm-256color",
		TMPDIR: process.env.TMPDIR,
		TZ: process.env.TZ,
		TOOL_GATEWAY_URL:
			process.env.TOOL_GATEWAY_URL ?? `http://localhost:${process.env.TOOL_GATEWAY_PORT ?? "3001"}`,
		TOOL_TOKEN: gatewayToken,
	};
}
