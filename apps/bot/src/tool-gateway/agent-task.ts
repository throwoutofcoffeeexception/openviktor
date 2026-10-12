export interface AgentGrant {
	workspaceId: string;
	principalId: string;
	expiresAt: number;
}

export interface AgentTask {
	workspaceId: string;
	principalId: string;
	requestId: string;
	task: string;
}

export interface AgentReceipt {
	agentRunId: string;
	responseText: string;
	toolReceipt: Array<{ name: string; outcome: string }>;
}

export interface AgentTaskGatewayDeps {
	lookupGrant: (token: string) => AgentGrant | null;
	reserve: (scope: AgentTask) => Promise<boolean>;
	run: (task: AgentTask & { allowedTools: string[] }) => Promise<AgentReceipt>;
	readReceipt: (scope: Omit<AgentTask, "task">) => Promise<AgentReceipt | null>;
	readFailure?: (scope: Omit<AgentTask, "task">) => Promise<string | null>;
	readReservation?: (scope: Omit<AgentTask, "task">) => Promise<"pending" | "unknown" | null>;
}

const ALLOWED_TOOLS = ["read_learnings"];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function createAgentTaskGateway(deps: AgentTaskGatewayDeps): { fetch: (req: Request) => Promise<Response> } {
	return {
		fetch: async (req: Request): Promise<Response> => {
			const url = new URL(req.url);
			if (url.pathname !== "/v1/agent/run" || !["POST", "GET"].includes(req.method)) {
				return Response.json({ error: "Not found" }, { status: 404 });
			}
			const auth = req.headers.get("authorization");
			if (!auth?.startsWith("Bearer ")) {
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			}
			const grant = deps.lookupGrant(auth.slice(7));
			if (!grant || grant.expiresAt <= Date.now()) {
				return Response.json({ error: "Forbidden" }, { status: 403 });
			}
			if (req.method === "GET") {
				const requestId = url.searchParams.get("requestId");
				if (url.searchParams.size !== 3 || !requestId || !IDENTIFIER.test(requestId)) {
					return Response.json({ error: "Invalid request" }, { status: 400 });
				}
				if (url.searchParams.get("workspaceId") !== grant.workspaceId
					|| url.searchParams.get("principalId") !== grant.principalId) {
					return Response.json({ error: "Forbidden" }, { status: 403 });
				}
				const scope = { workspaceId: grant.workspaceId, principalId: grant.principalId, requestId };
				const receipt = await deps.readReceipt(scope);
				if (!receipt) {
					const state = await deps.readReservation?.(scope);
					if (state === "pending") return Response.json({ requestId, state }, { status: 202 });
					if (state === "unknown") return Response.json({ requestId, state: "unknown_outcome",
						resolution: "Manual owner reconciliation required before submitting a new requestId" }, { status: 409 });
					return Response.json({ error: "Unknown request" }, { status: 404 });
				}
				return Response.json({ requestId, ...receipt, ownerDelivery: "not_verified" });
			}
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return Response.json({ error: "Invalid JSON" }, { status: 400 });
			}
			if (!body || typeof body !== "object" || Array.isArray(body)
				|| Object.keys(body).sort().join(",") !== "principalId,requestId,task,workspaceId") {
				return Response.json({ error: "Invalid task" }, { status: 400 });
			}
			const task = body as Record<string, unknown>;
			if (typeof task.workspaceId !== "string" || typeof task.principalId !== "string"
				|| typeof task.requestId !== "string" || !IDENTIFIER.test(task.requestId)
				|| typeof task.task !== "string" || !task.task.trim()
				|| new TextEncoder().encode(task.task).length > 2000) {
				return Response.json({ error: "Invalid task" }, { status: 400 });
			}
			if (task.workspaceId !== grant.workspaceId || task.principalId !== grant.principalId) {
				return Response.json({ error: "Forbidden" }, { status: 403 });
			}
			const scopedTask = task as unknown as AgentTask;
			if (!await deps.reserve(scopedTask)) {
				return Response.json({ error: "Request already reserved; reconcile before retry" }, { status: 409 });
			}
			try {
				const receipt = await deps.run({ ...scopedTask, allowedTools: [...ALLOWED_TOOLS] });
				return Response.json({ requestId: scopedTask.requestId, ...receipt,
					ownerDelivery: "not_verified" });
			} catch {
				return Response.json({ error: "Unknown outcome; reconcile before retry" }, { status: 503 });
			}
		},
	};
}
