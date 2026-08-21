import { z } from "zod";

export const authenticatedIdentitySchema = z.object({
  provider: z.enum(["firebase", "apple", "google"]),
  subject: z.string().min(1).max(256),
  email: z.string().email().optional(),
  emailVerified: z.boolean(),
});

export type AuthenticatedIdentity = z.infer<typeof authenticatedIdentitySchema>;

export type AuthContext = Readonly<{
  externalIdentity: AuthenticatedIdentity;
  userId: string;
}>;
