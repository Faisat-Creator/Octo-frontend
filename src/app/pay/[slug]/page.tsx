"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { CopyButton } from "@/components/CopyButton";
import { AddressQrCode } from "@/components/qr/AddressQrCode";
import { sep7PayUri } from "@/lib/sep7";
import {
  getPublicPaymentLink,
  createPaymentIntent,
  getPaymentStatus,
  getPublicSigningInfo,
  submitPublicPayment,
  usdAmountToStroops,
  isValidEmail,
  type PublicPaymentLink,
  type PaymentIntent,
  type PaymentStatus,
} from "@/lib/payment-links";
import { usdcForNetwork } from "@/lib/network";
import { network } from "@/lib/network";
import { buildUnsignedPayment, assertNetworkConsistency } from "@/lib/sdk";
import { assertSignedMatchesBuilt } from "@/lib/sdk/signedTxCheck";
import { OctoSpinner } from "@/components/OctoSpinner";
import { PayerPrivacyNotice } from "@/components/checkout/PayerPrivacyNotice";
import confetti from "canvas-confetti";
import { formatStroops, parseAmount } from "@/lib/amount";
import { explorerTxUrl } from "@/lib/explorer";
import { ApiError, errorMessage } from "@/lib/api";
import { friendlyResultMessage } from "@/lib/stellar/resultCodes";
import { isTrustedImageUrl } from "@/lib/isTrustedImageUrl";
import { validateRedirectUrl } from "@/lib/redirectUrl";
import { formatCountdownMs } from "@/lib/format";

type Step = "loading" | "not-found" | "error" | "form" | "pay" | "confirmed";

/** Keep the loading spinner up for at least this long so it doesn't just flash on fast loads. */
const MIN_LOADING_MS = 700;

/** Stop auto-polling after this long when the API doesn't tell us when the intent expires. */
const MAX_POLL_MS = 30 * 60_000;

/** Warn the payer once this much time is left before the intent expires. */
const EXPIRY_WARNING_MS = 2 * 60_000;

/** Minimum flexible amount in USD, used when the link doesn't specify one. */
const MIN_FLEXIBLE_USD = 0.01;

/** Minimum flexible amount in stroops (1 USDC = 10,000,000 stroops). */
const MIN_FLEXIBLE_USD_STROOPS = Math.round(MIN_FLEXIBLE_USD * 10_000_000);

/** Human-readable minimum for error copy. */
const MIN_FLEXIBLE_USD_LABEL = `$${MIN_FLEXIBLE_USD.toFixed(2)}`;

// Status poll interval, backing off 3s → 5s → 10s the longer the payer waits.
function pollDelayMs(elapsedMs: number) {
  if (elapsedMs < 60_000) return 3_000;
  if (elapsedMs < 3 * 60_000) return 5_000;
  return 10_000;
}

// Identifies the payer inputs an intent was created from, so edits force a fresh intent.
function intentInputsKey(amountUsdcStroops: number, name: string, email: string) {
  return JSON.stringify([amountUsdcStroops, name, email.toLowerCase()]);
}

function celebrate() {
  confetti({
    particleCount: 140,
    spread: 80,
    origin: { y: 0.6 },
    disableForReducedMotion: true,
  });
}

// Builds the merchant return URL; only https: URLs are followed and it fails closed on a bad URL.
function buildMerchantReturnUrl(redirectUrl: string, paymentId: string, slugValue: string): string | null {
  const error = validateRedirectUrl(redirectUrl);
  if (error) {
    // malformed or unsafe redirect_url — stay on the confirmed page instead of redirecting
    return null;
  }
  try {
    const url = new URL(redirectUrl);
    if (url.protocol !== "https:") return null;
    url.searchParams.set("status", "success");
    url.searchParams.set("payment_id", paymentId);
    url.searchParams.set("slug", slugValue);
    return url.toString();
  } catch {
    // malformed redirect_url — stay on the confirmed page
    return null;
  }
}

// A Stellar transaction hash is 64 hex characters; anything else is an internal reference.
function isStellarTxHash(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

// Shortens a hash for display while keeping the head and tail recognizable.
function shortenHash(hash: string) {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

// Resolves the min/max flexible bounds for a link, falling back to the client-side minimum.
function flexibleBounds(link: PublicPaymentLink) {
  const min =
    typeof link.min_amount_usdc_stroops === "number" && link.min_amount_usdc_stroops > 0
      ? link.min_amount_usdc_stroops
      : MIN_FLEXIBLE_USD_STROOPS;
  const max =
    typeof link.max_amount_usdc_stroops === "number" && link.max_amount_usdc_stroops > 0
      ? link.max_amount_usdc_stroops
      : null;
  return { min, max };
}

// Returns an error message for an out-of-bounds flexible amount, or null when it's acceptable.
function validateFlexibleAmount(
  amountUsdcStroops: number,
  bounds: { min: number; max: number | null },
): string | null {
  if (amountUsdcStroops < bounds.min) {
    return `Enter at least $${formatStroops(bounds.min)}.`;
  }
  if (bounds.max !== null && amountUsdcStroops > bounds.max) {
    return `Enter at most $${formatStroops(bounds.max)}.`;
  }
  return null;
}

export default function PayPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);

  const [step, setStep] = useState<Step>("loading");
  const [link, setLink] = useState<PublicPaymentLink | null>(null);
  const [amount, setAmount] = useState("");
  const [payerName, setPayerName] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [freighterBusy, setFreighterBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  // Set only for a resolved-but-not-successful status (expired/underpaid/overpaid).
  const [resolvedStatus, setResolvedStatus] = useState<PaymentStatus | null>(null);
  // True once auto-polling gave up without a known expiry; "check now" still works.
  const [pollStopped, setPollStopped] = useState(false);
  // Live intent plus the inputs/time it was created from, readable from async callbacks.
  const intentRef = useRef<{ intent: PaymentIntent; key: string; createdAt: number } | null>(null);
  // Guards confirmation side-effects (confetti, redirect) so they run exactly once.
  const confirmedRef = useRef(false);
  // Network passphrase received from signing-info; used to resolve the correct USDC issuer.
  const [networkPassphrase, setNetworkPassphrase] = useState<string>("");
  // Ticking clock driving the expiry countdown; null until an intent with an expiry exists.
  const [now, setNow] = useState<number | null>(null);
  // Bumped by the retry button to load the link again.
  const [attempt, setAttempt] = useState(0);
  // Transaction reference captured at confirmation (Stellar hash or internal id).
  const [txRef, setTxRef] = useState<string | null>(null);
  // Amount actually confirmed, captured so the receipt survives intent changes.
  const [confirmedAmountStroops, setConfirmedAmountStroops] = useState<number | null>(null);
  // Merchant return URL built at confirmation time (null when there is none or it's unsafe).
  const [returnUrl, setReturnUrl] = useState<string | null>(null);
  // Field-level validation flags driving aria-invalid on the checkout inputs.
  const [nameInvalid, setNameInvalid] = useState(false);
  const [emailInvalid, setEmailInvalid] = useState(false);
  // Normalized flexible amount, computed once per render so the header and pay step agree.
  const parsed = parseAmount(amount);

  useEffect(() => {
    setStep("loading");
    const startedAt = Date.now();
    const finish = (next: Step) => {
      const remaining = MIN_LOADING_MS - (Date.now() - startedAt);
      if (remaining > 0) {
        setTimeout(() => setStep(next), remaining);
      } else {
        setStep(next);
      }
    };
    getPublicPaymentLink(slug)
      .then((l) => {
        setLink(l);
        if (l.amount_usdc_stroops !== null) {
          setAmount(formatStroops(l.amount_usdc_stroops));
        }
        finish("form");
      })
      .catch((err: unknown) => {
        const gone = err instanceof ApiError && (err.status === 404 || err.status === 410);
        finish(gone ? "not-found" : "error");
      });
  }, [slug, attempt]);

  // Swaps the active intent, resetting everything that belonged to the previous one.
  function replaceIntent(next: PaymentIntent | null, key = "") {
    intentRef.current = next ? { intent: next, key, createdAt: Date.now() } : null;
    setIntent(next);
    setResolvedStatus(null);
    setPollStopped(false);
    setCheckMessage(null);
    // Restart the countdown clock for the new intent (or clear it when there is none).
    setNow(next?.expires_at ? Date.now() : null);
  }

  // The single path for every confirmation source (poll, check-now, Freighter).
  const markConfirmed = useCallback(
    (paymentId: string, txReference: string | null, amountStroops: number | null) => {
      if (confirmedRef.current) return;
      confirmedRef.current = true;
      setTxRef(txReference);
      setConfirmedAmountStroops(amountStroops);
      setReturnUrl(link?.redirect_url ? buildMerchantReturnUrl(link.redirect_url, paymentId, slug) : null);
      setStep("confirmed");
      celebrate();
    },
    [link, slug],
  );

  // Handles a status response for `paymentId`; returns true once resolved. Stale intents are ignored.
  const applyStatus = useCallback(
    (paymentId: string, status: PaymentStatus): boolean => {
      if (intentRef.current?.intent.payment_id !== paymentId || confirmedRef.current) return true;
      if (status.status === "confirmed") {
        markConfirmed(paymentId, status.transaction_id, intentRef.current?.intent.amount_usdc_stroops ?? null);
        return true;
      }
      if (status.status === "expired" || status.status === "underpaid" || status.status === "overpaid") {
        setResolvedStatus(status);
        return true;
      }
      return false;
    },
    [markConfirmed],
  );

  // Sets a checkout-specific tab title once the link loads; never includes payer data.
  useEffect(() => {
    if (!link) return;
    const previous = document.title;
    document.title = `Pay ${link.name} · Octo`;
    return () => {
      document.title = previous;
    };
  }, [link]);

  // Expiry is derived from the intent's expires_at so the UI can't drift from the backend.
  const expiresAtMs = intent?.expires_at ? Date.parse(intent.expires_at) : NaN;
  const hasExpiry = Number.isFinite(expiresAtMs);
  const hasNow = now !== null;
  const remainingMs = hasExpiry && hasNow ? expiresAtMs - now : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;

  // Ticks once a second while a countdown is active; stops itself once the intent is gone.
  useEffect(() => {
    if (!hasExpiry || !hasNow || isExpired) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasExpiry, hasNow, isExpired]);

  // Polls for confirmation with backoff; pauses while hidden or a Freighter submit is in flight.
  useEffect(() => {
    if (!intent || step !== "pay" || resolvedStatus || pollStopped || freighterBusy) return;
    const paymentId = intent.payment_id;
    const createdAt = intentRef.current?.createdAt ?? Date.now();
    const expiresAt = intent.expires_at ? Date.parse(intent.expires_at) : NaN;
    const hasExpiry = Number.isFinite(expiresAt);
    const stopAt = hasExpiry ? expiresAt : createdAt + MAX_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let cancelled = false;

    const hidden = () => document.visibilityState === "hidden";

    // Past the window: show the expired state if the API gave an expiry, otherwise just stop.
    const finish = () => {
      if (hasExpiry) {
        setResolvedStatus({
          status: "expired",
          transaction_id: null,
          expected_usdc_stroops: intent.amount_usdc_stroops,
          received_usdc_stroops: null,
        });
      } else {
        setPollStopped(true);
      }
    };

    const schedule = () => {
      if (cancelled || hidden()) return;
      const now = Date.now();
      const delay = Math.min(pollDelayMs(now - createdAt), Math.max(0, stopAt - now));
      timer = setTimeout(tick, delay);
    };

    // One status check, then schedule the next; the final check happens at/after the stop time.
    async function tick() {
      timer = undefined;
      if (cancelled || hidden() || inFlight) return;
      inFlight = true;
      try {
        const status = await getPaymentStatus(slug, paymentId);
        if (cancelled || applyStatus(paymentId, status)) return;
      } catch {
        // transient — keep polling
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      if (Date.now() >= stopAt) return finish();
      schedule();
    }

    // Hidden: drop the pending timer. Visible again: check immediately, then resume the schedule.
    const onVisibility = () => {
      if (hidden()) {
        clearTimeout(timer);
        timer = undefined;
      } else if (!timer && !inFlight) {
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intent, step, slug, link, resolvedStatus, pollStopped, freighterBusy, applyStatus]);

  // Flips the UI to the expired state the moment the countdown hits zero.
  useEffect(() => {
    if (!intent || step !== "pay" || resolvedStatus || !isExpired) return;
    setResolvedStatus({
      status: "expired",
      transaction_id: null,
      expected_usdc_stroops: intent.amount_usdc_stroops,
      received_usdc_stroops: null,
    });
  }, [intent, step, resolvedStatus, isExpired]);

  async function handleCheckPayment() {
    if (!intent) return;
    const paymentId = intent.payment_id;
    setChecking(true);
    setCheckMessage(null);
    try {
      const status = await getPaymentStatus(slug, paymentId);
      if (!applyStatus(paymentId, status)) {
        setCheckMessage(
          "Not received yet — deposits can take a little while to be detected. This page will update automatically once it lands.",
        );
      }
    } catch {
      setCheckMessage("Could not check payment status. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!link) return;
    setSubmitting(true);
    setError(null);
    try {
      // Name and email are required — a payer's identity must be collectible before they pay.
      const missingName = !payerName.trim();
      const missingEmail = !payerEmail.trim();
      if (missingName || missingEmail) {
        setNameInvalid(missingName);
        setEmailInvalid(missingEmail);
        setError("Enter your name and email address.");
        setSubmitting(false);
        return;
      }
      if (!isValidEmail(payerEmail.trim())) {
        setNameInvalid(false);
        setEmailInvalid(true);
        setError("Enter a valid email address.");
        setSubmitting(false);
        return;
      }
      setNameInvalid(false);
      setEmailInvalid(false);
      const amountUsdcStroops =
        link.amount_usdc_stroops ?? usdAmountToStroops(amount);
      if (amountUsdcStroops === null) {
        setError("Enter a valid amount.");
        setSubmitting(false);
        return;
      }
      // Flexible links must respect the min/max bounds; the backend enforces the same limit.
      if (link.amount_usdc_stroops === null) {
        const boundsError = validateFlexibleAmount(amountUsdcStroops, flexibleBounds(link));
        if (boundsError) {
          setError(boundsError);
          setSubmitting(false);
          return;
        }
      }
      // Reuse the intent only if nothing changed; otherwise the deposit address would carry a stale amount.
      const key = intentInputsKey(amountUsdcStroops, payerName.trim(), payerEmail.trim());
      if (intentRef.current && intentRef.current.key === key) {
        setStep("pay");
        return;
      }
      replaceIntent(null);
      const created = await createPaymentIntent(slug, {
        payerName: payerName.trim() || undefined,
        payerEmail: payerEmail.trim() || undefined,
        amountUsdcStroops,
      });
      replaceIntent(created, key);
      setStep("pay");
    } catch (err) {
      setError(errorMessage(err, "Could not start this payment."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFreighterPay() {
    if (!intent) return;
    // Never start a wallet flow against an intent that has already expired.
    if (isExpired) return;
    setFreighterBusy(true);
    setError(null);
    try {
      const freighter = await import("@stellar/freighter-api");
      const access = await freighter.requestAccess();
      if (access.error || !access.address) {
        throw new Error("Could not connect to Freighter. Is it installed and unlocked?");
      }

      // Sequence must be the PAYER's own (it's the tx source), not the merchant's.
      const info = await getPublicSigningInfo(slug, access.address);
      assertNetworkConsistency(info.network_passphrase);
      setNetworkPassphrase(info.network_passphrase);
      const usdc = usdcForNetwork(info.network_passphrase);

      // Verify Freighter is on the same network before touching the transaction.
      const networkDetails = await freighter.getNetworkDetails();
      if (networkDetails.error || networkDetails.networkPassphrase !== info.network_passphrase) {
        const expected = info.network_passphrase.includes("Public")
          ? "Stellar Mainnet"
          : "Stellar Testnet";
        throw new Error(`Switch Freighter to ${expected} and try again.`);
      }
      const unsignedXdr = buildUnsignedPayment(access.address, info, {
        destination: intent.deposit_address,
        amount: formatStroops(intent.amount_usdc_stroops),
        asset: usdc,
      });

      const signed = await freighter.signTransaction(unsignedXdr, {
        networkPassphrase: info.network_passphrase,
        address: access.address,
      });
      if (signed.error || !signed.signedTxXdr) {
        throw new Error("Freighter did not return a signed transaction.");
      }
      assertSignedMatchesBuilt(unsignedXdr, signed.signedTxXdr, info.network_passphrase);

      const result = await submitPublicPayment(slug, signed.signedTxXdr, intent.payment_id);
      if (result.status === "confirmed") {
        markConfirmed(intent.payment_id, result.stellar_tx_hash ?? null, intent.amount_usdc_stroops);
        return;
      }
      throw new Error(
        friendlyResultMessage(result.detail, "The payment could not be confirmed on-chain."),
      );
    } catch (err) {
      setError(errorMessage(err, "Freighter payment failed."));
    } finally {
      setFreighterBusy(false);
    }
  }

  // Inline validation for the flexible amount input.
  const amountStroops = amount.trim() !== "" ? usdAmountToStroops(amount) : null;
  const amountBounds = link ? flexibleBounds(link) : { min: MIN_FLEXIBLE_USD_STROOPS, max: null };
  const amountFormatError = amount.trim() !== "" && amountStroops === null;
  const amountBoundsError =
    amountStroops !== null ? validateFlexibleAmount(amountStroops, amountBounds) : null;
  const amountError = amountFormatError
    ? "Enter an amount in USD, up to 7 decimal places."
    : amountBoundsError;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-white/10 md:grid-cols-2">
        <div className="flex flex-col justify-between bg-black p-8">
          <div className="flex items-center justify-between">
            <Logo />
            {/* Badge is only shown on testnet — on mainnet payers must not see a "Testnet" label. */}
            {network.isTestnet && (
              <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">
                {network.displayName}
              </span>
            )}
          </div>

          {link && (
            <div className="mt-10">
              <p className="text-sm text-muted">Pay {link.name}</p>
              <p className="mt-2 text-4xl font-semibold text-foreground">
                {link.amount_usdc_stroops !== null
                  ? `$${formatStroops(link.amount_usdc_stroops, 2)}`
                  : step !== "form" && intent
                    ? `$${formatStroops(intent.amount_usdc_stroops, 2)}`
                    : parsed.stroops !== null
                    ? `$${formatStroops(parsed.stroops, 2)}`
                    : "$—"}
              </p>
              {link.description && (
                <p className="mt-3 text-sm text-muted">{link.description}</p>
              )}
            </div>
          )}

          {link?.image_url && isTrustedImageUrl(link.image_url) ? (
            <img
              src={link.image_url}
              alt=""
              className="mt-8 aspect-square w-full rounded-2xl object-cover"
            />
          ) : (
            <div className="mt-8 flex aspect-square w-full items-center justify-center rounded-2xl bg-burgundy/10">
              <Logo className="scale-150 opacity-40" />
            </div>
          )}
        </div>

        <div className="bg-white p-8">
          {step === "loading" && (
            <div className="flex h-full items-center justify-center py-12">
              <OctoSpinner size={40} />
            </div>
          )}

          {step === "error" && (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <p className="text-lg font-semibold text-gray-900">Couldn&apos;t load this payment link</p>
                <p className="mt-2 text-sm text-gray-500">Check your connection and try again.</p>
                <button
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                  className="mt-4 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Try again
                </button>
              </div>
            </div>
          )}

          {step === "not-found" && (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <p className="text-lg font-semibold text-gray-900">Link not found</p>
                <p className="mt-2 text-sm text-gray-500">
                  This payment link doesn&apos;t exist or is no longer active.
                </p>
              </div>
            </div>
          )}

          {step === "form" && link && (
            <form onSubmit={handleContinue} className="space-y-5">
              <StepHeader current="Personal Information" />

              {link.amount_usdc_stroops === null && (
                <Field label="Enter Amount" htmlFor="payer-amount">
                  <input
                    id="payer-amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    aria-invalid={amountError !== null}
                    aria-describedby={amountError !== null ? "payer-amount-error" : undefined}
                    placeholder="0.00"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-black"
                  />
                  {amountError !== null && (
                    <p id="payer-amount-error" role="alert" className="mt-1 text-xs text-red-600">
                      {amountError}
                    </p>
                  )}
                </Field>
              )}

              <Field label="Full name" htmlFor="payer-name">
                <input
                  id="payer-name"
                  name="name"
                  autoComplete="name"
                  value={payerName}
                  onChange={(e) => setPayerName(e.target.value)}
                  placeholder="Full name"
                  required
                  aria-required="true"
                  aria-invalid={nameInvalid}
                  aria-describedby="payer-info-hint payer-error"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-black"
                />
              </Field>

              <Field label="Email address" htmlFor="payer-email">
                <input
                  id="payer-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={payerEmail}
                  onChange={(e) => setPayerEmail(e.target.value)}
                  placeholder="Email address"
                  required
                  aria-required="true"
                  aria-invalid={emailInvalid}
                  aria-describedby="payer-info-hint payer-error"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-black"
                />
              </Field>

              <div>
                <p id="payer-info-hint" className="text-[11px] text-gray-500">
                  We use this to send you a confirmation of your payment.
                </p>
                <PayerPrivacyNotice merchantName={link.name} />
              </div>

              {error && <ErrorBanner id="payer-error" message={error} />}

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-black py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting && <OctoSpinner size={16} className="text-white" />}
                {submitting ? "Please wait…" : "Continue"}
              </button>
              <p className="text-center text-[11px] text-gray-400">
                Payments settle on the Stellar network. Octo never asks for your wallet&apos;s
                secret key.
              </p>
            </form>
          )}

          {step === "pay" && intent && resolvedStatus && (
            <MismatchBanner
              status={resolvedStatus}
              onBack={() => {
                // The old intent is permanently resolved — starting over needs a fresh one.
                replaceIntent(null);
                setStep("form");
              }}
            />
          )}

          {step === "pay" && intent && !resolvedStatus && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <StepHeader current="Payment Method" />
                {/* Locked mid-Freighter so the payer can't swap intents under an in-flight tx. */}
                <button
                  type="button"
                  onClick={() => setStep("form")}
                  disabled={freighterBusy}
                  className="text-xs font-medium text-gray-500 hover:text-gray-900 disabled:opacity-50"
                >
                  <span aria-hidden="true">‹ </span>Back
                </button>
              </div>

              {remainingMs !== null && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    remainingMs <= EXPIRY_WARNING_MS
                      ? "border-amber-300 bg-amber-50 text-amber-700"
                      : "border-gray-200 bg-gray-50 text-gray-600"
                  }`}
                >
                  {remainingMs <= EXPIRY_WARNING_MS ? (
                    <>
                      <span aria-hidden="true">⚠️ </span>
                      Less than {formatCountdownMs(remainingMs)} left — complete your payment now
                      or it will expire.
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true">⏳ </span>
                      Time remaining to pay: {formatCountdownMs(remainingMs)}
                    </>
                  )}
                </div>
              )}

              <div className="rounded-lg border border-gray-200 p-4">
                <p className="text-xs text-gray-500">Amount</p>
                <p className="mt-1 text-sm font-medium text-gray-900">
                  ${formatStroops(intent.amount_usdc_stroops, 2)}
                </p>
              </div>

              {/* Deposit address and QR are hidden once expired so nothing can be sent to a dead intent. */}
              {!isExpired && (
              <div>
                <p className="text-sm font-medium text-gray-900">Wallet Transfer</p>
                <p className="mt-1 text-[11px] text-gray-500">
                  Send USDC from any Stellar wallet to the address below.
                </p>
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2">
                  <span className="flex-1 truncate font-mono text-xs text-gray-900">
                    {intent.deposit_address}
                  </span>
                  <CopyButton
                    value={intent.deposit_address}
                    className="text-xs text-gray-500 hover:text-gray-900"
                  />
                </div>
                <div className="mt-3 flex justify-center">
                  <AddressQrCode
                    value={sep7PayUri({
                      destination: intent.deposit_address,
                      amount: formatStroops(intent.amount_usdc_stroops),
                      assetCode: network.usdc.code,
                      assetIssuer: network.usdc.issuer,
                    })}
                    label="Scan with a Stellar wallet to pay the exact amount"
                  />
                </div>
                <p className="mt-2 text-[11px] text-gray-500">
                  Some exchanges don&apos;t support M… addresses; pay from a self-custody wallet.
                </p>
                <button
                  type="button"
                  onClick={handleCheckPayment}
                  disabled={checking}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2 text-xs font-medium text-gray-900 transition-colors hover:border-black disabled:opacity-50"
                >
                  {checking && <OctoSpinner size={14} />}
                  {checking ? "Checking…" : "I've sent the payment — check now"}
                </button>
                {checkMessage && (
                  <p className="mt-2 text-[11px] text-gray-500">{checkMessage}</p>
                )}
              </div>
              )}

              {!isExpired && (
              <div className="flex items-center gap-3 text-[11px] text-gray-400">
                <div className="h-px flex-1 bg-gray-200" />
                OR
                <div className="h-px flex-1 bg-gray-200" />
              </div>
              )}

              {!isExpired && (
              <div>
                <p className="text-sm font-medium text-gray-900">Connect Wallet</p>
                <button
                  type="button"
                  onClick={handleFreighterPay}
                  disabled={freighterBusy}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:border-black disabled:opacity-50"
                >
                  {freighterBusy && <OctoSpinner size={16} />}
                  {freighterBusy ? "Connecting…" : "Connect Freighter"}
                </button>
              </div>
              )}

              {error && <ErrorBanner message={error} />}

              <p className="text-center text-[11px] text-gray-400">
                {pollStopped
                  ? "Stopped checking automatically — use “check now” once you've sent the payment."
                  : "Waiting for payment — this page updates automatically once it's received."}
              </p>
            </div>
          )}

          {step === "confirmed" && (
            <div
              role="status"
              className="flex h-full flex-col items-center justify-center text-center"
            >
              <p className="text-3xl">
                <span aria-hidden="true">✅</span>
                <span className="sr-only">Success</span>
              </p>
              <p className="mt-3 text-lg font-semibold text-gray-900">Payment received</p>
              <p className="mt-2 text-sm text-gray-500">
                Thank you{payerName ? `, ${payerName}` : ""} — your payment has been
                confirmed on-chain.
              </p>

              <div className="mt-5 w-full rounded-lg border border-gray-200 p-4 text-left">
                <p className="text-xs text-gray-500">Receipt</p>
                {confirmedAmountStroops !== null && (
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-gray-500">Amount</span>
                    <span className="font-medium text-gray-900">
                      ${formatStroops(confirmedAmountStroops, 2)}
                    </span>
                  </div>
                )}
                {link && (
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-gray-500">Paid to</span>
                    <span className="font-medium text-gray-900">{link.name}</span>
                  </div>
                )}
                {txRef && (
                  <div className="mt-1 flex items-center justify-between gap-2 text-sm">
                    <span className="shrink-0 text-gray-500">Transaction</span>
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate font-mono text-xs text-gray-900" title={txRef}>
                        {shortenHash(txRef)}
                      </span>
                      <CopyButton
                        value={txRef}
                        className="shrink-0 text-xs text-gray-500 hover:text-gray-900"
                      />
                    </span>
                  </div>
                )}
                {txRef && isStellarTxHash(txRef) && (
                  <a
                    href={explorerTxUrl(txRef)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-block text-xs font-medium text-gray-900 underline hover:no-underline"
                  >
                    View on Stellar Expert ↗
                  </a>
                )}
              </div>

              {returnUrl && (
                <a
                  href={returnUrl}
                  className="mt-4 w-full rounded-lg bg-black py-2.5 text-center text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  Return to merchant
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepHeader({ current }: { current: "Personal Information" | "Payment Method" }) {
  const steps = ["Personal Information", "Payment Method"] as const;
  return (
    <div className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
              s === current
                ? "bg-black text-white"
                : steps.indexOf(current) > i
                  ? "bg-gray-900 text-white"
                  : "bg-gray-200 text-gray-500"
            }`}
          >
            {i + 1}
          </span>
          <span className={s === current ? "font-medium text-gray-900" : "text-gray-400"}>
            {s}
          </span>
          {i === 0 && <span className="mx-1 h-px w-8 bg-gray-200" />}
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-sm font-medium text-gray-900">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function MismatchBanner({
  status,
  onBack,
}: {
  status: PaymentStatus;
  onBack: () => void;
}) {
  const copy = {
    expired: {
      title: "Payment window expired",
      body: "This payment wasn't completed in time. Go back and start again.",
    },
    underpaid: {
      title: "Amount too low",
      body: `You sent $${formatStroops(status.received_usdc_stroops ?? 0)}, but $${formatStroops(status.expected_usdc_stroops)} was expected. Contact the merchant to resolve this.`,
    },
    overpaid: {
      title: "Amount too high",
      body: `You sent $${formatStroops(status.received_usdc_stroops ?? 0)}, but only $${formatStroops(status.expected_usdc_stroops)} was expected. Contact the merchant to resolve this.`,
    },
  }[status.status as "expired" | "underpaid" | "overpaid"];

  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center text-center"
    >
      <p className="text-3xl">
        <span aria-hidden="true">⚠️</span>
        <span className="sr-only">Warning</span>
      </p>
      <p className="mt-3 text-lg font-semibold text-gray-900">{copy.title}</p>
      <p className="mt-2 max-w-xs text-sm text-gray-500">{copy.body}</p>
      <button
        type="button"
        onClick={onBack}
        className="mt-5 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 hover:border-black"
      >
        <span aria-hidden="true">‹ </span>Back
      </button>
    </div>
  );
}

function ErrorBanner({ id, message }: { id?: string; message: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600"
    >
      {message}
    </p>
  );
}