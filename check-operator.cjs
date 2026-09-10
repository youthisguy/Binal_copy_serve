const { ethers } = require("ethers");

const candidates = [
  "NotOperator()", "OperatorNotApproved()", "Unauthorized()", "NotApprovedOperator()",
  "InsufficientAllowance()", "ERC6909MissingApproval(address,address)",
  "ERC6909InsufficientAllowance(address,address,uint256,uint256)",
  "ERC6909InsufficientBalance(address,uint256,uint256,uint256)",
  "MarketNotResolved()", "OraclePending()", "AlreadyRedeemed()", "MarketNotFinalized()",
  "NotFinalized()", "InvalidOutcome()", "InsufficientBalance()", "CallerNotOwnerOrOperator()",
  "SettlementNotFinalized()", "ZeroAmount()", "AmountExceedsBalance()",
];

for (const sig of candidates) {
  const selector = ethers.id(sig).slice(0, 10);
  if (selector === "0xdeda9030") console.log("MATCH:", sig);
}
console.log("done");