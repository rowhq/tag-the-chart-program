#!/usr/bin/env ts-node
/**
 * Complete end-to-end script to execute OHLC swaps on devnet
 *
 * Usage: ts-node scripts/execute-swap.ts
 *
 * This script:
 * 1. Initializes PDA trading account
 * 2. Creates necessary ATAs
 * 3. Wraps SOL to WSOL
 * 4. Deposits tokens into PDA
 * 5. Executes swap_to_prices
 * 6. Shows results
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { TagTheChartProgram } from "../target/types/tag_the_chart_program";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAccount,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config();

// Constants
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// Pool configuration (WSOL/USDC on devnet)
const POOL_ADDRESS = new PublicKey(
  "RApKMv1ZXGcobQXjiAxs8CmDBvBpe6U2SGKuhrwkHXd"
);
const WSOL_MINT = NATIVE_MINT; // So11111111111111111111111111111111111111112

// Swap configuration
const WSOL_AMOUNT_TO_WRAP = 0.01; // 0.01 SOL
const TOKEN_AMOUNT_TO_DEPOSIT = 100; // Adjust based on your token mint decimals
const SLIPPAGE_BPS = 100; // 1% slippage

async function main() {
  const signer = process.env.TOKEN_HOLDER_SECRET_KEY;
  if (!signer) throw new Error("❌ SIGNER not set in .env");

  const secret = JSON.parse(signer);
  const user = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "processed"
  );
  const wallet = new anchor.Wallet(user);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "processed",
    preflightCommitment: "processed",
    skipPreflight: false,
  });
  anchor.setProvider(provider);

  const program = anchor.workspace
    .TagTheChartProgram as Program<TagTheChartProgram>;

  // 2. Get pool info
  const iPool = await connection.getAccountInfo(POOL_ADDRESS);
  if (!iPool) throw new Error("❌ Pool not found");

  // Deserialize pool state (simplified - just get token mints)
  const poolData = iPool.data;
  const tokenMint0 = new PublicKey(poolData.slice(73, 105)); // offset for token_mint_0
  const tokenMint1 = new PublicKey(poolData.slice(105, 137)); // offset for token_mint_1

  console.log("  Token Mint 0:", tokenMint0.toString());
  console.log("  Token Mint 1:", tokenMint1.toString());

  // Determine which is WSOL and which is the other token
  const isWsolMint0 = tokenMint0.equals(WSOL_MINT);
  const tokenMint = isWsolMint0 ? tokenMint1 : tokenMint0;

  console.log("\n  🪙 WSOL Mint:", WSOL_MINT.toString());
  console.log("  🪙 Token Mint:", tokenMint.toString());

  // 3. Derive PDA
  const [tradingAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("trading_account"), user.publicKey.toBuffer()],
    program.programId
  );
  console.log("\n📝 PDA Trading Account:", tradingAccount.toString());

  // 4. Get ATAs
  const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, user.publicKey);
  const userTokenAta = getAssociatedTokenAddressSync(tokenMint, user.publicKey);
  const pdaWsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    tradingAccount,
    true
  );
  const pdaTokenAta = getAssociatedTokenAddressSync(
    tokenMint,
    tradingAccount,
    true
  );

  console.log("\n💳 ATAs:");
  console.log("  User WSOL ATA:", userWsolAta.toString());
  console.log("  User Token ATA:", userTokenAta.toString());
  console.log("  PDA WSOL ATA:", pdaWsolAta.toString());
  console.log("  PDA Token ATA:", pdaTokenAta.toString());

  // 5. Check if PDA exists
  let pdaExists = false;
  try {
    await program.account.tradingAccount.fetch(tradingAccount);
    pdaExists = true;
    console.log("\n✅ PDA already initialized");
  } catch {
    console.log("\n⏳ Initializing PDA...");
  }

  // 6. Initialize PDA if needed
  if (!pdaExists) {
    try {
      const tx = await program.methods
        .initialize()
        .accounts({
          user: user.publicKey,
          tradingAccount: tradingAccount,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("  ✅ PDA initialized. Signature:", tx);
    } catch (error) {
      console.error("  ❌ Failed to initialize PDA:", error);
      throw error;
    }
  }

  // 7. Create user ATAs if needed
  console.log("\n⏳ Checking/creating user ATAs...");
  const setupTx = new Transaction();

  for (const [mint, ata, name] of [
    [WSOL_MINT, userWsolAta, "User WSOL"],
    [tokenMint, userTokenAta, "User Token"],
  ]) {
    try {
      await getAccount(connection, ata);
      console.log(`  ✅ ${name} ATA exists`);
    } catch {
      console.log(`  ⏳ Creating ${name} ATA...`);
      setupTx.add(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          ata,
          user.publicKey,
          mint
        )
      );
    }
  }

  // 8. Wrap SOL
  console.log(`\n⏳ Wrapping ${WSOL_AMOUNT_TO_WRAP} SOL...`);
  setupTx.add(
    SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: userWsolAta,
      lamports: WSOL_AMOUNT_TO_WRAP * LAMPORTS_PER_SOL,
    }),
    createSyncNativeInstruction(userWsolAta)
  );

  if (setupTx.instructions.length > 0) {
    const sig = await provider.sendAndConfirm(setupTx);
    console.log("  ✅ Setup transaction signature:", sig);
  }

  // 9. Check balances
  console.log("\n💰 Checking balances...");
  const userWsolBalance = await connection.getTokenAccountBalance(userWsolAta);
  const userTokenBalance = await connection.getTokenAccountBalance(
    userTokenAta
  );
  console.log("  User WSOL balance:", userWsolBalance.value.uiAmount, "WSOL");
  console.log(
    "  User Token balance:",
    userTokenBalance.value.uiAmount,
    "tokens"
  );

  // 10. Deposit tokens into PDA
  console.log("\n⏳ Depositing tokens into PDA...");

  // Deposit WSOL
  const wsolDepositAmount = new BN(WSOL_AMOUNT_TO_WRAP * LAMPORTS_PER_SOL);
  try {
    const tx = await program.methods
      .deposit(wsolDepositAmount)
      .accounts({
        user: user.publicKey,
        tradingAccount: tradingAccount,
        userTokenAccount: userWsolAta,
        pdaTokenAccount: pdaWsolAta,
        tokenMint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  ✅ WSOL deposited. Signature:", tx);
  } catch (error) {
    console.error("  ❌ Failed to deposit WSOL:", error);
    throw error;
  }

  // Deposit other token (if you have balance)
  if (userTokenBalance.value.uiAmount && userTokenBalance.value.uiAmount > 0) {
    const tokenDepositAmount = new BN(
      TOKEN_AMOUNT_TO_DEPOSIT * Math.pow(10, userTokenBalance.value.decimals)
    );
    try {
      const tx = await program.methods
        .deposit(tokenDepositAmount)
        .accounts({
          user: user.publicKey,
          tradingAccount: tradingAccount,
          userTokenAccount: userTokenAta,
          pdaTokenAccount: pdaTokenAta,
          tokenMint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("  ✅ Token deposited. Signature:", tx);
    } catch (error) {
      console.warn(
        "  ⚠️  Failed to deposit token (may not have balance):",
        error.message
      );
    }
  }

  // 11. Fetch pool accounts for swap
  console.log("\n⏳ Fetching pool accounts...");
  const poolStateAccount = await connection.getAccountInfo(POOL_ADDRESS);
  if (!poolStateAccount) {
    throw new Error("❌ Pool state account not found");
  }

  // Parse pool state to get required accounts (simplified)
  const ammConfigAddress = new PublicKey(poolData.slice(41, 73));
  const tokenVault0 = new PublicKey(poolData.slice(137, 169));
  const tokenVault1 = new PublicKey(poolData.slice(169, 201));
  const observationKey = new PublicKey(poolData.slice(201, 233));

  console.log("  AMM Config:", ammConfigAddress.toString());
  console.log("  Token Vault 0:", tokenVault0.toString());
  console.log("  Token Vault 1:", tokenVault1.toString());
  console.log("  Observation:", observationKey.toString());

  // 12. Execute swap
  console.log("\n⏳ Executing swap to prices...");

  // Example target sqrt prices (you should calculate these based on desired OHLC)
  // These are placeholder values - replace with actual calculated sqrt prices
  const currentPrice = new BN(poolData.slice(253, 269)); // sqrt_price_x64 at offset 253
  console.log("  Current sqrt price (X64):", currentPrice.toString());

  // Create 3 target prices (example: slightly different from current)
  // In production, calculate these based on your OHLC strategy
  const targetPrices = [
    currentPrice.muln(101).divn(100), // +1%
    currentPrice.muln(102).divn(100), // +2%
    currentPrice.muln(100).divn(101), // -1%
  ];

  console.log("  Target sqrt prices:");
  targetPrices.forEach((price, i) =>
    console.log(`    ${i + 1}:`, price.toString())
  );

  try {
    const swapTx = await program.methods
      .swapToPrices(targetPrices, SLIPPAGE_BPS)
      .accounts({
        user: user.publicKey,
        tradingAccount: tradingAccount,
        poolState: POOL_ADDRESS,
        ammConfig: ammConfigAddress,
        inputTokenAccount: pdaWsolAta,
        outputTokenAccount: pdaTokenAta,
        inputVault: tokenVault0,
        outputVault: tokenVault1,
        inputTokenMint: WSOL_MINT,
        outputTokenMint: tokenMint,
        observationState: observationKey,
        ammProgram: RAYDIUM_CLMM_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();

    console.log("\n✅ Swap executed successfully!");
    console.log("  Signature:", swapTx);
    console.log(
      "  Explorer:",
      `https://explorer.solana.com/tx/${swapTx}?cluster=devnet`
    );
  } catch (error) {
    console.error("\n❌ Swap failed:", error);
    throw error;
  }

  // 13. Check final balances
  console.log("\n📊 Final PDA balances:");
  try {
    const pdaWsolBalance = await connection.getTokenAccountBalance(pdaWsolAta);
    const pdaTokenBalance = await connection.getTokenAccountBalance(
      pdaTokenAta
    );
    console.log("  PDA WSOL:", pdaWsolBalance.value.uiAmount, "WSOL");
    console.log("  PDA Token:", pdaTokenBalance.value.uiAmount, "tokens");
  } catch (error) {
    console.warn("  ⚠️  Could not fetch PDA balances");
  }

  console.log("\n🎉 Complete! All operations executed successfully.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n💥 Error:", error);
    process.exit(1);
  });
