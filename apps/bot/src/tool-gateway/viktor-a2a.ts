import { type KeyObject, createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LLMError } from "@openviktor/shared";
import type { AgentGrant, AgentReceipt, AgentTask, AgentTaskGatewayDeps } from "./agent-task.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OWNER = /^owner:tg:([1-9][0-9]*)$/;
const FULL_AGENT_SKILL = "viktor.full_agent_task";
const READ_TOOLS = ["read_learnings"];

export function readViktorA2APublicKeyFile(path: string): KeyObject {
	if (!isAbsolute(path)) throw new Error("Viktor A2A verifier path must be absolute");
	const stat = lstatSync(path);
	if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
		|| (stat.mode & 0o022) !== 0 || stat.size > 4096) {
		throw new Error("Viktor A2A verifier permissions invalid");
	}
	const key = createPublicKey(readFileSync(path));
	if (key.asymmetricKeyType !== "ed25519") throw new Error("Viktor A2A verifier algorithm invalid");
	return key;
}

interface A2ADeps extends Omit<AgentTaskGatewayDeps, "lookupGrant"> {
	publicKey: KeyObject;
	audience: string;
	tenant: string;
	readBinding: () => Pick<AgentGrant, "workspaceId" | "principalId"> | null;
	readTaskDigest: (scope: Omit<AgentTask, "task">) => Promise<string | null>;
}

function decodeJson(encoded: string): Record<string, unknown> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
		return decoded as Record<string, unknown>;
	} catch {
		return null;
	}
}

function verifiedOwner(auth: string | null, deps: A2ADeps): string | null {
	if (!auth?.startsWith("Bearer ") || auth.length > 4096) return null;
	const parts = auth.slice(7).split(".");
	if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
	const [header, claims, signature] = parts;
	const parsedHeader = decodeJson(header);
	const payload = decodeJson(claims);
	if (!parsedHeader || Object.keys(parsedHeader).sort().join(",") !== "alg,typ"
		|| parsedHeader.alg !== "EdDSA" || parsedHeader.typ !== "JWT" || !payload
		|| Object.keys(payload).sort().join(",") !== "aud,exp,iat,iss,jti,scope,sub"
		|| payload.iss !== "twin" || payload.aud !== deps.audience
		|| payload.scope !== "twin:agent"
		|| typeof payload.sub !== "string" || !OWNER.test(payload.sub)
		|| typeof payload.jti !== "string" || payload.jti.length < 8 || payload.jti.length > 256
		|| typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat)
		|| typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) return null;
	const now = Math.floor(Date.now() / 1000);
	if (payload.iat > now + 30 || payload.exp <= now || payload.exp <= payload.iat
		|| payload.exp - payload.iat > 300) return null;
	const signed = Buffer.from(`${header}.${claims}`);
	try {
		return verify(null, signed, deps.publicKey, Buffer.from(signature, "base64url"))
			? payload.sub : null;
	} catch {
		return null;
	}
}

function context(tenant: string, ownerId: string): string {
	return createHash("sha256").update(`${tenant}\0${ownerId}`).digest("hex");
}

function taskId(contextId: string, requestId: string): string {
	return `${contextId}.${requestId}`;
}

function result(scope: Omit<AgentTask, "task">, tenant: string, ownerId: string,
	state: "working" | "completed" | "failed", receipt: AgentReceipt | null,
	failureReason?: string) {
	const contextId = context(tenant, ownerId);
	return {
		kind: "task", id: taskId(contextId, scope.requestId), contextId,
		status: { state, ...(state === "failed" && failureReason
			? { message: { kind: "message", role: "agent",
				messageId: `${scope.requestId}-failure`,
				parts: [{ kind: "text", text: failureReason }] } } : {}) },
		metadata: { "tvin.owner_scope": { tenant, ownerId } },
		...(state === "completed" && receipt?.responseText.trim()
			? { artifacts: [{ artifactId: receipt.agentRunId,
				parts: [{ kind: "text", text: receipt.responseText }] }] } : {}),
	};
}

function rpc(id: string | number, task: ReturnType<typeof result>): Response {
	return Response.json({ jsonrpc: "2.0", id, result: task });
}

function rpcError(id: string | number | null, code: number, message: string, status: number): Response {
	return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

export function createViktorA2AGateway(deps: A2ADeps): { fetch: (req: Request) => Promise<Response> } {
	if (new URL(deps.audience).protocol !== "https:" || !IDENTIFIER.test(deps.tenant)
		|| deps.publicKey.asymmetricKeyType !== "ed25519") {
		throw new Error("Viktor A2A configuration invalid");
	}
	return { fetch: async (req: Request): Promise<Response> => {
		if (req.method === "GET" && new URL(req.url).pathname === "/.well-known/agent-card.json") {
			return Response.json({
				protocolVersion: "0.3.0", name: "Viktor", url: deps.audience,
				description: "Owner-scoped full-agent task with read-only workspace access",
				version: "1.0.0", preferredTransport: "JSONRPC",
				capabilities: {}, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
				securitySchemes: { ownerJwt: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
				security: [{ ownerJwt: [] }],
				skills: [{ id: FULL_AGENT_SKILL, name: "Full agent task",
					description: "Run an owner task through Viktor's agent runner with read-only workspace access",
					tags: ["agent", "read-only"] }],
			});
		}
		if (req.method !== "POST" || new URL(req.url).pathname !== new URL(deps.audience).pathname) {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		const ownerId = verifiedOwner(req.headers.get("authorization"), deps);
		if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
		const match = OWNER.exec(ownerId);
		const binding = deps.readBinding();
		if (!match || !binding
			|| !IDENTIFIER.test(binding.workspaceId) || binding.principalId !== `tg-${match[1]}`) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}
		let payload: unknown;
		try {
			payload = await req.json();
		} catch {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return Response.json({ error: "Invalid RPC" }, { status: 400 });
		}
		const request = payload as Record<string, unknown>;
		const id = request.id;
		if (request.jsonrpc !== "2.0" || !((typeof id === "string" && id.length > 0 && id.length <= 128)
			|| (typeof id === "number" && Number.isSafeInteger(id)))
			|| !request.params || typeof request.params !== "object"
			|| Array.isArray(request.params)) {
			return rpcError(null, -32600, "Invalid RPC", 400);
		}
		const params = request.params as Record<string, unknown>;
		let requestId: string;
		let messageText: string | null = null;
		if (request.method === "message/send") {
			const message = params.message;
			if (!message || typeof message !== "object" || Array.isArray(message)) {
				return rpcError(id, -32602, "Invalid message", 400);
			}
			const input = message as Record<string, unknown>;
			const metadata = input.metadata as Record<string, unknown> | null;
			const scope = metadata?.["tvin.owner_scope"];
			const parts = input.parts;
			if (input.kind !== "message" || input.role !== "user"
				|| typeof input.messageId !== "string" || !IDENTIFIER.test(input.messageId)
				|| !Array.isArray(parts) || parts.length !== 1 || !parts[0]
				|| typeof parts[0] !== "object" || parts[0].kind !== "text"
				|| typeof parts[0].text !== "string" || !parts[0].text.trim()
				|| new TextEncoder().encode(parts[0].text).length > 8192
				|| !metadata || Object.keys(metadata).some((key) => key !== "tvin.owner_scope" && key !== "target")
				|| ("target" in metadata && metadata.target !== FULL_AGENT_SKILL)
				|| !scope || typeof scope !== "object" || Array.isArray(scope)
				|| (scope as Record<string, unknown>).ownerId !== ownerId
				|| (scope as Record<string, unknown>).tenant !== deps.tenant) {
				return rpcError(id, -32003, "Owner scope forbidden", 403);
			}
			requestId = input.messageId;
			messageText = parts[0].text;
		} else if (request.method === "tasks/get") {
			if (typeof params.id !== "string" || !params.id.startsWith(`${context(deps.tenant, ownerId)}.`)) {
				return rpcError(id, -32003, "Task owner forbidden", 403);
			}
			requestId = params.id.slice(context(deps.tenant, ownerId).length + 1);
			if (!IDENTIFIER.test(requestId)) return rpcError(id, -32602, "Invalid task id", 400);
		} else {
			return rpcError(id, -32601, "Unsupported method", 400);
		}
		const scoped = { workspaceId: binding.workspaceId, principalId: binding.principalId, requestId };
		if (messageText !== null) {
			try {
				if (await deps.reserve({ ...scoped, task: messageText })) {
					let timeout: ReturnType<typeof setTimeout> | undefined;
					try {
						const running = Promise.resolve().then(() => deps.run({ ...scoped,
							task: messageText, allowedTools: [...READ_TOOLS] })).then(
							(receipt) => ({ receipt, failureReason: undefined }),
							(error: unknown) => ({ receipt: null,
								failureReason: error instanceof LLMError ? error.message : undefined }),
						);
						const receipt = await Promise.race([running,
							new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 1000); })]);
						return rpc(id, result(scoped, deps.tenant, ownerId,
							receipt?.failureReason ? "failed" : receipt?.receipt ? "completed" : "working",
							receipt?.receipt ?? null, receipt?.failureReason));
					} finally {
						if (timeout) clearTimeout(timeout);
					}
				}
				const savedDigest = await deps.readTaskDigest(scoped);
				if (!savedDigest || savedDigest !== createHash("sha256").update(messageText).digest("hex")) {
					return rpcError(id, -32009, "Request identity conflict", 409);
				}
			} catch {
				return rpcError(id, -32000, "Reservation unavailable", 503);
			}
		}
		try {
			if (!await deps.readTaskDigest(scoped)) {
				return rpcError(id, -32004, "Unknown A2A task", 404);
			}
			const receipt = await deps.readReceipt(scoped);
			if (receipt) return rpc(id, result(scoped, deps.tenant, ownerId, "completed", receipt));
			const failureReason = await deps.readFailure?.(scoped);
			if (failureReason) {
				return rpc(id, result(scoped, deps.tenant, ownerId, "failed", null, failureReason));
			}
			const reservation = await deps.readReservation?.(scoped);
			if (!reservation) return rpcError(id, -32004, "Unknown task", 404);
			return rpc(id, result(scoped, deps.tenant, ownerId, "working", null));
		} catch {
			return rpcError(id, -32000, "Task unavailable", 503);
		}
	} };
}
