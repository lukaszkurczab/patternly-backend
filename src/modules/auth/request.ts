import type { FastifyRequest } from "fastify";
import type { IdentityTokenVerifier } from "../../infrastructure/firebase/verifier.js";
import type { AuthenticatedIdentity } from "./contracts.js";

export type IdentityResolver = Readonly<{
  ensureUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string }>>;
}>;

export async function authenticateRequest(
  request: FastifyRequest,
  verifier: IdentityTokenVerifier | null,
  resolver: IdentityResolver,
): Promise<Readonly<{ identity: AuthenticatedIdentity; userId: string; authTime: number }>> {
  if (!verifier) throw new Error("authentication_not_configured");
  const header = request.headers.authorization;
  if (typeof header !== "string" || !/^Bearer\s+\S+$/u.test(header)) throw new Error("authentication_required");
  const token = header.slice("Bearer ".length).trim();
  const identity = await verifier.verify(token);
  const user = await resolver.ensureUser(identity);
  return Object.freeze({ identity, userId: user.userId, authTime: identity.authTime });
}
