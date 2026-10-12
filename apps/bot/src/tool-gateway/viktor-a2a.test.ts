import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMError } from "@openviktor/shared";
import { describe, expect, it, vi } from "vitest";
import { createViktorA2AGateway, readViktorA2APublicKeyFile } from "./viktor-a2a.js";

const keys = generateKeyPairSync("ed25519");
const audience = "https://viktor.example.test/a2a";
const owner = "owner:tg:123";
const binding = { workspaceId: "guest-workspace-37", principalId: "tg-123" };

function bearer(sub = owner, aud = audience, expiry = Math.floor(Date.now() / 1000) + 240) {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const signed = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ iss: "twin", sub, aud,
		 iat: now, exp: expiry, jti: "one-time-id", scope: "twin:agent" })}`;
	return `${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`;
}

function setup(reservationState: "pending" | "unknown" = "pending") {
	let savedDigest: string | null = null;
	const reserve = vi.fn().mockImplementation(async (task: { task: string }) => {
		if (savedDigest) return false;
		savedDigest = createHash("sha256").update(task.task).digest("hex");
		return true;
	});
	const run = vi.fn().mockResolvedValue({ agentRunId: "run-1", responseText: "Learnings", toolReceipt: [] });
	const readReceipt = vi.fn().mockResolvedValue(null);
	const readFailure = vi.fn().mockResolvedValue(null);
	const deps = { publicKey: keys.publicKey, audience,
		tenant: "workspace-a", readBinding: () => binding, reserve, run, readReceipt,
		readTaskDigest: async () => savedDigest,
		readReservation: async () => reservationState, readFailure };
	const gateway = createViktorA2AGateway(deps);
	const request = (token = bearer(), text = "Summarize learnings", method = "message/send", id: string | number = "req-1", messageId = "req-1") =>
		new Request(audience, { method: "POST", headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "tasks/get"
				? { id: text }
				: { message: { kind: "message", role: "user", messageId,
					parts: [{ kind: "text", text }], metadata: {
						"tvin.owner_scope": { tenant: "workspace-a", ownerId: owner },
					} } } }) });
	return { gateway, request, run, reserve, readReceipt, readFailure };
}

describe("Viktor owner-scoped A2A endpoint", () => {
	it("accepts the full-agent target but rejects a foreign target", async () => {
		const { gateway, request, run } = setup();
		const original = await request().json() as { params: { message: { metadata: Record<string, unknown> } } };
		original.params.message.metadata.target = "viktor.full_agent_task";
		const targeted = new Request(audience, { method: "POST", headers: { authorization: `Bearer ${bearer()}` },
			body: JSON.stringify(original) });
		expect((await gateway.fetch(targeted)).status).toBe(200);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith(expect.objectContaining({
			task: "Summarize learnings", allowedTools: ["read_learnings"],
		}));
		original.params.message.metadata.target = "viktor.execute_external_tool";
		const foreign = new Request(audience, { method: "POST", headers: { authorization: `Bearer ${bearer()}` },
			body: JSON.stringify(original) });
		expect((await gateway.fetch(foreign)).status).toBe(403);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("serves a public v0.3 AgentCard advertising scoped bearer JWT and the exact URL", async () => {
		const { gateway } = setup();
		const cardResponse = await gateway.fetch(new Request("https://viktor.example.test/.well-known/agent-card.json"));
		expect(cardResponse.status).toBe(200);
		expect(await cardResponse.json()).toMatchObject({ protocolVersion: "0.3.0", name: "Viktor",
			url: audience, preferredTransport: "JSONRPC",
			securitySchemes: { ownerJwt: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
			security: [{ ownerJwt: [] }], skills: [{ id: "viktor.full_agent_task" }] });
	});
	it("rejects verifier key symlinks and writable public keys", () => {
		const directory = mkdtempSync(join(tmpdir(), "viktor-a2a-"));
		try {
			const key = join(directory, "key.pem");
			writeFileSync(key, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
			expect(readViktorA2APublicKeyFile(key).asymmetricKeyType).toBe("ed25519");
			const alias = join(directory, "alias.pem");
			symlinkSync(key, alias);
			expect(() => readViktorA2APublicKeyFile(alias)).toThrow();
			chmodSync(key, 0o666);
			expect(() => readViktorA2APublicKeyFile(key)).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("refuses anonymous, forged JWT, expired JWT and foreign owner before reserving", async () => {
		const { gateway, request, reserve } = setup();
		const anonymous = new Request(audience, { method: "POST", body: "{}" });
		expect((await gateway.fetch(anonymous)).status).toBe(401);
		expect((await gateway.fetch(request(bearer("owner:tg:456")))).status).toBe(403);
		expect((await gateway.fetch(request(bearer(owner, "https://wrong.example.test/a2a")))).status).toBe(401);
		expect((await gateway.fetch(request(bearer(owner, audience, 0)))).status).toBe(401);
		expect((await gateway.fetch(request(`${bearer()}forged`))).status).toBe(401);
		expect(reserve).not.toHaveBeenCalled();
	});

	it("refuses a forged owner scope despite a valid JWT", async () => {
		const { gateway, request, reserve } = setup();
		const original = request();
		const body = await original.json() as { params: { message: { metadata: {
			"tvin.owner_scope": { ownerId: string } } } } };
		body.params.message.metadata["tvin.owner_scope"].ownerId = "owner:tg:456";
		expect((await gateway.fetch(new Request(audience, { method: "POST",
			headers: original.headers, body: JSON.stringify(body) }))).status).toBe(403);
		expect(reserve).not.toHaveBeenCalled();
	});

	it("returns terminal Task with artifact, and never executes duplicate messageId", async () => {
		const { gateway, request, run, reserve } = setup();
		const first = await gateway.fetch(request());
		expect(first.status).toBe(200);
		const task = (await first.json() as { result: { id: string } }).result;
		expect(task).toMatchObject({ kind: "task", status: { state: "completed" },
			metadata: { "tvin.owner_scope": { tenant: "workspace-a", ownerId: owner } },
			artifacts: [{ parts: [{ kind: "text", text: "Learnings" }] }] });
		expect((await gateway.fetch(request(bearer(), task.id, "tasks/get"))).status).toBe(200);
		expect((await gateway.fetch(request())).status).toBe(200);
		expect(run).toHaveBeenCalledTimes(1);
		expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "guest-workspace-37",
			principalId: "tg-123" }));
	});
	it("accepts the V5 UTF-8 question while rejecting oversized tasks", async () => {
		const { gateway, request, reserve } = setup();
		expect((await gateway.fetch(request(bearer(), "Д".repeat(1200)))).status).toBe(200);
		expect((await gateway.fetch(request(bearer(), "Д".repeat(4100)))).status).toBe(403);
		expect(reserve).toHaveBeenCalledTimes(1);
	});
	it("returns a working Task promptly while a long owner request finishes", async () => {
		vi.useFakeTimers();
		try {
			const { gateway, request, run, readReceipt } = setup();
			let finish!: (receipt: { agentRunId: string; responseText: string; toolReceipt: never[] }) => void;
			run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
			const pending = gateway.fetch(request());
			await vi.advanceTimersByTimeAsync(1500);
			const response = await pending;
			expect((await response.json() as { result: { status: { state: string } } }).result.status.state).toBe("working");
			finish({ agentRunId: "run-1", responseText: "Learnings", toolReceipt: [] });
			readReceipt.mockResolvedValue({ agentRunId: "run-1", responseText: "Learnings", toolReceipt: [] });
			const completed = await gateway.fetch(request(bearer(),
				`${createHash("sha256").update(`workspace-a\0${owner}`).digest("hex")}.req-1`, "tasks/get"));
			expect((await completed.json() as { result: { status: { state: string } } }).result.status.state).toBe("completed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects the same request ID with different text without replaying the model", async () => {
		const { gateway, request, run } = setup();
		expect((await gateway.fetch(request())).status).toBe(200);
		const conflict = await gateway.fetch(request(bearer(), "Replace prior task"));
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ jsonrpc: "2.0", id: "req-1",
			error: { code: -32009, message: expect.any(String) } });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("accepts an independent numeric JSON-RPC id and stable messageId", async () => {
		const { gateway, request, run } = setup();
		const first = await gateway.fetch(request(bearer(), "Summarize learnings", "message/send", 42));
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ jsonrpc: "2.0", id: 42,
			result: { id: expect.stringContaining("req-1"), status: { state: "completed" } } });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("does not turn an uncertain still-running task into a terminal failure", async () => {
		const { gateway, request, run } = setup("unknown");
		run.mockRejectedValueOnce(new Error("transport timeout"));
		const first = (await gateway.fetch(request())).json() as Promise<{ result: { id: string } }>;
		const taskId = (await first).result.id;
		const response = await gateway.fetch(request(bearer(), taskId, "tasks/get"));
		expect((await response.json() as { result: { status: { state: string } } }).result.status.state).toBe("working");
	});

	it("returns a failed Task with the provider reason when the agent run rejects", async () => {
		const { gateway, request, run } = setup();
		run.mockRejectedValueOnce(new LLMError("Provider rejected model: quota exceeded"));
		const response = await gateway.fetch(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: {
				status: {
					state: "failed",
					message: {
						kind: "message",
						role: "agent",
						parts: [{ kind: "text", text: "Provider rejected model: quota exceeded" }],
					},
				},
			},
		});
	});

	it("returns a durable failed Task when polling a provider-rejected run", async () => {
		vi.useFakeTimers();
		try {
			const { gateway, request, run, readFailure } = setup();
			run.mockImplementationOnce(() => new Promise(() => undefined));
			const pending = gateway.fetch(request());
			await vi.advanceTimersByTimeAsync(1500);
			const working = await pending;
			const task = (await working.json() as { result: { id: string } }).result;
			readFailure.mockResolvedValue("Provider rejected model: quota exceeded");
			const polled = await gateway.fetch(request(bearer(), task.id, "tasks/get"));
			expect(await polled.json()).toMatchObject({ result: { status: {
				state: "failed",
				message: { parts: [{ kind: "text", text: "Provider rejected model: quota exceeded" }] },
			} } });
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a task pending after unknown outcome instead of re-running", async () => {
		const { gateway, request, run } = setup();
		run.mockRejectedValueOnce(new Error("transport timeout"));
		const first = (await (await gateway.fetch(request())).json() as { result: { status: { state: string } } }).result;
		expect(first.status.state).toBe("working");
		expect((await (await gateway.fetch(request())).json() as { result: { status: { state: string } } }).result.status.state).toBe("working");
		expect(run).toHaveBeenCalledTimes(1);
	});
});
