#!/usr/bin/env ts-node
/**
 * Step 5: Execute Swap to Target Prices
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { TagTheChartProgram as TagTheChart } from "../target/types/tag_the_chart_program";
import {
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  Commitment,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fetchPoolAccounts } from "../tests/utils/pool-helper";
import * as dotenv from "dotenv";

dotenv.config();

// Pool address
const POOL_ADDRESS = new PublicKey(
  "RApKMv1ZXGcobQXjiAxs8CmDBvBpe6U2SGKuhrwkHXd"
);

// Raydium CLMM program ID
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
  "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH"
);
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

const commitment: Commitment = "processed";

const RPC_URL = "https://api.devnet.solana.com";
async function main() {
  const sk = process.env.TOKEN_HOLDER_SECRET_KEY;
  if (!sk) throw new Error("SecretKey not set");

  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(sk)));
  const cnn = new anchor.web3.Connection(RPC_URL, commitment);
  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(cnn, wallet, { commitment });

  anchor.setProvider(provider);

  const program = anchor.workspace.TagTheChartProgram as Program<TagTheChart>;

  const pool = await fetchPoolAccounts(POOL_ADDRESS);
  console.log("SqrtPriceX64:", pool.currentSqrtPrice.toString());

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("trading_account"), signer.publicKey.toBuffer()],
    program.programId
  );
  const { tokenMintA, tokenMintB } = pool;
  const [pdaAtaA, pdaAtaB] = [tokenMintA, tokenMintB].map((t) =>
    getAssociatedTokenAddressSync(t, pda, true)
  );

  const currentPrice = new BN(pool.currentSqrtPrice.toString());

  // OHLC Candle Pattern (bullish candle, all above current to stay in tick arrays):
  // Open = current price (no swap needed)
  // High = +0.03% (swap up to high)
  // Low = +0.01% (swap back down but still above open)
  // Close = +0.02% (swap up to close between low and high)
  const targetPrices = [
    currentPrice.muln(10003).divn(10000), // High: +0.03%
    currentPrice.muln(10001).divn(10000), // Low: +0.01%
    currentPrice.muln(10002).divn(10000), // Close: +0.02%
  ];

  console.log("\n📊 OHLC Candle (bullish):");
  console.log("  Open (current):", currentPrice.toString());
  console.log("  High (+0.03%):", targetPrices[0].toString());
  console.log("  Low (+0.01%):", targetPrices[1].toString());
  console.log("  Close (+0.02%):", targetPrices[2].toString());

  // Determine which is WSOL and which is the other token
  const WSOL_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );
  const isTokenAWsol = pool.tokenMintA.equals(WSOL_MINT);

  const tradingAccountWsol = isTokenAWsol ? pdaAtaA : pdaAtaB;
  const tradingAccountToken = isTokenAWsol ? pdaAtaB : pdaAtaA;

  console.log("\n📝 PDA Token Accounts:");
  console.log("  WSOL:", tradingAccountWsol.toString());
  console.log("  Token:", tradingAccountToken.toString());

  // Execute swap
  console.log("\n⏳ Executing swap...");
  try {
    // No slippage protection (0 = unlimited input, 0 = no min output)
    const maxInputs = [new BN(0), new BN(0), new BN(0)];
    const minOutputs = [new BN(0), new BN(0), new BN(0)];

    const sig = await program.methods
      .swapToPrices(targetPrices, maxInputs, minOutputs)
      .accounts({
        user: signer.publicKey,
        tradingAccount: pda,
        raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
        ammConfig: pool.ammConfig,
        poolState: POOL_ADDRESS,
        tradingAccountToken: tradingAccountToken,
        tradingAccountWsol: tradingAccountWsol,
        tokenVaultA: pool.tokenVaultA,
        tokenVaultB: pool.tokenVaultB,
        tokenMintA: pool.tokenMintA,
        tokenMintB: pool.tokenMintB,
        observationState: pool.observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(
        pool.tickArrays.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        }))
      )
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();

    console.log("📝 Signature:", sig);
    console.log(
      "🌐 Explorer:",
      `https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  } catch (error) {
    console.error("\n❌ Swap failed:", error);
    throw error;
  }

  console.log("\n🎉 Swap completed!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
