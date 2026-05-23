import { useEffect, useRef, useState } from "react";
import { Logo } from "./components/Logo";
import { InputForm } from "./components/InputForm";
import { PlanCard } from "./components/PlanCard";
import { TerminalTabs, type TabId } from "./components/TerminalTabs";
import { VerdictCard } from "./components/VerdictCard";
import { PixelWardo } from "./components/PixelWardo";
import { streamDiscover, streamVerify } from "./api";
import { loadLastPlan, saveLastPlan } from "./storage";
import type {
  Chain,
  PlanView,
  VerifyEvent,
  VerifyResultPayload,
} from "./types";

interface UnfundedState {
  message: string;
  baseAddress: string | null;
  baseSepoliaAddress: string | null;
}

export function App() {
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState<Chain>("base");

  const [plan, setPlan] = useState<PlanView | null>(null);
  const [unfunded, setUnfunded] = useState<UnfundedState | null>(null);

  const [planEvents, setPlanEvents] = useState<VerifyEvent[]>([]);
  const [verifyEvents, setVerifyEvents] = useState<VerifyEvent[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("plan");

  const [verifyResult, setVerifyResult] = useState<VerifyResultPayload | null>(null);
  const [planStreaming, setPlanStreaming] = useState(false);
  const [verifyStreaming, setVerifyStreaming] = useState(false);

  // Independent AbortControllers so clicking Plan doesn't cancel an in-flight
  // Execute (and vice versa).
  const planAbortRef = useRef<AbortController | null>(null);
  const verifyAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const saved = loadLastPlan();
    if (saved) {
      setAddress(saved.address);
      setChain(saved.chain);
      setPlan(saved.plan);
    }
  }, []);

  useEffect(() => {
    return () => {
      planAbortRef.current?.abort();
      verifyAbortRef.current?.abort();
    };
  }, []);

  function appendPlan(e: VerifyEvent) {
    setPlanEvents((prev) => [...prev, e]);
  }
  function appendVerify(e: VerifyEvent) {
    setVerifyEvents((prev) => [...prev, e]);
  }

  async function handlePlan() {
    setUnfunded(null);
    setPlan(null);
    setPlanEvents([]);
    setActiveTab("plan");

    planAbortRef.current?.abort();
    const ctl = new AbortController();
    planAbortRef.current = ctl;
    setPlanStreaming(true);

    try {
      await streamDiscover(address.trim(), (e) => {
        appendPlan(e);
        if (e.type === "plan") {
          setPlan({
            services: e.services,
            totalEstimatedCostUsdc: e.totalEstimatedCostUsdc,
            walletNetwork: e.walletNetwork,
            unresolvedCategories: e.unresolvedCategories ?? [],
          });
        }
        if (e.type === "error" && e.code === "wallet_unfunded") {
          // Parse address tuple from the message? Backend doesn't ship them in
          // the SSE error frame. Surface the message in the log; no panel.
        }
      }, ctl.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      appendPlan({
        type: "error",
        code: "client_error",
        message: (e as Error).message,
        at: new Date().toISOString(),
      });
    } finally {
      if (planAbortRef.current === ctl) {
        setPlanStreaming(false);
        planAbortRef.current = null;
      }
    }
  }

  async function handleExecute() {
    setVerifyResult(null);
    setVerifyEvents([]);
    setActiveTab("verify");

    verifyAbortRef.current?.abort();
    const ctl = new AbortController();
    verifyAbortRef.current = ctl;
    setVerifyStreaming(true);

    try {
      await streamVerify(address.trim(), chain, (e) => {
        appendVerify(e);
        if (e.type === "result") setVerifyResult(e.payload);
      }, ctl.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      appendVerify({
        type: "error",
        code: "client_error",
        message: (e as Error).message,
        at: new Date().toISOString(),
      });
    } finally {
      if (verifyAbortRef.current === ctl) {
        setVerifyStreaming(false);
        verifyAbortRef.current = null;
      }
    }
  }

  function handleSavePlan() {
    if (!plan) return;
    saveLastPlan({
      address: address.trim(),
      chain,
      plan,
      savedAt: new Date().toISOString(),
    });
  }

  const showTerminal =
    planEvents.length > 0 ||
    verifyEvents.length > 0 ||
    planStreaming ||
    verifyStreaming;

  return (
    <div className="app">
      <Logo />

      <InputForm
        address={address}
        chain={chain}
        busy={planStreaming || verifyStreaming}
        running={planStreaming || verifyStreaming}
        onAddressChange={setAddress}
        onChainChange={setChain}
        onPlan={handlePlan}
        onExecute={handleExecute}
      />

      {unfunded && (
        <div className="error-panel" data-testid="unfunded-panel">
          <h3>Wallet unfunded</h3>
          <div>{unfunded.message}</div>
          <div style={{ marginTop: 8 }}>
            <div className="addr"><strong>base:</strong> {unfunded.baseAddress ?? "(unknown)"}</div>
            <div className="addr"><strong>base-sepolia:</strong> {unfunded.baseSepoliaAddress ?? "(unknown)"}</div>
          </div>
        </div>
      )}

      {plan && <PlanCard plan={plan} onSave={handleSavePlan} />}

      {showTerminal && (
        <>
          <PixelWardo active={planStreaming || verifyStreaming} />
          <TerminalTabs
            active={activeTab}
            onChange={setActiveTab}
            planEvents={planEvents}
            verifyEvents={verifyEvents}
            planStreaming={planStreaming}
            verifyStreaming={verifyStreaming}
          />
        </>
      )}

      {verifyResult && <VerdictCard result={verifyResult} />}
    </div>
  );
}
