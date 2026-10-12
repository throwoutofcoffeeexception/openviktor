import { describe, expect, it, vi } from "vitest";
import { createAgentTaskGateway } from "./agent-task.js";

const grant = { workspaceId: "workspace-a", principalId: "tg-123", expiresAt: Date.now() + 60_000 };
const payload = { workspaceId: "workspace-a", principalId: "tg-123", requestId: "route-100", task: "Summarize learnings" };

function setup() {
	const reserved = new Set<string>();
	const run = vi.fn().mockResolvedValue({ agentRunId: "run-42", responseText: "Two learnings", toolReceipt: [] });
	const gateway = createAgentTaskGateway({
		lookupGrant: (token) => token === "scoped-secret" ? grant : null,
		reserve: async (scope) => {
			const key = `${scope.workspaceId}:${scope.principalId}:${scope.requestId}`;
			if (reserved.has(key)) return false;
			reserved.add(key);
			return true;
		},
		run,
		readReceipt: async () => ({ agentRunId: "run-42", responseText: "Two learnings", toolReceipt: [] }),
	});
	const request = (body: unknown, token = "scoped-secret") => new Request("http://localhost/v1/agent/run", {
		method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { gateway, request, run };
}

describe("owner-scoped Viktor agent task", () => {
	it("rejects foreign principal and tenant before any model run", async () => {
		const { gateway, request, run } = setup();
		expect((await gateway.fetch(request({ ...payload, principalId: "tg-456" }))).status).toBe(403);
		expect((await gateway.fetch(request({ ...payload, workspaceId: "workspace-b" }))).status).toBe(403);
		expect((await gateway.fetch(request(payload, "invalid"))).status).toBe(403);
		expect(run).not.toHaveBeenCalled();
	});

	it("runs the full agent only with a fixed read-only capability set and returns an unverified receipt", async () => {
		const { gateway, request, run } = setup();
		const response = await gateway.fetch(request(payload));
		expect(response.status).toBe(200);
		expect(run).toHaveBeenCalledWith({ ...payload, allowedTools: ["read_learnings"] });
		expect(await response.json()).toEqual({ requestId: "route-100", agentRunId: "run-42",
			responseText: "Two learnings", toolReceipt: [], ownerDelivery: "not_verified" });
	});

	it("reserves a request before execution and cannot rerun on unknown outcome", async () => {
		const { gateway, request, run } = setup();
		expect((await gateway.fetch(request(payload))).status).toBe(200);
		expect((await gateway.fetch(request(payload))).status).toBe(409);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reconciles a completed request without launching another run", async () => {
		const { gateway, request, run } = setup();
		expect((await gateway.fetch(request(payload))).status).toBe(200);
		const receipt = await gateway.fetch(new Request(
			"http://localhost/v1/agent/run?requestId=route-100&workspaceId=workspace-a&principalId=tg-123",
			{ headers: { authorization: "Bearer scoped-secret" } },
		));
		expect(receipt.status).toBe(200);
		expect(await receipt.json()).toMatchObject({ requestId: "route-100", ownerDelivery: "not_verified" });
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("reports a reserved request without a receipt instead of losing it as unknown", async () => {
		const gateway = createAgentTaskGateway({
			lookupGrant: () => grant,
			reserve: async () => false,
			run: vi.fn(),
			readReceipt: async () => null,
			readReservation: async () => "unknown",
		});
		const response = await gateway.fetch(new Request(
			"http://localhost/v1/agent/run?requestId=route-100&workspaceId=workspace-a&principalId=tg-123",
			{ headers: { authorization: "Bearer scoped-secret" } },
		));
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ requestId: "route-100", state: "unknown_outcome" });
	});
	it("reports a recent reservation as pending without running twice", async () => {
		const run = vi.fn();
		const gateway = createAgentTaskGateway({
			lookupGrant: () => grant, reserve: async () => false, run,
			readReceipt: async () => null, readReservation: async () => "pending",
		});
		const response = await gateway.fetch(new Request(
			"http://localhost/v1/agent/run?requestId=route-100&workspaceId=workspace-a&principalId=tg-123",
			{ headers: { authorization: "Bearer scoped-secret" } },
		));
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ requestId: "route-100", state: "pending" });
		expect(run).not.toHaveBeenCalled();
	});
});
