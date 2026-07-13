import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID')!;
const PLAID_SECRET    = Deno.env.get('PLAID_SECRET')!;
const PLAID_ENV       = Deno.env.get('PLAID_ENV') || 'sandbox';
const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function plaidBase() {
  if (PLAID_ENV === 'production')  return 'https://production.plaid.com';
  if (PLAID_ENV === 'development') return 'https://development.plaid.com';
  return 'https://sandbox.plaid.com';
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function plaidPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(plaidBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...body }),
  });
  return res.json();
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get('action');
  const db     = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // ── link-token ─────────────────────────────────────────────────────────────
    // Creates a short-lived Link token for the frontend to initialize Plaid Link.
    if (action === 'link-token') {
      const data = await plaidPost('/link/token/create', {
        user: { client_user_id: 'meagan' },
        client_name: 'Virtual Pike',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      });
      if (data.error_message) return json({ error: data.error_message }, 400);
      return json({ link_token: data.link_token });
    }

    // ── link-token-update ──────────────────────────────────────────────────────
    // Creates a Link token in update mode for an already-connected item.
    // Looks up the access_token server-side — it never reaches the frontend.
    if (action === 'link-token-update') {
      const body = await req.json();
      const { item_id } = body;
      if (!item_id) return json({ error: 'item_id required' }, 400);

      const { data: token } = await db
        .from('plaid_tokens')
        .select('access_token')
        .eq('id', item_id)
        .single();

      if (!token) return json({ error: 'item not found' }, 404);

      const data = await plaidPost('/link/token/create', {
        user:         { client_user_id: 'meagan' },
        client_name:  'Virtual Pike',
        access_token: token.access_token,
        country_codes: ['US'],
        language:     'en',
      });
      if (data.error_message) return json({ error: data.error_message }, 400);
      return json({ link_token: data.link_token });
    }

    // ── exchange ───────────────────────────────────────────────────────────────
    // Receives the public_token from the frontend after a successful Link flow,
    // exchanges it for a permanent access_token, and stores it server-side.
    // The access_token never leaves this function.
    if (action === 'exchange') {
      const body = await req.json();
      const { public_token, institution_id, institution_name } = body;

      const data = await plaidPost('/item/public_token/exchange', { public_token });
      if (data.error_message) return json({ error: data.error_message }, 400);

      await db.from('plaid_tokens').upsert({
        id:               data.item_id,
        access_token:     data.access_token,
        item_id:          data.item_id,
        institution_id:   institution_id  || null,
        institution_name: institution_name || null,
        pike_account_ids: [],
        updated_at:       new Date().toISOString(),
      });

      return json({ item_id: data.item_id, institution_name });
    }

    // ── status ─────────────────────────────────────────────────────────────────
    // Returns which institutions are connected. Never exposes access_token.
    if (action === 'status') {
      const { data } = await db
        .from('plaid_tokens')
        .select('id, institution_id, institution_name, pike_account_ids, created_at');
      return json({ items: data || [] });
    }

    // ── accounts ───────────────────────────────────────────────────────────────
    // Fetches account metadata for all connected items.
    if (action === 'accounts') {
      const { data: tokens } = await db
        .from('plaid_tokens')
        .select('id, access_token, institution_name');

      const results = await Promise.all((tokens || []).map(async (t) => {
        const data = await plaidPost('/accounts/get', { access_token: t.access_token });
        return {
          item_id:     t.id,
          institution: t.institution_name,
          accounts:    data.accounts  || [],
          error:       data.error_message || null,
        };
      }));

      return json({ results });
    }

    // ── transactions ───────────────────────────────────────────────────────────
    // Fetches transactions using the cursor-based sync endpoint.
    // ?item_id=  — limit to one institution (optional)
    // ?all=true  — loop all pages; otherwise returns first page only (preview)
    if (action === 'transactions') {
      const itemId   = url.searchParams.get('item_id');
      const fetchAll = url.searchParams.get('all') === 'true';

      let tokenQuery = db.from('plaid_tokens').select('id, access_token, institution_name');
      if (itemId) tokenQuery = tokenQuery.eq('id', itemId);
      const { data: tokens } = await tokenQuery;

      const results = await Promise.all((tokens || []).map(async (t) => {
        let allAdded: Record<string, unknown>[] = [];
        let cursor: string | undefined = undefined;

        do {
          const reqBody: Record<string, unknown> = { access_token: t.access_token };
          if (cursor) reqBody.cursor = cursor;

          const data = await plaidPost('/transactions/sync', reqBody);
          if (data.error_message) {
            return { item_id: t.id, institution: t.institution_name, added: allAdded, has_more: false, error: data.error_message };
          }

          allAdded = allAdded.concat(data.added || []);
          cursor   = data.next_cursor;

          if (!fetchAll || !data.has_more) break;
        } while (true);

        return {
          item_id:     t.id,
          institution: t.institution_name,
          added:       allAdded,
          has_more:    false,
          error:       null,
        };
      }));

      return json({ results });
    }

    // ── sync ───────────────────────────────────────────────────────────────────
    // Fetches all pages since the stored cursor (or full history if no cursor).
    // Does NOT store the cursor — frontend calls save-cursor only after the user
    // confirms the import, so cancelling never advances the cursor.
    if (action === 'sync') {
      const body = await req.json();
      const { item_id } = body;
      if (!item_id) return json({ error: 'item_id required' }, 400);

      const { data: token } = await db
        .from('plaid_tokens')
        .select('access_token, institution_name, cursor')
        .eq('id', item_id)
        .single();

      if (!token) return json({ error: 'item not found' }, 404);

      let allAdded:    Record<string, unknown>[] = [];
      let allModified: Record<string, unknown>[] = [];
      let allRemoved:  Record<string, unknown>[] = [];
      let cursor: string | undefined = token.cursor || undefined;
      let nextCursor = cursor;

      do {
        const reqBody: Record<string, unknown> = { access_token: token.access_token };
        if (cursor) reqBody.cursor = cursor;

        const data = await plaidPost('/transactions/sync', reqBody);
        if (data.error_message) return json({ error: data.error_message }, 400);

        allAdded    = allAdded.concat(data.added    || []);
        allModified = allModified.concat(data.modified || []);
        allRemoved  = allRemoved.concat(data.removed  || []);
        nextCursor  = data.next_cursor;
        cursor      = data.next_cursor;

        if (!data.has_more) break;
      } while (true);

      return json({
        item_id,
        institution: token.institution_name,
        added:       allAdded,
        modified:    allModified,
        removed:     allRemoved,
        next_cursor: nextCursor,
      });
    }

    // ── save-cursor ────────────────────────────────────────────────────────────
    // Stores the sync cursor after the user confirms an import.
    // Keeping this separate from sync means cancelling never advances the cursor.
    if (action === 'save-cursor') {
      const body = await req.json();
      const { item_id, cursor } = body;
      if (!item_id || !cursor) return json({ error: 'item_id and cursor required' }, 400);

      await db.from('plaid_tokens')
        .update({ cursor, updated_at: new Date().toISOString() })
        .eq('id', item_id);

      return json({ ok: true });
    }

    // ── refresh ────────────────────────────────────────────────────────────────
    // Asks Plaid to fetch fresh data from the bank RIGHT NOW instead of
    // waiting for its periodic background cycle — the Rocket Money trick.
    // Fire-and-forget: Plaid ingests within ~seconds to a minute; the next
    // sync then sees the new delta (including fresh pending transactions).
    if (action === 'refresh') {
      const body = await req.json();
      const { item_id } = body;
      if (!item_id) return json({ error: 'item_id required' }, 400);

      const { data: token } = await db
        .from('plaid_tokens')
        .select('access_token')
        .eq('id', item_id)
        .single();

      if (!token) return json({ error: 'item not found' }, 404);

      const data = await plaidPost('/transactions/refresh', { access_token: token.access_token });
      if (data.error_message) return json({ error: data.error_message }, 400);
      return json({ ok: true });
    }

    // ── reset-cursor ───────────────────────────────────────────────────────────
    // Clears an item's sync cursor so the next sync re-delivers full history.
    // Safe: the frontend dedupes by plaidTransactionId. Used to backfill
    // pending transactions that predate pending-import support.
    if (action === 'reset-cursor') {
      const body = await req.json();
      const { item_id } = body;
      if (!item_id) return json({ error: 'item_id required' }, 400);

      await db.from('plaid_tokens')
        .update({ cursor: null, updated_at: new Date().toISOString() })
        .eq('id', item_id);

      return json({ ok: true });
    }

    // ── disconnect ─────────────────────────────────────────────────────────────
    // Revokes the Plaid item and removes the token from storage.
    if (action === 'disconnect') {
      const body = await req.json();
      const { item_id } = body;

      const { data: token } = await db
        .from('plaid_tokens')
        .select('access_token')
        .eq('id', item_id)
        .single();

      if (token?.access_token) {
        await plaidPost('/item/remove', { access_token: token.access_token });
      }
      await db.from('plaid_tokens').delete().eq('id', item_id);

      return json({ ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    console.error('plaid-proxy error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
