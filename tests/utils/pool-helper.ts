import { Connection, PublicKey } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";

export interface PoolAccounts {
  poolAddress: PublicKey;
  ammConfig: PublicKey;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  observationState: PublicKey;
  currentSqrtPrice: bigint;
  tickArrays: PublicKey[];
}

/**
 * Fetch pool accounts from mainnet using Raydium SDK
 */
export async function fetchPoolAccounts(
  poolAddress: PublicKey
): Promise<PoolAccounts> {
  // Create mainnet connection to fetch pool data
  const mainnetConnection = new Connection(
    "https://api.mainnet-beta.solana.com"
  );

  // Initialize Raydium SDK with mainnet connection
  const raydium = await Raydium.load({
    connection: mainnetConnection,
    cluster: "mainnet",
  });

  // Fetch pool info from mainnet - includes tick arrays in tickData
  const { poolInfo, computePoolInfo, poolKeys, tickData } =
    await raydium.clmm.getPoolInfoFromRpc(poolAddress.toBase58());

  // Extract tick array addresses from tickData
  // tickData structure: { [poolId]: { [tickArrayIndex]: { address, ticks, ... } } }
  const poolTickData = tickData[poolAddress.toBase58()];
  const tickArrayAddresses = Object.values(poolTickData).map(
    (tickArray: any) => new PublicKey(tickArray.address)
  );

  const accounts = {
    poolAddress,
    ammConfig: new PublicKey(poolInfo.config.id),
    tokenMintA: new PublicKey(poolInfo.mintA.address),
    tokenMintB: new PublicKey(poolInfo.mintB.address),
    tokenVaultA: new PublicKey(poolKeys.vault.A),
    tokenVaultB: new PublicKey(poolKeys.vault.B),
    observationState: new PublicKey(computePoolInfo.observationId),
    currentSqrtPrice: BigInt(computePoolInfo.sqrtPriceX64.toString()),
    tickArrays: tickArrayAddresses,
  };

  console.log("\n📦 Pool accounts from mainnet:");
  console.log("  Pool:", accounts.poolAddress.toBase58());
  console.log("  AMM Config:", accounts.ammConfig.toBase58());
  console.log("  Token Mint A:", accounts.tokenMintA.toBase58());
  console.log("  Token Mint B:", accounts.tokenMintB.toBase58());
  console.log("  Token Vault A:", accounts.tokenVaultA.toBase58());
  console.log("  Token Vault B:", accounts.tokenVaultB.toBase58());
  console.log("  Observation State:", accounts.observationState.toBase58());
  console.log("  Current sqrt price:", accounts.currentSqrtPrice.toString());
  console.log(
    "  Tick arrays:",
    accounts.tickArrays.map((a) => a.toBase58()).join(", ")
  );

  return accounts;
}
