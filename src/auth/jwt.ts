/**
 * Local, verification-free JWT decoding used only to describe a token
 * (issuer, expiry) without ever printing it.
 */

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface JwtSummary {
  algorithm?: string;
  type?: string;
  hasKeyId: boolean;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  issuedAt?: string;
  expiresAt?: string;
  lifetimeSeconds?: number;
  secondsUntilExpiry?: number;
  expired?: boolean;
  providerHint?: string;
  signInProvider?: string;
  /** Bevel's userId claim, masked: enough to tell two accounts apart. */
  account?: string;
  /** Names only; values may contain personal data. */
  claimNames: string[];
}

function decodeSegment(segment: string): Record<string, unknown> {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT segment is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("Token is not a JWT (expected three dot-separated segments)");
  }
  try {
    return { header: decodeSegment(parts[0]), payload: decodeSegment(parts[1]) };
  } catch {
    throw new Error("Token is not a JWT (segments are not base64url JSON)");
  }
}

/** Shows enough of an identifier to recognise it without disclosing it. */
export function maskIdentifier(value: string): string {
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

export function guessProvider(issuer: string | undefined): string | undefined {
  if (!issuer) return undefined;
  const iss = issuer.toLowerCase();
  if (iss.startsWith("https://securetoken.google.com/")) return "Firebase Authentication";
  if (iss.includes("cognito-idp.")) return "AWS Cognito";
  if (iss.includes(".auth0.com") || iss.includes("auth0")) return "Auth0";
  if (iss.includes("supabase")) return "Supabase Auth";
  if (iss.includes("clerk")) return "Clerk";
  if (iss.includes("appleid.apple.com")) return "Sign in with Apple";
  if (iss.includes("accounts.google.com")) return "Google Sign-In";
  if (iss.includes("supersethealth") || iss.includes("bevel")) return "Bevel's own auth service";
  return undefined;
}

function toIso(seconds: unknown): string | undefined {
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined;
}

export function summarizeJwt(token: string, nowMs: number = Date.now()): JwtSummary {
  const { header, payload } = decodeJwt(token);
  const iat = typeof payload.iat === "number" ? payload.iat : undefined;
  const exp = typeof payload.exp === "number" ? payload.exp : undefined;
  const issuer = typeof payload.iss === "string" ? payload.iss : undefined;
  const aud = payload.aud;
  const firebase = payload.firebase;
  const signInProvider =
    firebase && typeof firebase === "object" && "sign_in_provider" in firebase
      ? String((firebase as Record<string, unknown>).sign_in_provider)
      : undefined;

  const summary: JwtSummary = {
    hasKeyId: typeof header.kid === "string",
    claimNames: Object.keys(payload).sort(),
  };
  if (typeof header.alg === "string") summary.algorithm = header.alg;
  if (typeof header.typ === "string") summary.type = header.typ;
  if (issuer) summary.issuer = issuer;
  if (typeof aud === "string" || Array.isArray(aud)) summary.audience = aud as string | string[];
  if (typeof payload.sub === "string") summary.subject = maskIdentifier(payload.sub);
  const issuedAt = toIso(iat);
  if (issuedAt) summary.issuedAt = issuedAt;
  const expiresAt = toIso(exp);
  if (expiresAt) summary.expiresAt = expiresAt;
  if (iat !== undefined && exp !== undefined) summary.lifetimeSeconds = exp - iat;
  if (exp !== undefined) {
    summary.secondsUntilExpiry = Math.round(exp - nowMs / 1000);
    summary.expired = summary.secondsUntilExpiry <= 0;
  }
  const hint =
    guessProvider(issuer) ??
    // Captured Bevel tokens carry only userId/iat/exp and no issuer.
    (!issuer && "userId" in payload ? "Bevel's own auth service (userId claim, no issuer)" : undefined);
  if (hint) summary.providerHint = hint;
  if (signInProvider) summary.signInProvider = signInProvider;
  if (typeof payload.userId === "string") summary.account = maskIdentifier(payload.userId);
  return summary;
}

export function formatDuration(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  let s = Math.abs(Math.round(totalSeconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", s || (!d && !h && !m) ? `${s}s` : ""];
  return sign + parts.filter(Boolean).join(" ");
}
