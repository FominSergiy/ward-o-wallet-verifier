import { type CategoryNode, type DirectNode, type NodeStatus, useFlowState } from "../hooks/useFlowState";
import type { Category, VerdictLabel, VerifyEvent } from "../types";
import { fmtUsd } from "../utils";
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

// Free chain-primitive sub-nodes hang directly beneath their category box (not
// the payment column), so they read as children of that category. DIRECT_DY is
// the vertical offset from the row baseline Y to the center of the circles —
// large enough to clear the box (y±16) and the group caption above the circles.
const DIRECT_DY = 46;
const DIRECT_R = 7;
const DIRECT_SPACING = 38;

const CATEGORY_LABELS: Record<Category, string> = {
  sanctions: "sanctions",
  labels: "labels",
  onchain_history: "on_chain",
  web_sentiment: "web_sent",
  ens: "ens",
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

function DirectNodes({ direct, y }: { direct: DirectNode[]; y: number }) {
  if (direct.length === 0) return null;
  const total = direct.length;
  const span = (total - 1) * DIRECT_SPACING;
  // Center the fan-out on the category column so it sits squarely under the
  // category box, not floating over by the payment column.
  const startX = CATEGORY_X - span / 2;
  const cy = y + DIRECT_DY;

  // Bounding container — hugs the bottom of the category box above and wraps
  // the caption + circles + chain labels into one grouped widget.
  const padX = DIRECT_R + 10;
  const boxBottom = y + 16; // category rect is y-16 .. y+16
  const containerY = boxBottom + 4;
  const captionY = containerY + 11;
  const labelY = cy + DIRECT_R + 8;
  const containerX = startX - padX;
  const containerW = span + padX * 2;
  const containerH = labelY + 6 - containerY;

  return (
    <g>
      {/* connector from the category box down into the group container */}
      <line
        className="direct-connector"
        x1={CATEGORY_X}
        y1={boxBottom}
        x2={CATEGORY_X}
        y2={containerY}
      />
      <rect
        className="direct-container"
        x={containerX}
        y={containerY}
        width={containerW}
        height={containerH}
        rx={4}
      />
      <text className="direct-caption" x={CATEGORY_X} y={captionY}>
        free sources
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
            <text className="direct-label" x={cx} y={labelY}>
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
  // When fallback exists, the visual flow is primary → fallback → synth (a
  // single chain). Suppress the parallel primary→synth edge so the diagram
  // doesn't show both a red original and a green fallback line into synth.
  let edgePayToSynth = hasX402 && !node.fallback ? edgeClassFor(primaryStatus, synthStatus) : "";
  if (hasX402 && primaryStatus === "error" && !node.fallback) edgePayToSynth = "error";

  // Primary→fallback edge: red when primary failed (the actual story —
  // primary errored, that's why we took the fallback); dashed orange while
  // the fallback attempt is still in flight.
  const edgePayToFallback = node.fallback
    ? primaryStatus === "error"
      ? "error"
      : "fallback"
    : "";
  const edgeFallbackToSynth = node.fallback
    ? fallbackStatus === "ok"
      ? "ok"
      : fallbackStatus === "error"
      ? "error"
      : "lit"
    : "";

  // Direct sub-path edge: color by node.status only. Downstream synth state
  // shouldn't paint an otherwise-successful direct edge red.
  const edgeCatToSynthDirect =
    !hasX402 && node.direct.length > 0
      ? node.status === "ok"
        ? "ok"
        : node.status === "error"
        ? "error"
        : node.status === "active"
        ? "lit"
        : ""
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

          {/* payment → synth (curved into synth center). Skipped entirely
              when a fallback exists — the chained flow primary → fallback →
              synth replaces the parallel edge. */}
          {!node.fallback && (
            <path
              className={`edge ${edgePayToSynth}`}
              d={`M ${PAYMENT_X + 26} ${y} C ${(PAYMENT_X + SYNTH_X) / 2} ${y}, ${
                (PAYMENT_X + SYNTH_X) / 2
              } ${synthIn.y}, ${synthIn.x} ${synthIn.y}`}
            />
          )}
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
