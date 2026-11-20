import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { getPublisher } from "../_shared/publisher/index.ts";
import { platformLabel } from "../_shared/publisher/platform-rules.ts";

// Connect a social account for publishing, via the configured provider.
// Three actions:
//   start  -> returns an authorization URL to send the user to (OAuth).
//   sync   -> after the user returns, read the connected account from the
//             provider and upsert it into social_connections.
//   status -> return the stored connection for this user/platform.
//
// `platform` is passed in the request body (e.g. "linkedin", "instagram").
// Defaults to "linkedin" for backward compatibility with any caller that
// hasn't been updated to pass it yet. To add a new platform here, no code
// change is needed in this file -- it's already platform-agnostic; see the
// platform-onboarding checklist in platform-rules.ts for the other steps.
//
// The provider API key lives only in this server (env), never in the client.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Zernio saves the member's PERSONAL LinkedIn profile on a plain connect.
// This switches an already-connected account to company-page (organization)
// posting, or back to personal, without a second sign-in.
// PUT /v1/accounts/{accountId}/linkedin-organization  { accountType, selectedOrganization }
// Zernio requires selectedOrganization when accountType is "organization".
async function setLinkedInAccountType(
  accountId: string,
  accountType: "personal" | "organization",
  selectedOrganization?: Record<string, unknown>,
): Promise<{ accountType?: string; accountName?: string }> {
  const res = await fetch(
    `https://zernio.com/api/v1/accounts/${encodeURIComponent(accountId)}/linkedin-organization`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${Deno.env.get("ZERNIO_API_KEY") ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        accountType === "organization" && selectedOrganization
          ? { accountType, selectedOrganization }
          : { accountType },
      ),
    },
  );
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(body?.error || body?.message || text || `HTTP ${res.status}`);
  return body ?? {};
}

// Company pages the connected LinkedIn user can post as.
// GET /v1/accounts/{accountId}/linkedin-organizations -> { organizations: [{ id, name, vanityName, localizedName }] }
async function listLinkedInOrganizations(accountId: string): Promise<any[]> {
  const res = await fetch(
    `https://zernio.com/api/v1/accounts/${encodeURIComponent(accountId)}/linkedin-organizations`,
    { headers: { Authorization: `Bearer ${Deno.env.get("ZERNIO_API_KEY") ?? ""}` } },
  );
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(body?.error || body?.message || text || `HTTP ${res.status}`);
  const orgs = Array.isArray(body?.organizations) ? body.organizations : [];
  if (!orgs.length) {
    throw new Error(
      "LinkedIn shows no company pages for this user. The user must be an admin of the company page. Zernio said: " +
        String(text).slice(0, 300),
    );
  }
  return orgs;
}

const orgName = (o: any) => o?.localizedName || o?.name || o?.vanityName || String(o?.id ?? "");

// Raw LinkedIn account rows from Zernio. The docs do not name the field that
// separates a personal profile from a company page, so isOrgAccount checks the
// likely names (accountType, type, isOrganization).
async function listRawLinkedInAccounts(): Promise<any[]> {
  const res = await fetch("https://zernio.com/api/v1/accounts?platform=linkedin", {
    headers: { Authorization: `Bearer ${Deno.env.get("ZERNIO_API_KEY") ?? ""}` },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new Error(body?.error || body?.message || text || `HTTP ${res.status}`);
  const rows: any[] = body?.accounts ?? body?.data ?? [];
  return rows.filter((a) => a?.platform === "linkedin");
}
const orgHint = (a: any) =>
  [a?.accountType, a?.type, a?.metadata?.accountType, a?.metadata?.type, a?.platformUserId, a?.profileUrl]
    .map((x) => String(x ?? ""))
    .join(" ");
const isOrgAccount = (a: any) =>
  a?.isOrganization === true || /organization|\bcompany\b|\/company\//i.test(orgHint(a));

// Switch to a company page. One page -> use it. Several pages -> use the one
// matching organizationId, else report needsChoice with the list.
async function switchToCompany(
  accountId: string,
  organizationId?: string,
): Promise<{ accountName?: string; accountType?: string; needsChoice: boolean; organizations: any[] }> {
  const organizations = await listLinkedInOrganizations(accountId);
  if (!organizations.length) {
    throw new Error("LinkedIn shows no company pages for this user. The user must be an admin of the company page.");
  }
  const chosen = organizationId
    ? organizations.find((o) => String(o.id) === String(organizationId))
    : organizations.length === 1 ? organizations[0] : null;
  if (!chosen) return { needsChoice: true, organizations };
  const r = await setLinkedInAccountType(accountId, "organization", chosen);
  return { ...r, accountName: r.accountName ?? orgName(chosen), needsChoice: false, organizations };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Authentication required" }, 401);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ error: "Invalid or expired token" }, 401);
    const userId = user.id;

    const { action, redirectUrl, platform, accountType, organizationId } = await req.json().catch(() => ({ action: "status" } as any));
    const PLATFORM = platform ?? "linkedin";
    const publisher = getPublisher();
    const provider = publisher.name;

    if (action === "start") {
      if (!redirectUrl) return json({ error: "redirectUrl is required" }, 400);
      // Zernio organizes accounts under a profile; reuse the default one.
      const profileId = (await publisher.getDefaultProfileId()) ?? undefined;
      const { authorizationUrl } = await publisher.getConnectUrl({
        platform: PLATFORM,
        profileId,
        redirectUrl,
      });
      return json({ authorizationUrl });
    }

    if (action === "sync") {
      let accounts = await publisher.listAccounts(PLATFORM);
      // Prefer accounts on this install's default Zernio profile, so another
      // client's account on the same key is never picked.
      const defaultProfile = await publisher.getDefaultProfileId().catch(() => null);
      if (defaultProfile) {
        const own = accounts.filter((a) => a.profileId === defaultProfile);
        if (own.length) accounts = own;
      }
      if (!accounts.length) {
        return json({ connected: false, error: `No ${platformLabel(PLATFORM)} account found on the provider yet` }, 404);
      }
      let acct = accounts[0];
      let warning: string | null = null;
      let switchedName: string | null = null;
      let foundOrg = false;
      let accountsDebug: unknown = null;
      if (PLATFORM === "linkedin") {
        // Zernio can hold the personal profile AND the company page as separate
        // accounts. Use the company page when it exists.
        try {
          const rawRows = await listRawLinkedInAccounts();
          const org = rawRows.find(isOrgAccount);
          if (org) {
            acct = {
              ...acct,
              accountId: org.accountId ?? org._id ?? org.id,
              displayName: org.displayName ?? org.name ?? acct.displayName,
              username: org.username ?? acct.username,
            };
            foundOrg = true;
          } else {
            accountsDebug = rawRows.map((a) => ({
              idEnd: String(a?._id ?? a?.accountId ?? a?.id ?? "").slice(-5),
              name: a?.displayName ?? a?.name ?? a?.username,
              keys: Object.keys(a ?? {}),
              platformUserId: a?.platformUserId,
              profileUrl: a?.profileUrl,
              metadata: JSON.stringify(a?.metadata ?? null).slice(0, 300),
              permissions: JSON.stringify(a?.permissions ?? null).slice(0, 200),
            }));
          }
        } catch (_e) { /* fall through to the switch attempt below */ }
      }
      if (PLATFORM === "linkedin" && !foundOrg) {
        try {
          const r = await switchToCompany(acct.accountId);
          if (r.needsChoice) {
            warning = "Connected to your personal LinkedIn profile. You have more than one company page: " +
              r.organizations.map(orgName).join(", ") +
              ". Tell Claude which page to use.";
          } else {
            switchedName = r.accountName ?? null;
          }
        } catch (e) {
          warning = "Connected to your personal LinkedIn profile. LinkedIn would not switch it to a company page: " +
            (e instanceof Error ? e.message : "unknown error") +
            ". Check that the LinkedIn user is an admin of the company page.";
        }
      }
      const row = {
        user_id: userId,
        provider,
        platform: PLATFORM,
        external_account_id: acct.accountId,
        external_profile_id: acct.profileId ?? null,
        account_label: switchedName ?? acct.displayName ?? acct.username ?? null,
        status: acct.status ?? "active",
        connected_at: new Date().toISOString(),
      };
      const { data, error } = await supabase
        .from("social_connections")
        .upsert(row, { onConflict: "user_id,provider,platform" })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      // Approved drafts that failed to schedule while this platform was not
      // connected (or the key was bad) are never retried by anything else.
      // Retry them now that a working connection exists.
      let retried = 0;
      let retryScheduled = 0;
      try {
        const { data: stuck } = await supabase
          .from("drafts")
          .select("id")
          .eq("user_id", userId)
          .eq("approval_status", "approved")
          .eq("platform", PLATFORM)
          .is("external_post_id", null)
          .or("publish_status.is.null,publish_status.eq.needs_attention,publish_status.eq.failed")
          .limit(50);
        for (const d of stuck ?? []) {
          retried++;
          const r = await fetch(`${supabaseUrl}/functions/v1/publish-to-zernio`, {
            method: "POST",
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ draftId: d.id }),
          });
          const body = await r.json().catch(() => ({}));
          if (body?.status === "scheduled") retryScheduled++;
          else console.error("zernio-connect retry not scheduled", d.id, JSON.stringify(body).slice(0, 300));
        }
      } catch (e) {
        console.error("zernio-connect retry sweep failed", e instanceof Error ? e.message : e);
      }
      return json({ connected: true, connection: data, warning, accountsDebug, retried, retryScheduled });
    }

    // switch_type -> change a connected LinkedIn account between company page
    // (organization) and personal profile. Errors come back with HTTP 200 and
    // an `error` field so the browser can show the real reason.
    if (action === "switch_type") {
      if (PLATFORM !== "linkedin") return json({ error: "Only LinkedIn has personal and company modes." });
      const { data: conn } = await supabase
        .from("social_connections")
        .select("*")
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("platform", PLATFORM)
        .maybeSingle();
      if (!conn?.external_account_id) return json({ error: "Connect LinkedIn first." });
      const target = accountType === "personal" ? "personal" : "organization";
      try {
        const r = target === "organization"
          ? await switchToCompany(conn.external_account_id, organizationId)
          : await setLinkedInAccountType(conn.external_account_id, "personal");
        if ((r as any).needsChoice) {
          const list = ((r as any).organizations as any[]).map((o) => `${orgName(o)} (id ${o.id})`).join("; ");
          return json({ error: `More than one company page: ${list}. Tell Claude which page to use.` });
        }
        const { data: updated, error: upErr } = await supabase
          .from("social_connections")
          .update({ account_label: r.accountName ?? conn.account_label })
          .eq("id", conn.id)
          .select()
          .single();
        if (upErr) return json({ error: upErr.message });
        return json({ connected: true, connection: updated, accountType: r.accountType ?? target });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Switch failed" });
      }
    }

    // status (default)
    const { data } = await supabase
      .from("social_connections")
      .select("*")
      .eq("user_id", userId)
      .eq("provider", provider)
      .eq("platform", PLATFORM)
      .maybeSingle();
    return json({ connected: !!data, connection: data ?? null });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
