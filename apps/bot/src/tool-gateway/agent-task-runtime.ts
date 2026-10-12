import { createHash } from "node:crypto";
import type { PrismaClient } from "@openviktor/db";
import type { AgentRunner } from "../agent/runner.js";
import type { ToolConfig } from "../agent/runner.js";
import type { AgentReceipt, AgentTask } from "./agent-task.js";

const CHANNEL = "__twin_owner__";
const READ_TOOLS = ["read_learnings"];
const UNCERTAIN_AFTER_MS = 20 * 60 * 1000;

function threadKey(scope: Omit<AgentTask, "task">): string {
	return createHash("sha256").update(`${scope.principalId}:${scope.requestId}`).digest("hex");
}

export function createAgentTaskRuntime(
	prisma: PrismaClient,
	runner: AgentRunner,
	createAccess: (workspaceId: string) => { config: ToolConfig; dispose: () => void },
) {
	async function reserved(scope: Omit<AgentTask, "task">) {
		const thread = await prisma.thread.findUnique({
			where: {
				workspaceId_slackChannel_slackThreadTs: {
					workspaceId: scope.workspaceId,
					slackChannel: CHANNEL,
					slackThreadTs: threadKey(scope),
				},
			},
		});
		if (
			!thread ||
			!thread.metadata ||
			typeof thread.metadata !== "object" ||
			Array.isArray(thread.metadata) ||
			(thread.metadata as Record<string, unknown>).principalId !== scope.principalId ||
			(thread.metadata as Record<string, unknown>).requestId !== scope.requestId
		)
			return null;
		return thread;
	}
	async function readReceipt(scope: Omit<AgentTask, "task">): Promise<AgentReceipt | null> {
		const thread = await reserved(scope);
		if (!thread) return null;
		const result = await prisma.agentRun.findFirst({
			where: { workspaceId: scope.workspaceId, threadId: thread.id, status: "COMPLETED" },
			orderBy: { createdAt: "desc" },
			include: {
				messages: { where: { role: "assistant" }, orderBy: { createdAt: "desc" }, take: 1 },
				toolCalls: { select: { toolName: true, status: true } },
			},
		});
		if (!result?.messages[0]?.content?.trim()) return null;
		return {
			agentRunId: result.id,
			responseText: result.messages[0].content,
			toolReceipt: result.toolCalls.map((call: { toolName: string; status: string }) => ({
				name: call.toolName,
				outcome: call.status,
			})),
		};
	}
	async function readFailure(scope: Omit<AgentTask, "task">): Promise<string | null> {
		const thread = await reserved(scope);
		if (!thread) return null;
		const result = await prisma.agentRun.findFirst({
			where: { workspaceId: scope.workspaceId, threadId: thread.id, status: "FAILED" },
			orderBy: { createdAt: "desc" },
			select: { errorMessage: true },
		});
		return result ? result.errorMessage?.trim() || "Agent execution failed" : null;
	}

	return {
		readTaskDigest: async (scope: Omit<AgentTask, "task">): Promise<string | null> => {
			const thread = await reserved(scope);
			const digest = (thread?.metadata as Record<string, unknown> | null)?.taskDigest;
			return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
		},
		readReservation: async (
			scope: Omit<AgentTask, "task">,
		): Promise<"pending" | "unknown" | null> => {
			const thread = await reserved(scope);
			if (!thread) return null;
			return Date.now() - thread.createdAt.getTime() >= UNCERTAIN_AFTER_MS ? "unknown" : "pending";
		},
		reserve: async (scope: AgentTask): Promise<boolean> => {
			try {
				await prisma.thread.create({
					data: {
						workspaceId: scope.workspaceId,
						slackChannel: CHANNEL,
						slackThreadTs: threadKey(scope),
						metadata: {
							principalId: scope.principalId,
							requestId: scope.requestId,
							taskDigest: createHash("sha256").update(scope.task).digest("hex"),
						},
					},
				});
				return true;
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "P2002"
				)
					return false;
				throw error;
			}
		},
		run: async (scope: AgentTask & { allowedTools: string[] }): Promise<AgentReceipt> => {
			if (!(await reserved(scope))) throw new Error("No reserved owner scope");
			const workspace = await prisma.workspace.findUnique({ where: { id: scope.workspaceId } });
			if (!workspace?.isActive) throw new Error("Workspace unavailable");
			const access = createAccess(scope.workspaceId);
			let result: Awaited<ReturnType<AgentRunner["run"]>>;
			try {
				result = await runner.run(
					{
						workspaceId: scope.workspaceId,
						memberId: null,
						triggerType: "MANUAL",
						slackChannel: CHANNEL,
						slackThreadTs: threadKey(scope),
						userMessage: scope.task,
						allowedTools: READ_TOOLS,
						promptContext: {
							workspaceName: workspace.slackTeamName,
							channel: CHANNEL,
							triggerType: "MANUAL",
							a2aTask: true,
						},
					},
					undefined,
					access.config,
				);
			} finally {
				access.dispose();
			}
			const receipt = await readReceipt(scope);
			if (!receipt || receipt.agentRunId !== result.agentRunId) {
				throw new Error("Agent run has no completed durable receipt");
			}
			return receipt;
		},
		readReceipt,
		readFailure,
	};
}
