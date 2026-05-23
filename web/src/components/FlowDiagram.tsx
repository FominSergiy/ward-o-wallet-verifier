import { useFlowState, type NodeStatus, type CategoryNode, type DirectNode } from "../hooks/useFlowState";
import type { Category, VerdictLabel, VerifyEvent } from "../types";
import "./FlowDiagram.css";

interface Props {
  events: VerifyEvent[];
}

const VIEW_W = 760;
const VIEW_H = 520;

const ORIGIN = { x: 70, y: VIEW_H / 2 };
const CATEGORY_X = 220;
const PAYMENT_X = 380;
const FALLBACK_X = 490;
const SYNTH_X = 600;
const VERDICT_X = 710;

// Direct nodes hang under the payment diamond. Vertical offset from the row's
// baseline Y to the center of the first direct circle.
const DIRECT_DY = 22;
const DIRECT_R = 7;
const DIRECT_SPACING = 26;

const CATEGORY_LABELS: Record<Category, string> = {
  sanctions: "sanctions",
  labels: "labels",
  onchain_history: "on_chain",
  web_sentiment: "web_sent",
  ens: "ens",
  contract_analysis: "contract",
};

const VERDICT_DISPLAY: Record<VerdictLabel, { text: string; cls: string }> = {
  safe_to_transact: { text: "SAFE", cls: "safe" },
  do_not_transact: { text: "RISKY", cls: "risky" },
  insufficient_data: { text: "UNCLEAR", cls: "insufficient_data" },
};

function categoryY(i: number, n: number): number {
  if (n <= 1) return VIEW_H / 2;
  const top = 60;
  const bot = VIEW_H - 80;
  return top + ((bot - top) * i) / (n - 1);
}

function statusClass(s: NodeStatus): string {
  return s;
}

function edgeClassFor(from: NodeStatus, to: NodeStatus): string {
  if (from === "error" || to === "error") return "error";
  if (from === "ok" && (to === "ok" || to === "active")) return "ok";
  if (from === "ok" || from === "active" || to === "active" || to === "ok") return "lit";
  return "";
}

function fmtUsd(v?: number): string {
  if (v == null) return "—";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(3)}`;
}

function DirectNodes({ direct, y }: { direct: DirectNode[]; y: number }) {
  if (direct.length === 0) return null;
  const total = direct.length;
  const span = (total - 1) * DIRECT_SPACING;
  const startX = PAYMENT_X - span / 2;
  const cy = y + DIRECT_DY;

  return (
    <g>
      <text className="direct-row-tag" x={startX - 14} y={cy}>
        direct
      </text>
      {direct.map((d, i) => {
        const cx = startX + i * DIRECT_SPACING;
        const title = d.error ? `${d.label}: ${d.error}` : d.label;
        return (
          <g key={d.resource}>
            <title>{title}</title>
            <circle
              className={`direct-node ${statusClass(d.status)}`}
              cx={cx}
              cy={cy}
              r={DIRECT_R}
            />
            <text className="direct-label" x={cx} y={cy + DIRECT_R + 8}>
              {d.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function CategoryRow({
  cat,
  node,
  y,
  originStatus,
  synthStatus,
}: {
  cat: Category;
  node: CategoryNode;
  y: number;
  originStatus: NodeStatus;
  synthStatus: NodeStatus;
}) {
  const label = CATEGORY_LABELS[cat] ?? cat;
  const hasX402 = node.primary.resource !== "";
  const primaryStatus = node.primary.status;
  const fallbackStatus = node.fallback?.status ?? "idle";

  const edgeOriginToCat = edgeClassFor(originStatus, node.status);
  const edgeCatToPay = hasX402 ? edgeClassFor(node.status, primaryStatus) : "";
  let edgePayToSynth = hasX402 ? edgeClassFor(primaryStatus, synthStatus) : "";
  if (hasX402 && primaryStatus === "error" && !node.fallback) edgePayToSynth = "error";

  const edgePayToFallback = node.fallback ? "fallback" : "";
  const edgeFallbackToSynth = node.fallback
    ? fallbackStatus === "ok"
      ? "ok"
      : fallbackStatus === "error"
      ? "error"
      : "lit"
    : "";

  const edgeCatToSynthDirect =
    !hasX402 && node.direct.length > 0
      ? edgeClassFor(node.status, synthStatus)
      : "";

  const synthIn = { x: SYNTH_X - 22, y: VIEW_H / 2 };

  const payPrice = node.primary.amountUsdc ?? node.primary.priceUsdc;
  const fallbackPrice = node.fallback?.amountUsdc ?? node.fallback?.priceUsdc;

  return (
    <g>
      {/* origin → category */}
      <path
        className={`edge ${edgeOriginToCat}`}
        d={`M ${ORIGIN.x + 38} ${ORIGIN.y} C ${(ORIGIN.x + CATEGORY_X) / 2} ${ORIGIN.y}, ${
          (ORIGIN.x + CATEGORY_X) / 2
        } ${y}, ${CATEGORY_X - 50} ${y}`}
      />
      {/* category node (rect) */}
      <rect
        className={`node-shape ${statusClass(node.status)}`}
        x={CATEGORY_X - 50}
        y={y - 16}
        width={100}
        height={32}
        rx={6}
      />
      <text className="node-label" x={CATEGORY_X} y={y}>{label}</text>

      {hasX402 && (
        <>
          {/* category → payment */}
          <path
            className={`edge ${edgeCatToPay}`}
            d={`M ${CATEGORY_X + 50} ${y} L ${PAYMENT_X - 24} ${y}`}
          />
          {/* payment diamond */}
          <g transform={`translate(${PAYMENT_X}, ${y})`}>
            <polygon
              className={`node-shape ${statusClass(primaryStatus)}`}
              points="-26,0 0,-18 26,0 0,18"
            />
            <text className="node-label" y={-2} style={{ fontSize: 9 }}>x402</text>
            <text
              className={`node-sublabel ${primaryStatus === "ok" ? "ok" : primaryStatus === "error" ? "error" : ""}`}
              y={9}
            >
              {fmtUsd(payPrice)}
            </text>
          </g>

          {node.fallback && (
            <>
              <path
                className={`edge ${edgePayToFallback}`}
                d={`M ${PAYMENT_X + 24} ${y} Q ${(PAYMENT_X + FALLBACK_X) / 2} ${y - 28}, ${FALLBACK_X - 22} ${y - 14}`}
              />
              <g transform={`translate(${FALLBACK_X}, ${y - 18})`}>
                <polygon
                  className={`node-shape ${statusClass(fallbackStatus === "idle" ? "fallback" : fallbackStatus)}`}
                  points="-22,0 0,-15 22,0 0,15"
                />
                <text className="node-label" y={-2} style={{ fontSize: 8 }}>fallback</text>
                <text
                  className={`node-sublabel ${fallbackStatus === "ok" ? "ok" : fallbackStatus === "error" ? "error" : ""}`}
                  y={8}
                >
                  {fmtUsd(fallbackPrice)}
                </text>
              </g>
              <path
                className={`edge ${edgeFallbackToSynth}`}
                d={`M ${FALLBACK_X + 20} ${y - 18} C ${(FALLBACK_X + SYNTH_X) / 2} ${y - 18}, ${
                  (FALLBACK_X + SYNTH_X) / 2
                } ${synthIn.y}, ${synthIn.x} ${synthIn.y}`}
              />
            </>
          )}

          {/* payment → synth (curved into synth center) */}
          <path
            className={`edge ${edgePayToSynth}`}
            d={`M ${PAYMENT_X + 26} ${y} C ${(PAYMENT_X + SYNTH_X) / 2} ${y}, ${
              (PAYMENT_X + SYNTH_X) / 2
            } ${synthIn.y}, ${synthIn.x} ${synthIn.y}`}
          />
        </>
      )}

      {/* Direct chain-primitive nodes (oracle per chain, viem, ens). */}
      <DirectNodes direct={node.direct} y={y} />

      {/* If there's no x402 path, draw a single edge from the category node
          straight to the synth circle so the direct paths still visually
          contribute to the synth ingestion. */}
      {!hasX402 && node.direct.length > 0 && (
        <path
          className={`edge ${edgeCatToSynthDirect}`}
          d={`M ${CATEGORY_X + 50} ${y} C ${(CATEGORY_X + SYNTH_X) / 2} ${y}, ${
            (CATEGORY_X + SYNTH_X) / 2
          } ${synthIn.y}, ${synthIn.x} ${synthIn.y}`}
        />
      )}
    </g>
  );
}

export function FlowDiagram({ events }: Props) {
  const state = useFlowState(events);
  const cats = state.categoryOrder;
  const n = cats.length;
  const synthToVerdict = edgeClassFor(state.synthesize, state.verdict.status);
  const verdictDisplay = state.verdict.label ? VERDICT_DISPLAY[state.verdict.label] : null;

  return (
    <div className="flow-diagram" data-testid="flow-diagram">
      {events.length === 0 ? (
        <div className="empty">waiting for events…</div>
      ) : (
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet">
          {/* origin */}
          <g>
            <circle
              className={`node-shape ${statusClass(state.origin)}`}
              cx={ORIGIN.x}
              cy={ORIGIN.y}
              r={36}
            />
            <text className="node-label" x={ORIGIN.x} y={ORIGIN.y - 4}>verify</text>
            <text className="node-label muted" x={ORIGIN.x} y={ORIGIN.y + 10} style={{ fontSize: 9 }}>
              agent
            </text>
          </g>

          {n === 0 && (
            <text className="node-label muted" x={VIEW_W / 2} y={VIEW_H / 2}>
              discovering services…
            </text>
          )}

          {cats.map((cat, i) => {
            const node = state.categories[cat];
            if (!node) return null;
            return (
              <CategoryRow
                key={cat}
                cat={cat}
                node={node}
                y={categoryY(i, n)}
                originStatus={state.origin}
                synthStatus={state.synthesize}
              />
            );
          })}

          {/* synthesize */}
          <g>
            <circle
              className={`node-shape ${statusClass(state.synthesize)}`}
              cx={SYNTH_X}
              cy={VIEW_H / 2}
              r={26}
            />
            <text className="node-label" x={SYNTH_X} y={VIEW_H / 2 - 2}>synth</text>
            <text className="node-label muted" x={SYNTH_X} y={VIEW_H / 2 + 9} style={{ fontSize: 8 }}>
              esize
            </text>
          </g>

          {/* synth → verdict */}
          <path
            className={`edge ${synthToVerdict}`}
            d={`M ${SYNTH_X + 26} ${VIEW_H / 2} L ${VERDICT_X - 26} ${VIEW_H / 2}`}
          />

          {/* verdict */}
          <g>
            <rect
              className={`node-shape ${statusClass(state.verdict.status)}`}
              x={VERDICT_X - 26}
              y={VIEW_H / 2 - 20}
              width={52}
              height={40}
              rx={4}
            />
            {verdictDisplay ? (
              <text
                className={`node-label verdict-label ${verdictDisplay.cls}`}
                x={VERDICT_X}
                y={VIEW_H / 2}
                style={{ fontWeight: 700 }}
              >
                {verdictDisplay.text}
              </text>
            ) : (
              <text className="node-label muted" x={VERDICT_X} y={VIEW_H / 2}>
                verdict
              </text>
            )}
          </g>
        </svg>
      )}
      {events.length > 0 && (
        <div className="spend-line" data-testid="flow-spend">
          spent <strong>{fmtUsd(state.spentUsdc)}</strong>
          {state.estimatedUsdc > 0 && (
            <> / est {fmtUsd(state.estimatedUsdc)}</>
          )}
        </div>
      )}
    </div>
  );
}
