import { readFileSync, lstatSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AgentGrant } from "./agent-task.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function loadGrant(path: string): { secret: Buffer; binding: AgentGrant } {
	const stat = lstatSync(path);
	if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
		|| (stat.mode & 0o177) !== 0 || stat.size > 4096) {
		throw new Error("Grant file identity or permissions invalid");
	}
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)
		|| Object.keys(raw).sort().join(",") !== "expiresAt,principalId,token,workspaceId") {
		throw new Error("Grant file shape invalid");
	}
	const grant = raw as Record<string, unknown>;
	if (typeof grant.token !== "string" || grant.token.length < 32
		|| typeof grant.workspaceId !== "string" || !IDENTIFIER.test(grant.workspaceId)
		|| typeof grant.principalId !== "string" || !IDENTIFIER.test(grant.principalId)
		|| typeof grant.expiresAt !== "number" || !Number.isSafeInteger(grant.expiresAt)) {
		throw new Error("Grant file contents invalid");
	}
	const secret = Buffer.from(grant.token);
	const binding = { workspaceId: grant.workspaceId, principalId: grant.principalId,
		expiresAt: grant.expiresAt } as AgentGrant;
	return { secret, binding };
}

export function readAgentGrantFile(path: string): (token: string) => AgentGrant | null {
	if (!isAbsolute(path)) throw new Error("Grant file must be an absolute path");
	loadGrant(path);
	return (token: string): AgentGrant | null => {
		let grant;
		try {
			grant = loadGrant(path);
		} catch {
			return null;
		}
		const candidate = Buffer.from(token);
		return candidate.length === grant.secret.length && timingSafeEqual(candidate, grant.secret)
			? grant.binding : null;
	};
}

export function readOwnerAgentBindingFile(path: string): () => AgentGrant | null {
	if (!isAbsolute(path)) throw new Error("Grant file must be an absolute path");
	const loadBinding = (): Pick<AgentGrant, "workspaceId" | "principalId"> => {
		const stat = lstatSync(path);
		if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
			|| (stat.mode & 0o177) !== 0 || stat.size > 4096) throw new Error("Binding permissions invalid");
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)
			|| Object.keys(raw).sort().join(",") !== "principalId,workspaceId") throw new Error("Binding shape invalid");
		const binding = raw as Record<string, unknown>;
		if (typeof binding.workspaceId !== "string" || !IDENTIFIER.test(binding.workspaceId)
			|| typeof binding.principalId !== "string" || !IDENTIFIER.test(binding.principalId)) {
			throw new Error("Binding identity invalid");
		}
		return { workspaceId: binding.workspaceId, principalId: binding.principalId };
	};
	loadBinding();
	return (): Pick<AgentGrant, "workspaceId" | "principalId"> | null => {
		try {
			return loadBinding();
		} catch {
			return null;
		}
	};
}
