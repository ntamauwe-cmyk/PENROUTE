import { Link } from "react-router";
import { Logo } from "@/components/Brand";
import { SUPPORT_EMAIL, TERMS_VERSION } from "@/lib/legal";
import type { ReactNode } from "react";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F7F9F8]">
      <header className="border-b border-[#E5E9EC] bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" aria-label="Penroute home">
            <Logo size="sm" />
          </Link>
          <nav className="flex gap-4 text-sm font-semibold text-[#007A4D]">
            <Link to="/terms" className="hover:underline">Terms</Link>
            <Link to="/privacy" className="hover:underline">Privacy</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <article className="pen-card-lg space-y-5 p-6 text-[15px] leading-relaxed text-[#2A3B44] sm:p-10 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-[#0B1F2A] [&_li]:ml-5 [&_li]:list-disc">
          <h1 className="text-2xl font-bold tracking-tight text-[#0B1F2A] sm:text-3xl">{title}</h1>
          <p className="text-sm text-[#5A6B74]">Version {TERMS_VERSION}</p>
          {children}
          <p className="pt-4 text-sm">
            Questions: <a className="font-semibold text-[#007A4D]" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
          </p>
        </article>
      </main>
    </div>
  );
}

export function TermsPage() {
  return (
    <Shell title="Terms of Service">
      <p>
        These terms govern use of Penroute (penroute.net) by employers, their authorised users, and
        Pension Fund Administrator (PFA) operators. By registering a company or using the platform you
        accept them on behalf of the organisation you represent.
      </p>
      <h2>1. What Penroute does</h2>
      <p>
        Penroute is a pension-contribution processing service. It lets an employer upload a monthly
        contribution schedule, pay the total in one payment, and track remittance of each employee's
        contribution to the PFA that holds that employee's Retirement Savings Account (RSA). Penroute is
        not a PFA or a Pension Fund Custodian, does not manage or invest pension assets, and does not give
        pension, tax or investment advice.
      </p>
      <h2>2. How money moves</h2>
      <ul>
        <li>Card and bank payments are processed by Paystack, a licensed payment service provider. Penroute never sees or stores card details.</li>
        <li>Contributions received are held only for onward remittance to the relevant PFAs, and are recorded separately from Penroute's processing fee in a double-entry ledger.</li>
        <li>A contribution is shown as posted only after the receiving PFA confirms it. Until then it is shown as pending.</li>
        <li>Penroute's processing fee is shown before you pay and is charged in the same payment. Fees on a confirmed payment are non-refundable except where Penroute made an error.</li>
      </ul>
      <h2>3. Employer responsibilities</h2>
      <ul>
        <li>Provide accurate company (KYB) information and documents. Accounts are approved by Penroute before payments are accepted.</li>
        <li>Ensure each employee's name, RSA PIN, PFA and contribution amounts are correct. Penroute validates format but cannot verify amounts against your payroll.</li>
        <li>Remain responsible for your obligations under the Pension Reform Act 2014, including the deadline for remitting contributions. Allow time for payment confirmation and PFA posting.</li>
        <li>Keep sign-in access and payroll API keys secure, and revoke keys that may be exposed.</li>
      </ul>
      <h2>4. Errors, failed payments and exceptions</h2>
      <p>
        Invalid schedule rows are flagged and are not paid. If a payment fails, nothing is remitted and you
        may retry. If a PFA rejects a contribution or amounts do not reconcile, Penroute raises an
        exception and works with you and the PFA to correct or refund it.
      </p>
      <h2>5. Suspension</h2>
      <p>
        Penroute may suspend an account that provides false information, is suspected of fraud, or where
        required by law or a regulator. Payments already confirmed continue to be remitted.
      </p>
      <h2>6. Liability</h2>
      <p>
        Penroute is responsible for processing confirmed payments according to your schedule. It is not
        liable for losses caused by inaccurate schedule data you provide, or by delays at payment
        providers, banks or PFAs outside its control. Nothing in these terms limits liability that cannot
        be limited under Nigerian law.
      </p>
      <h2>7. Changes and governing law</h2>
      <p>
        We will notify registered employers of material changes before they take effect. These terms are
        governed by the laws of the Federal Republic of Nigeria.
      </p>
    </Shell>
  );
}

export function PrivacyPage() {
  return (
    <Shell title="Privacy Notice">
      <p>
        This notice explains how Penroute processes personal data under the Nigeria Data Protection Act
        2023. For employee data in contribution schedules, the employer is the data controller and
        Penroute processes it on the employer's instructions.
      </p>
      <h2>Data we process</h2>
      <ul>
        <li>Account data: name and email address of each signed-in user, and sign-in records.</li>
        <li>Company (KYB) data: company name, RC number, TIN, address, representative and phone, and documents you upload.</li>
        <li>Employee pension data: name, employee ID, RSA PIN, PFA and contribution amounts.</li>
        <li>Payment data: amounts, references and status returned by Paystack. Card details are handled by Paystack, not Penroute.</li>
        <li>Audit records of actions taken in the platform.</li>
      </ul>
      <h2>Why we use it</h2>
      <ul>
        <li>To verify employers, process and reconcile contributions, and remit them to PFAs (contract).</li>
        <li>To keep financial and audit records and respond to regulators (legal obligation).</li>
        <li>To prevent fraud and secure the service (legitimate interest).</li>
      </ul>
      <h2>Who receives it</h2>
      <p>
        The PFA of each employee (that employee's contribution data only), Paystack (payment data),
        our hosting providers, and regulators or law-enforcement bodies where the law requires. We do not
        sell personal data or use it for advertising.
      </p>
      <h2>Retention and security</h2>
      <p>
        Financial and audit records are kept for as long as pension and tax law requires; other data is
        deleted when no longer needed. Data is encrypted in transit, access is restricted by role, and
        every change to financial records is logged.
      </p>
      <h2>Your rights</h2>
      <p>
        You may ask to access, correct or delete your personal data, object to processing, or ask for a
        copy in a portable format, subject to records we must keep by law. Employees should normally
        contact their employer first. You may also complain to the Nigeria Data Protection Commission.
      </p>
    </Shell>
  );
}
