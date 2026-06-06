import type { Verdict } from "../agent/verdict.ts";

export interface WalletFixture {
  address: string;
  label: string;
  chain: "eth";
  expected: Verdict;
}

// Canonical regression cases. Source of truth: docs/real-wallet-tests/report_v8.md
// (latest baseline, 9/9 strict match). Anchors E2E route suites + future regression tests.
export const WALLET_FIXTURES: WalletFixture[] = [
  {
    address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    label: "Vitalik (vitalik.eth)",
    chain: "eth",
    expected: "safe_to_transact",
  },
  {
    address: "0xf977814e90da44bfa03b6295a0616a897441acec",
    label: "Binance Hot Wallet 20",
    chain: "eth",
    expected: "safe_to_transact",
  },
  {
    address: "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3",
    label: "Coinbase 1 hot wallet",
    chain: "eth",
    expected: "safe_to_transact",
  },
  {
    address: "0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2",
    label: "Kraken 4 hot wallet",
    chain: "eth",
    expected: "safe_to_transact",
  },
  {
    address: "0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5",
    label: "Nick Johnson (nick.eth)",
    chain: "eth",
    expected: "safe_to_transact",
  },
  {
    address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96",
    label: "Lazarus Group (Ronin bridge hack)",
    chain: "eth",
    expected: "do_not_transact",
  },
  {
    address: "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
    label: "Tornado Cash router contract",
    chain: "eth",
    expected: "do_not_transact",
  },
  {
    address: "0x7F367cC41522cE07553e823bf3be79A889DEbe1B",
    label: "OFAC SDN Tornado Cash deposit",
    chain: "eth",
    expected: "do_not_transact",
  },
  {
    address: "0xAaBbCcDdEeFf00112233445566778899AaBbCcDd",
    label: "Synthetic fresh wallet (no history)",
    chain: "eth",
    expected: "insufficient_data",
  },
];
