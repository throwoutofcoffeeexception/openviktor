import { randomBytes } from "node:crypto";
import { ToolGatewayClient } from "@openviktor/tools";
import type { LLMToolDefinition } from "@openviktor/shared";
import type { ToolConfig } from "../agent/runner.js";
import { registerWorkspaceToken, revokeWorkspaceToken } from "./server.js";

export function createScopedToolAccess(workspaceId: string, port: number, timeoutMs: number,
	tools: LLMToolDefinition[], allowedRoles: readonly string[] = tools.map((tool) => tool.name)):
	{ token: string; config: ToolConfig; dispose: () => void } {
	const token = randomBytes(32).toString("hex");
	registerWorkspaceToken(token, workspaceId, allowedRoles, Date.now() + 1_200_000);
	return { token,
		config: { client: new ToolGatewayClient({ baseUrl: `http://localhost:${port}`,
			token, timeoutMs }), tools },
		dispose: () => revokeWorkspaceToken(token) };
}
