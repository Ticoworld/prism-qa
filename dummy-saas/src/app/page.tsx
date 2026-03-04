"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// Step data
// ---------------------------------------------------------------------------
type Step = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Step 1 — Registration
// ---------------------------------------------------------------------------
function StepRegistration({ onNext }: { onNext: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@")) { setError("Please enter a valid email address."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    setError("");
    onNext(email);
  }

  return (
    <form id="registration-form" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: "#0f0f0f" }}>
          Create your account
        </h1>
        <p style={{ fontSize: 13, color: "#64748b" }}>
          Start your 14-day free trial. No credit card required.
        </p>
      </div>

      {error && (
        <div id="form-error" style={{
          background: "#fef2f2", border: "1px solid #fecaca",
          borderRadius: 6, padding: "10px 12px",
          fontSize: 13, color: "#dc2626",
        }}>
          {error}
        </div>
      )}

      <div className="field">
        <label htmlFor="email">Email Address</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          required
        />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Minimum 6 characters"
          autoComplete="new-password"
          required
        />
      </div>

      <button id="create-account-btn" type="submit" className="btn-primary">
        Create Account →
      </button>

      <p style={{ fontSize: 12, color: "#94a3b8", textAlign: "center" }}>
        By continuing, you agree to our{" "}
        <span style={{ color: "#6366f1", cursor: "pointer" }}>Terms of Service</span>
        {" "}and{" "}
        <span style={{ color: "#6366f1", cursor: "pointer" }}>Privacy Policy</span>.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Workspace Setup
// ---------------------------------------------------------------------------
function StepWorkspace({ email, onNext }: { email: string; onNext: () => void }) {
  const [company, setCompany] = useState("");
  const [size, setSize] = useState("");
  const [error, setError] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) { setError("Company name is required."); return; }
    if (!size) { setError("Please select your team size."); return; }
    setError("");
    onNext();
  }

  return (
    <form id="workspace-form" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: "#0f0f0f" }}>
          Set up your workspace
        </h1>
        <p style={{ fontSize: 13, color: "#64748b" }}>
          Setting up for <strong style={{ color: "#0f0f0f" }}>{email}</strong>
        </p>
      </div>

      {error && (
        <div id="workspace-error" style={{
          background: "#fef2f2", border: "1px solid #fecaca",
          borderRadius: 6, padding: "10px 12px",
          fontSize: 13, color: "#dc2626",
        }}>
          {error}
        </div>
      )}

      <div className="field">
        <label htmlFor="company-name">Company Name</label>
        <input
          id="company-name"
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Acme Corp"
          required
        />
      </div>

      <div className="field">
        <label htmlFor="team-size">Team Size</label>
        <select
          id="team-size"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          required
        >
          <option value="" disabled>Select team size...</option>
          <option value="solo">Just me</option>
          <option value="2-10">2 – 10 people</option>
          <option value="11-50">11 – 50 people</option>
          <option value="51-200">51 – 200 people</option>
          <option value="201+">201+ people</option>
        </select>
      </div>

      <button id="continue-btn" type="submit" className="btn-primary">
        Continue to Dashboard →
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Dashboard / Success
// ---------------------------------------------------------------------------
function StepDashboard({ email, onReset }: { email: string; onReset: () => void }) {
  return (
    <div id="success-screen" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, textAlign: "center" }}>
      {/* Checkmark */}
      <div
        className="success-icon"
        style={{
          width: 64, height: 64, borderRadius: "50%",
          background: "#ecfdf5", border: "2px solid #6ee7b7",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      <div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0f0f0f", marginBottom: 6 }}>
          Welcome to Nexus!
        </h1>
        <p style={{ fontSize: 14, color: "#64748b", maxWidth: 320 }}>
          Your workspace is ready. You&apos;re signed in as <strong style={{ color: "#0f0f0f" }}>{email}</strong>.
        </p>
      </div>

      {/* Mock dashboard metrics */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3,1fr)",
        gap: 12, width: "100%", marginTop: 8,
      }}>
        {[
          { label: "Projects", value: "0", id: "metric-projects" },
          { label: "Team Members", value: "1", id: "metric-members" },
          { label: "Days Left", value: "14", id: "metric-days" },
        ].map((m) => (
          <div key={m.id} id={m.id} style={{
            background: "#f8fafc", border: "1px solid #e2e8f0",
            borderRadius: 8, padding: "14px 10px", textAlign: "center",
          }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#0f0f0f" }}>{m.value}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</div>
          </div>
        ))}
      </div>

      <button
        id="new-test-btn"
        onClick={onReset}
        style={{
          marginTop: 8,
          padding: "10px 24px",
          background: "#fff",
          border: "1.5px solid #e2e8f0",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          color: "#64748b",
          cursor: "pointer",
          transition: "border-color 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "#6366f1";
          e.currentTarget.style.color = "#6366f1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "#e2e8f0";
          e.currentTarget.style.color = "#64748b";
        }}
      >
        ← Start new registration
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root page
// ---------------------------------------------------------------------------
export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [email, setEmail] = useState("");

  function handleRegistration(submittedEmail: string) {
    setEmail(submittedEmail);
    setStep(2);
  }
  function handleWorkspace() { setStep(3); }
  function handleReset() { setEmail(""); setStep(1); }

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 28, display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 32, height: 32, background: "#6366f1", borderRadius: 8,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
        <span style={{ fontSize: 18, fontWeight: 700, color: "#0f0f0f", letterSpacing: "-0.02em" }}>
          Nexus
        </span>
      </div>

      {/* Card */}
      <div className="card" style={{ width: "100%", maxWidth: 420 }}>
        {/* Step progress */}
        {step !== 3 && (
          <div className="steps">
            {[1, 2, 3].map((s, i) => (
              <span key={s} style={{ display: "contents" }}>
                <div
                  className={`step-dot ${s < step ? "step-dot--done" : s === step ? "step-dot--active" : ""}`}
                >
                  {s < step ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : s}
                </div>
                {i < 2 && (
                  <div className={`step-line ${s < step ? "step-line--done" : ""}`} />
                )}
              </span>
            ))}
          </div>
        )}

        {step === 1 && <StepRegistration onNext={handleRegistration} />}
        {step === 2 && <StepWorkspace email={email} onNext={handleWorkspace} />}
        {step === 3 && <StepDashboard email={email} onReset={handleReset} />}
      </div>

      {/* Footer */}
      <p style={{ marginTop: 20, fontSize: 12, color: "#94a3b8" }}>
        © 2026 Nexus Inc. — Prism QA demo target
      </p>
    </div>
  );
}
