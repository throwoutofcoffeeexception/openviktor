import { timingSafeEqual } from "node:crypto";
import type { ActiveThreadInfo } from "../agent/prompt.js";
import type { AgentRunner } from "../agent/runner.js";

interface BenchDeps {
	token: string;
	workspaceId: string;
	workspaceName: string;
	runner: Pick<AgentRunner, "run">;
	getContext: () => Promise<{
		skillCatalog: string[];
		integrationCatalog: string[];
		activeThreads: ActiveThreadInfo[];
	}>;
	getToolCalls: (
		agentRunId: string,
	) => Promise<
		Array<{ toolName: string; status: string; durationMs: number | null; output?: unknown }>
	>;
	getAvailableTools: () => string[];
}

function authorized(header: string | null, token: string): boolean {
	if (!header?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice(7));
	const expected = Buffer.from(token);
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseMessage(body: unknown): { threadId: string; text: string } | null {
	if (!body || typeof body !== "object") return null;
	const { thread_id: threadId, text } = body as Record<string, unknown>;
	if (typeof threadId !== "string" || !/^[-A-Za-z0-9_.]{1,128}$/.test(threadId)) return null;
	if (typeof text !== "string" || text.trim().length === 0 || text.length > 16000) return null;
	return { threadId, text };
}

function errorStatus(error: unknown): 409 | 429 | 500 {
	const candidate = error as { statusCode?: unknown } | null;
	return candidate?.statusCode === 409 || candidate?.statusCode === 429
		? candidate.statusCode
		: 500;
}

function outgoingMessages(
	toolCalls: Array<{ toolName: string; status: string; output?: unknown }>,
) {
	return toolCalls
		.filter(
			(call) => call.toolName === "coworker_send_slack_message" && call.status === "COMPLETED",
		)
		.map((call) => call.output)
		.filter((output): output is Record<string, unknown> => !!output && typeof output === "object")
		.filter((output) => output.channel_id === "__bench__" && output.status === "sent")
		.map((output) => ({
			text: typeof output.text === "string" ? output.text : "",
			blocks: Array.isArray(output.blocks) ? output.blocks : [],
			ts: typeof output.ts === "string" ? output.ts : "",
		}));
}

export function createBenchHandler(deps: BenchDeps): (req: Request) => Promise<Response> {
	return async (req) => {
		if (req.method !== "POST")
			return Response.json({ error: "method_not_allowed" }, { status: 405 });
		if (!authorized(req.headers.get("authorization"), deps.token)) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}

		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return Response.json({ error: "invalid_json" }, { status: 400 });
		}
		const message = parseMessage(body);
		if (!message) {
			return Response.json({ error: "invalid_request" }, { status: 400 });
		}
		const { threadId, text } = message;

		try {
			const context = await deps.getContext();
			const availableTools = deps.getAvailableTools();
			const result = await deps.runner.run({
				workspaceId: deps.workspaceId,
				memberId: null,
				triggerType: "DM",
				slackChannel: "__bench__",
				slackThreadTs: threadId,
				userMessage: text,
				promptContext: {
					workspaceName: deps.workspaceName,
					channel: "__bench__",
					slackThreadTs: threadId,
					triggerType: "DM",
					...context,
				},
			});
			const toolCalls = await deps.getToolCalls(result.agentRunId);
			const messages = outgoingMessages(toolCalls);
			const responseText =
				messages.length > 0 ? messages.map((item) => item.text).join("\n") : result.responseText;
			return Response.json({
				status: responseText.trim() ? "ok" : "no_answer",
				thread_id: threadId,
				response_text: responseText,
				outgoing_messages: messages,
				message_sent: result.messageSent,
				agent_run_id: result.agentRunId,
				duration_ms: result.durationMs,
				input_tokens: result.inputTokens,
				output_tokens: result.outputTokens,
				cost_cents: result.costCents,
				available_tools: availableTools,
				tool_calls: toolCalls.map((call) => ({
					name: call.toolName,
					status: call.status,
					duration_ms: call.durationMs,
				})),
			});
		} catch (error) {
			return Response.json({ error: "agent_error" }, { status: errorStatus(error) });
		}
	};
}
