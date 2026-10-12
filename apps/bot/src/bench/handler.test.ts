import { describe, expect, it, vi } from "vitest";
import { createBenchHandler } from "./handler.js";

function makeHandler() {
	const run = vi.fn().mockResolvedValue({
		agentRunId: "run-1",
		threadId: "thread-1",
		responseText: "Done",
		messageSent: false,
		inputTokens: 10,
		outputTokens: 4,
		costCents: 0.1,
		durationMs: 250,
	});
	const getToolCalls = vi
		.fn()
		.mockResolvedValue([{ toolName: "calculator", status: "COMPLETED", durationMs: 12 }]);
	const getAvailableTools = vi.fn().mockReturnValue(["calculator"]);
	const handler = createBenchHandler({
		token: "a".repeat(64),
		workspaceId: "workspace-1",
		workspaceName: "Test",
		runner: { run } as never,
		getContext: async () => ({
			skillCatalog: [],
			integrationCatalog: [],
			activeThreads: [],
		}),
		getToolCalls,
		getAvailableTools,
	});
	return { handler, run, getToolCalls, getAvailableTools };
}

function request(body: unknown, token = "a".repeat(64)): Request {
	return new Request("http://localhost/bench/message", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("bench message transport", () => {
	it("rejects unauthenticated requests before invoking the agent", async () => {
		const { handler, run } = makeHandler();
		const response = await handler(request({ thread_id: "case-1", text: "Hello" }, "wrong"));
		expect(response.status).toBe(401);
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects malformed thread identifiers", async () => {
		const { handler, run } = makeHandler();
		const response = await handler(request({ thread_id: "../other", text: "Hello" }));
		expect(response.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
	});

	it("uses the agent runner and returns measured metadata", async () => {
		const { handler, run } = makeHandler();
		const response = await handler(request({ thread_id: "case-1", text: "Hello" }));
		expect(response.status).toBe(200);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-1",
				slackChannel: "__bench__",
				slackThreadTs: "case-1",
				userMessage: "Hello",
			}),
		);
		expect(await response.json()).toMatchObject({
			status: "ok",
			response_text: "Done",
			available_tools: ["calculator"],
			input_tokens: 10,
			output_tokens: 4,
			tool_calls: [{ name: "calculator", status: "COMPLETED" }],
		});
	});

	it("captures the tool inventory for each request instead of a stale startup snapshot", async () => {
		const { handler, getAvailableTools } = makeHandler();
		getAvailableTools
			.mockReturnValueOnce(["calculator"])
			.mockReturnValueOnce(["calculator", "search"]);
		const first = await handler(request({ thread_id: "first", text: "Hello" }));
		const second = await handler(request({ thread_id: "second", text: "Hello" }));
		expect(((await first.json()) as { available_tools: string[] }).available_tools).toEqual([
			"calculator",
		]);
		expect(((await second.json()) as { available_tools: string[] }).available_tools).toEqual([
			"calculator",
			"search",
		]);
	});

	it("reports an empty agent answer as failure without changing the agent run", async () => {
		const { handler, run } = makeHandler();
		run.mockResolvedValueOnce({
			agentRunId: "run-empty",
			threadId: "thread-empty",
			responseText: " \n ",
			messageSent: false,
			inputTokens: 39408,
			outputTokens: 6406,
			costCents: 23.3893,
			durationMs: 41469,
		});
		const response = await handler(
			request({ thread_id: "case-empty", text: "Make a spreadsheet" }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "no_answer",
			response_text: " \n ",
			message_sent: false,
			agent_run_id: "run-empty",
			input_tokens: 39408,
			output_tokens: 6406,
		});
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("returns the message captured by the bench transport", async () => {
		const { handler, getToolCalls } = makeHandler();
		getToolCalls.mockResolvedValue([
			{
				toolName: "coworker_send_slack_message",
				status: "COMPLETED",
				durationMs: 0,
				output: {
					status: "sent",
					channel_id: "__bench__",
					text: "Hello from tool",
					blocks: [{ type: "section", text: { type: "mrkdwn", text: "Hello from tool" } }],
				},
			},
		]);
		const response = await handler(request({ thread_id: "case-2", text: "Hello" }));
		const body = (await response.json()) as { response_text: string; outgoing_messages: unknown[] };
		expect(body.response_text).toBe("Hello from tool");
		expect(body.outgoing_messages).toHaveLength(1);
	});
});
