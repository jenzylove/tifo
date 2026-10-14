// TifoFloat (contracts/src/TifoFloat.sol), written by hand: only what the naira flow calls or needs to read.
// The errors are listed so viem can name a revert (AlreadyReleased, OverLimit) instead of showing raw data.
export const tifoFloatAbi = [
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: [{ name: "ref", type: "bytes32" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "released", stateMutability: "view", inputs: [{ name: "ref", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "releasedToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "perRelease", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "perDay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Released", inputs: [{ name: "ref", type: "bytes32", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "error", name: "NotReleaser", inputs: [] },
  { type: "error", name: "AlreadyReleased", inputs: [] },
  { type: "error", name: "OverLimit", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
] as const;
