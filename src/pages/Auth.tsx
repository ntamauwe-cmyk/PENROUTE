import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Logo, PenrouteSymbol, RouteLines } from "@/components/Brand";
import { useAuth } from "@/hooks/use-auth";
import { ArrowRight, Building2, Loader2, Mail, ShieldCheck } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(searchParams.get("returnTo"), redirectAfterAuth);
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      setStep({ email: formData.get("email") as string });
      setIsLoading(false);
    } catch (error) {
      console.error("Email sign-in error:", error);
      setError(
        error instanceof Error
          ? error.message
          : "Failed to send verification code. Please try again.",
      );
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      navigate(redirect);
    } catch (error) {
      console.error("OTP verification error:", error);
      setError("The verification code you entered is incorrect.");
      setIsLoading(false);
      setOtp("");
    }
  };

  // Demo workspace = development convenience. Production builds require a
  // real sign-in; the button only renders in dev (spec §24: production is
  // authenticated access only).
  const showDemoEntry = import.meta.env.DEV;

  const handleDemoLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect);
    } catch (error) {
      console.error("Demo login error:", error);
      setError(
        `Could not start the demo: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-[#F7F9F8]">
      {/* ===== Left: navy brand panel (premium split-screen) ===== */}
      <aside className="pen-nav relative hidden w-[46%] flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
        <RouteLines />
        <div className="relative">
          <button onClick={() => navigate("/")} aria-label="Penroute home">
            <Logo onDark size="md" tagline />
          </button>
        </div>
        <div className="relative">
          <span className="pen-gold-rule" />
          <h2 className="mt-6 max-w-md text-3xl font-bold leading-snug text-white xl:text-4xl">
            A stronger pension system builds a brighter{" "}
            <span className="text-[#00C896]">Nigeria</span>.
          </h2>
          <p className="mt-4 text-sm font-semibold uppercase tracking-[0.22em] text-white/50">
            Employers. Employees. Pension Funds. United.
          </p>
        </div>
        <div className="relative flex items-center gap-3 text-xs text-white/45">
          <ShieldCheck className="size-4 text-[#00C896]" />
          Secure employer sign-in · Protected by session encryption
        </div>
      </aside>

      {/* ===== Right: login card ===== */}
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-md flex-col">
          {/* Mobile logo */}
          <button className="mb-8 self-center lg:hidden" onClick={() => navigate("/")}>
            <Logo size="md" tagline />
          </button>

          <div className="pen-card-lg p-7 shadow-[0_18px_55px_-30px_rgb(11_31_42_/_0.28)] sm:p-8">
            {step === "signIn" ? (
              <>
                <div className="flex items-center gap-3">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-[#E6F6EF]">
                    <PenrouteSymbol className="size-6" />
                  </span>
                  <div>
                    <h1 className="text-xl font-bold tracking-tight text-[#0B1F2A]">
                      Welcome back
                    </h1>
                    <p className="text-[13px] text-[#5A6B74]">
                      Sign in to your Penroute workspace
                    </p>
                  </div>
                </div>

                <form onSubmit={handleEmailSubmit} className="mt-7">
                  <label
                    htmlFor="pen-email"
                    className="text-xs font-bold uppercase tracking-wide text-[#0B1F2A]"
                  >
                    Email address
                  </label>
                  <div className="relative mt-2">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8299A5]" />
                    <Input
                      id="pen-email"
                      name="email"
                      placeholder="name@company.com"
                      type="email"
                      className="h-11 pl-9"
                      autoComplete="email"
                      disabled={isLoading}
                      required
                    />
                  </div>
                  {error && <p className="mt-2 text-sm text-[#C4453C]">{error}</p>}

                  <Button
                    type="submit"
                    className="mt-5 h-11 w-full bg-[#007A4D] font-semibold hover:bg-[#006A43]"
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" /> Sending code…
                      </>
                    ) : (
                      <>
                        Continue <ArrowRight className="ml-1.5 size-4" />
                      </>
                    )}
                  </Button>
                </form>

                {showDemoEntry && (
                  <>
                    <div className="mt-5 flex items-center gap-3">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-[#8299A5]">
                        Or
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      className="mt-4 h-11 w-full border-[#0B1F2A]/20 font-semibold text-[#0B1F2A] hover:bg-[#F0F4F4]"
                      onClick={handleDemoLogin}
                      disabled={isLoading}
                    >
                      <Building2 className="mr-2 size-4" />
                      Explore the demo workspace
                    </Button>
                  </>
                )}

                <p className="mt-5 text-center text-xs leading-relaxed text-[#5A6B74]">
                  New to Penroute? Just sign in with your work email — your workspace is created
                  on first sign-in.
                </p>
              </>
            ) : (
              <>
                <h1 className="text-xl font-bold tracking-tight text-[#0B1F2A]">
                  Check your email
                </h1>
                <p className="mt-1 text-sm text-[#5A6B74]">
                  We sent a 6-digit code to <span className="font-semibold">{step.email}</span>
                </p>
                <form onSubmit={handleOtpSubmit}>
                  <input type="hidden" name="email" value={step.email} />
                  <input type="hidden" name="code" value={otp} />

                  <div className="mt-6 flex justify-center">
                    <InputOTP
                      value={otp}
                      onChange={setOtp}
                      maxLength={6}
                      disabled={isLoading}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && otp.length === 6 && !isLoading) {
                          const form = (e.target as HTMLElement).closest("form");
                          if (form) {
                            form.requestSubmit();
                          }
                        }
                      }}
                    >
                      <InputOTPGroup>
                        {Array.from({ length: 6 }).map((_, index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  {error && (
                    <p className="mt-3 text-center text-sm text-[#C4453C]">{error}</p>
                  )}

                  <Button
                    type="submit"
                    className="mt-6 h-11 w-full bg-[#007A4D] font-semibold hover:bg-[#006A43]"
                    disabled={isLoading || otp.length !== 6}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" /> Verifying…
                      </>
                    ) : (
                      <>
                        Verify code <ArrowRight className="ml-1.5 size-4" />
                      </>
                    )}
                  </Button>
                  <button
                    type="button"
                    className="mt-4 w-full text-center text-xs font-semibold text-[#007A4D] hover:underline"
                    onClick={() => setStep("signIn")}
                    disabled={isLoading}
                  >
                    Use a different email
                  </button>
                </form>
              </>
            )}
          </div>

          <p className="mt-6 text-center text-[11px] leading-relaxed text-[#8299A5]">
            Securing pension contributions for Nigerian employers.
          </p>
        </div>
      </main>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
