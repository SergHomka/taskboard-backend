import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
	return UUID_RE.test(s);
}

function getStripe(env: Env): Stripe {
	const key =
		env.STRIPE_SECRET_KEY?.trim() ||
		"sk_test_00000000000000000000000000000000000000000000000000000000000000";
	return new Stripe(key, {
		apiVersion: Stripe.API_VERSION,
		httpClient: Stripe.createFetchHttpClient(),
	});
}

function getSupabase(env: Env) {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: {
			persistSession: false,
			autoRefreshToken: false,
		},
	});
}

/**
 * Если строки нет в `profiles` (сбой триггера и т.п.), ищем пользователя в Auth по email (service role).
 */
async function resolveUserIdViaAuthAdmin(
	supabase: ReturnType<typeof getSupabase>,
	supabaseUrl: string,
	serviceKey: string,
	email: string,
): Promise<string | null> {
	const normalized = email.trim().toLowerCase();
	if (!normalized) return null;

	const base = supabaseUrl.replace(/\/$/, "");
	const filterUrl = `${base}/auth/v1/admin/users?email=${encodeURIComponent(normalized)}`;
	const filtered = await fetch(filterUrl, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${serviceKey}`,
			apikey: serviceKey,
		},
	});
	if (filtered.ok) {
		const parsed = (await filtered.json()) as {
			users?: Array<{ id?: string }>;
		};
		const id = parsed.users?.[0]?.id;
		if (typeof id === "string" && isUuid(id)) return id;
	}

	let page = 1;
	const perPage = 1000;
	for (; page <= 10; page++) {
		const { data, error } = await supabase.auth.admin.listUsers({
			page,
			perPage,
		});
		if (error) {
			console.error("stripe webhook: auth.admin.listUsers", error.message);
			return null;
		}
		const users = data.users ?? [];
		const hit = users.find(
			(u) => u.email?.trim().toLowerCase() === normalized,
		);
		if (hit?.id && isUuid(hit.id)) return hit.id;
		if (users.length < perPage) break;
	}
	return null;
}

async function resolveUserIdForSession(
	supabase: ReturnType<typeof getSupabase>,
	session: Stripe.Checkout.Session,
	opts: { supabaseUrl: string; serviceKey: string },
): Promise<string | null> {
	const ref = session.client_reference_id;
	if (ref && isUuid(ref)) {
		return ref;
	}
	const emailRaw =
		session.customer_details?.email ??
		(typeof session.customer_email === "string" ? session.customer_email : null);
	if (!emailRaw?.trim()) {
		return null;
	}
	const email = emailRaw.trim().toLowerCase();
	const { data, error } = await supabase
		.from("profiles")
		.select("id")
		.eq("email", email)
		.maybeSingle();
	if (error) {
		console.error("stripe webhook: profiles lookup", error.message);
	}
	if (data?.id) {
		return data.id;
	}

	return resolveUserIdViaAuthAdmin(
		supabase,
		opts.supabaseUrl,
		opts.serviceKey,
		email,
	);
}

function paymentIntentString(session: Stripe.Checkout.Session): string | null {
	const pi = session.payment_intent;
	if (typeof pi === "string") {
		return pi;
	}
	if (pi && typeof pi === "object" && "id" in pi) {
		return String((pi as { id: string }).id);
	}
	return null;
}

function checkoutSubscriptionId(session: Stripe.Checkout.Session): string | null {
	const raw = session.subscription;
	if (typeof raw === "string" && raw.startsWith("sub_")) {
		return raw;
	}
	if (raw && typeof raw === "object" && "id" in raw) {
		const id = String((raw as Stripe.Subscription).id);
		return id.startsWith("sub_") ? id : null;
	}
	return null;
}

/** В Stripe API subscription periods живут на subscription items (не на корне Subscription). */
function subscriptionPeriodEndUnix(sub: Stripe.Subscription): number | null {
	const items = sub.items?.data;
	if (!items?.length) return null;
	let maxEnd = -Infinity;
	for (const item of items) {
		if (typeof item.current_period_end === "number") {
			maxEnd = Math.max(maxEnd, item.current_period_end);
		}
	}
	return maxEnd === -Infinity ? null : maxEnd;
}

function jsonOk(body: Record<string, unknown> = { received: true }): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function subscriptionPeriodEndIso(
	stripe: Stripe,
	subscriptionId: string,
): Promise<string | null> {
	try {
		const subResp = await stripe.subscriptions.retrieve(subscriptionId);
		const unix = subscriptionPeriodEndUnix(subResp as Stripe.Subscription);
		if (unix === null) return null;
		return new Date(unix * 1000).toISOString();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("stripe webhook: subscriptions.retrieve", subscriptionId, msg);
		return null;
	}
}

export async function handleStripeWebhook(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
	const supabaseUrl = env.SUPABASE_URL?.trim();
	const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

	if (!webhookSecret || !supabaseUrl || !serviceKey) {
		console.error("stripe webhook: missing STRIPE_WEBHOOK_SECRET or Supabase secrets");
		return new Response("Misconfigured", { status: 500 });
	}

	const payload = await request.text();
	const sig = request.headers.get("stripe-signature");
	if (!sig) {
		return new Response("Missing Stripe-Signature", { status: 400 });
	}

	const stripe = getStripe(env);
	let event: Stripe.Event;
	try {
		event = await stripe.webhooks.constructEventAsync(payload, sig, webhookSecret);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("stripe webhook signature:", msg);
		return new Response("Invalid signature", { status: 400 });
	}

	const supabase = getSupabase(env);

	if (event.type === "customer.subscription.updated") {
		const sub = event.data.object as Stripe.Subscription;
		const unix = subscriptionPeriodEndUnix(sub);
		const periodEnd =
			unix !== null ? new Date(unix * 1000).toISOString() : null;
		const { error } = await supabase
			.from("stripe_payments")
			.update({ subscription_period_end: periodEnd })
			.eq("stripe_subscription_id", sub.id);
		if (error) {
			console.error("stripe webhook subscription update:", error.message);
			return new Response("Database error", { status: 500 });
		}
		return jsonOk({ updated: true });
	}

	if (event.type !== "checkout.session.completed") {
		return jsonOk({ received: true, ignored: event.type });
	}

	const session = event.data.object as Stripe.Checkout.Session;
	if (!session.id) {
		return jsonOk({ received: true, skipped: "no_session_id" });
	}

	const userId = await resolveUserIdForSession(supabase, session, {
		supabaseUrl,
		serviceKey,
	});
	if (!userId) {
		console.warn(
			"stripe webhook: checkout.session.completed without resolvable user",
			session.id,
		);
		return jsonOk({ received: true, skipped: "no_user" });
	}

	const subscriptionId = checkoutSubscriptionId(session);
	let subscriptionPeriodEnd: string | null = null;
	if (subscriptionId) {
		subscriptionPeriodEnd = await subscriptionPeriodEndIso(stripe, subscriptionId);
	}

	const { error } = await supabase.from("stripe_payments").insert({
		user_id: userId,
		stripe_checkout_session_id: session.id,
		stripe_payment_intent_id: paymentIntentString(session),
		stripe_subscription_id: subscriptionId,
		subscription_period_end: subscriptionPeriodEnd,
		amount_total: session.amount_total ?? 0,
		currency: (session.currency ?? "usd").toLowerCase(),
		payment_status: session.payment_status ?? "unknown",
		raw_metadata: {
			mode: session.mode,
			metadata: session.metadata ?? {},
		},
	});

	if (error) {
		if (error.code === "23505") {
			return jsonOk({ received: true, duplicate: true });
		}
		console.error("stripe webhook insert:", error.message);
		return new Response("Database error", { status: 500 });
	}

	return jsonOk();
}
