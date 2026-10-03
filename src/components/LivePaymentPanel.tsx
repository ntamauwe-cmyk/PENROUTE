import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/pension-ui";
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { fmtNaira } from "@/lib/pension";
import { toast } from "sonner";

/**
 * Live-rail payment flow (plug-and-play, spec §38):
 *  1. payBatch → { requiresCheckout } → we initialize with Paystack
 *  2. Employer completes payment in the Paystack window
 *  3. "I've completed payment" → verify → finalize → pipeline runs
 * The batch NEVER shows successful until Paystack itself confirms.
 */
export function LivePaymentPanel({
  batchId,
  amountKobo,
  payerEmail,
  onPaid,
}: {
  batchId: Id<"contributionBatches">;
  amountKobo: number;
  payerEmail: string;
  onPaid: () => void;
}) {
  const initialize = useAction(api.payments.initializeLivePayment);
  const verify = useAction(api.payments.verifyLivePayment);
  const finalize = useMutation(api.engine.finalizeLivePayment);
  const markFailed = useMutation(api.engine.markLivePaymentFailed);
  const context = useQuery(api.engine.getLivePaymentContext, { batchId });

  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);

  const paymentRef = context?.paymentRef ?? null;
  const expectedKobo = context?.expectedKobo ?? amountKobo;

  const startCheckout = async () => {
    if (!paymentRef) return;
    setStarting(true);
    try {
      const res = await initialize({
        paymentRef,
        amountKobo: expectedKobo,
        email: context?.payerEmail ?? payerEmail,
      });
      if (res.accepted && res.authorizationUrl) {
        setCheckoutUrl(res.authorizationUrl);
        window.open(res.authorizationUrl, "_blank", "noopener");
        toast.info("Complete the payment in the Paystack window, then click \"I've completed payment\".");
      } else {
        toast.error(res.reason ?? "Could not start the payment");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payment initialization failed");
    } finally {
      setStarting(false);
    }
  };

  const checkPayment = async () => {
    if (!paymentRef) return;
    setChecking(true);
    try {
      const res = await verify({ paymentRef });
      if (!res.ok) {
        toast.error(res.reason ?? "Verification failed");
        return;
      }
      if (res.outcome === "success") {
        // Amount check — never finalize an under/over payment silently
        if (res.amountKobo < expectedKobo) {
          await markFailed({
            batchId,
            reason: `Verified amount ${fmtNaira(res.amountKobo)} is less than expected ${fmtNaira(expectedKobo)}`,
          });
          toast.error("Payment amount mismatch — an exception was recorded.");
          return;
        }
        await finalize({ batchId, providerFeesKobo: res.providerFeesKobo });
        toast.success("Payment verified — processing contributions");
        onPaid();
      } else if (res.outcome === "failed" || res.outcome === "abandoned") {
        await markFailed({ batchId, reason: `Paystack reports ${res.outcome}` });
        toast.error(`Payment ${res.outcome} — exception recorded`);
      } else {
        toast.info("Payment not completed yet — finish in the Paystack window and try again.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setChecking(false);
    }
  };

  // Poll every 6s while a checkout window is open (auto-detect completion)
  useEffect(() => {
    if (!checkoutUrl) return;
    const t = setInterval(() => {
      if (!checking) void checkPayment();
    }, 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutUrl, checking, paymentRef]);

  return (
    <div className="pen-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold tracking-tight">Complete your payment</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {fmtNaira(expectedKobo)} · secured by Paystack · your contribution processes
            automatically once the payment is verified.
          </p>
        </div>
        <StatusPill status="initiated" pulse />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {!checkoutUrl ? (
          <Button className="font-semibold" onClick={startCheckout} disabled={starting || !paymentRef}>
            {starting ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
            Pay {fmtNaira(expectedKobo)}
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => window.open(checkoutUrl, "_blank", "noopener")}>
              <ExternalLink className="size-4" /> Reopen payment window
            </Button>
            <Button className="font-semibold" onClick={checkPayment} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              I've completed payment
            </Button>
          </>
        )}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <RefreshCw className="size-3" /> We check automatically every few seconds while the payment
        window is open.
      </p>
    </div>
  );
}
